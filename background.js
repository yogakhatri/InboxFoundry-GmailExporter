importScripts('lib/job-store.js', 'lib/path-safety.js', 'lib/download-policy.js');

const downloadRouting = new Map();
const watchers = new Map();
let currentRoute = null;
const DOWNLOAD_ROOT = 'InboxFoundry';
const jobStore = globalThis.InboxFoundry.jobStore;
const pathSafety = globalThis.InboxFoundry.pathSafety;
const downloadPolicy = globalThis.InboxFoundry.downloadPolicy;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`inboxFoundryActiveJobId:${tabId}`).catch(() => {});
  jobStore.listJobs().then(jobs => Promise.all(jobs
    .filter(job => job.ownerTabId === tabId && ['running','pausing'].includes(job.status))
    .map(job => jobStore.patchJob(job.id, { status:'interrupted', leaseExpiresAt:null, lastError:'The owning Gmail tab was closed.' }))))
    .catch(error => console.error('[InboxFoundry] Could not release closed-tab jobs', error));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'OPEN_SIDE_PANEL') return;
  const tabId = msg.tabId || sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: 'No active Gmail tab was found.' });
    return;
  }
  chrome.sidePanel.open({ tabId })
    .then(() => sendResponse({ ok: true }))
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function handleDatabaseMessage(msg) {
  switch (msg.type) {
    case 'DB_PUT_JOB': return jobStore.putJob(msg.job);
    case 'DB_GET_JOB': return jobStore.getJob(msg.jobId);
    case 'DB_PATCH_JOB': return jobStore.patchJob(msg.jobId, msg.patch || {});
    case 'DB_LIST_JOBS': return jobStore.listJobs();
    case 'DB_PUT_THREAD': return jobStore.putThread(msg.jobId, msg.threadKey, msg.value || {});
    case 'DB_PUT_THREAD_BUNDLE': return jobStore.putThreadBundle(msg.jobId, msg.threadKey, msg.value || {}, msg.messages || [], msg.attachments || []);
    case 'DB_GET_THREADS': return jobStore.getThreads(msg.jobId);
    case 'DB_GET_MESSAGES': return jobStore.getMessages(msg.jobId);
    case 'DB_GET_ATTACHMENTS': return jobStore.getAttachments(msg.jobId);
    case 'DB_PUT_DOWNLOAD': return jobStore.putDownload(msg.value || {});
    case 'DB_GET_DOWNLOADS': return jobStore.getDownloads(msg.jobId);
    case 'DB_ADD_EVENT': return jobStore.addEvent(msg.jobId, msg.eventType, msg.detail || {});
    case 'DB_GET_EVENTS': return jobStore.getEvents(msg.jobId);
    case 'DB_PUT_PRESET': return jobStore.putPreset(msg.preset);
    case 'DB_LIST_PRESETS': return jobStore.listPresets();
    case 'DB_DELETE_PRESET': await jobStore.deletePreset(msg.presetId); return true;
    case 'DB_DELETE_JOB': await jobStore.deleteJob(msg.jobId); return true;
    case 'DB_CLEAR_JOBS': {
      const jobs = await jobStore.listJobs();
      if (jobs.some(job => ['running', 'pausing'].includes(job.status))) throw new Error('Stop every active export before deleting all jobs.');
      await jobStore.clearJobs();
      const stored = await chrome.storage.local.get(null);
      const activeKeys = Object.keys(stored).filter(key => key === 'gmailThreadExporterStateV1' || key === 'tqoGmailRawScraperV23' || key.startsWith('inboxFoundryActiveJobId'));
      if (activeKeys.length) await chrome.storage.local.remove(activeKeys);
      return true;
    }
    case 'DB_CLEAR_PRESETS': await jobStore.clearPresets(); return true;
    case 'DB_STORAGE_ESTIMATE': return navigator.storage?.estimate ? navigator.storage.estimate() : { usage: null, quota: null };
    case 'DB_CLEAR_ALL': await jobStore.clearAll(); return true;
    default: throw new Error(`Unsupported database action: ${msg.type}`);
  }
}

function sanitizePart(value, fallback = 'email') {
  return pathSafety.sanitizePart(value, fallback, 150);
}

function sanitizeFolderPath(folder) {
  return pathSafety.sanitizeFolderPath(folder, 'Email Thread');
}

function routedFilename(rootFolder, folder, fileName) {
  return `${sanitizePart(rootFolder || DOWNLOAD_ROOT, DOWNLOAD_ROOT)}/${sanitizeFolderPath(folder)}/${sanitizePart(fileName, 'attachment')}`;
}

function isAllowedDownloadUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (
      url.hostname === 'mail.google.com' ||
      url.hostname.endsWith('.google.com') ||
      url.hostname === 'googleusercontent.com' ||
      url.hostname.endsWith('.googleusercontent.com')
    );
  } catch (_) {
    return false;
  }
}

function randomToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_EXTENSION_CONTEXT') {
    sendResponse({ ok: true, tabId: _sender.tab?.id || null, windowId: _sender.tab?.windowId || null });
    return;
  }
  if (msg?.type === 'REFRESH_DOWNLOAD_STATES') {
    (async () => {
      const rows = await jobStore.getDownloads(msg.jobId);
      for (const row of rows.filter(item => Number.isInteger(item.downloadId))) {
        const matches = await chrome.downloads.search({ id: row.downloadId });
        const item = matches[0];
        if (!item) { await jobStore.putDownload({ ...row, exists: false, state: row.state === 'complete' ? 'erased' : row.state }); continue; }
        await jobStore.putDownload({ ...row, state:item.state, exists:item.exists, mime:item.mime || null, bytesReceived:item.bytesReceived, totalBytes:item.totalBytes, fileSize:item.fileSize, finalPath:item.filename || row.finalPath, error:item.error || null, endTime:item.endTime || row.endTime });
      }
      sendResponse({ ok:true });
    })().catch(error => sendResponse({ ok:false, error:error?.message || String(error) }));
    return true;
  }
  if (msg?.type === 'RETRY_INTERRUPTED_DOWNLOADS') {
    (async () => {
      const rows = await jobStore.getDownloads(msg.jobId);
      let resumed = 0;
      let notResumable = 0;
      const errors = [];
      const candidates = downloadPolicy.retryCandidates(rows, msg.taskIds);
      for (const row of candidates) {
        const item = (await chrome.downloads.search({ id:row.downloadId }))[0];
        if (!item) {
          await jobStore.putDownload({ ...row, exists:false, error:row.error || 'Chrome no longer has this download.' });
          notResumable++;
          continue;
        }
        if (item.state !== 'interrupted') {
          await jobStore.putDownload({ ...row, state:item.state, exists:item.exists, error:item.error || null, finalPath:item.filename || row.finalPath });
          notResumable++;
          continue;
        }
        if (!item.canResume) { notResumable++; continue; }
        try {
          await chrome.downloads.resume(row.downloadId);
          await jobStore.putDownload({ ...row, state:'in_progress', error:null, resumedAt:new Date().toISOString() });
          resumed++;
        } catch (error) {
          errors.push({ taskId:row.id, error:error?.message || String(error) });
        }
      }
      sendResponse({ ok:true, requested:candidates.length, resumed, notResumable, errors });
    })().catch(error => sendResponse({ ok:false, error:error?.message || String(error) }));
    return true;
  }
  if (msg?.type?.startsWith('DB_')) {
    handleDatabaseMessage(msg)
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (msg?.type === 'PREPARE_CLICK_DOWNLOAD') {
    const token = randomToken();
    currentRoute = {
      token,
      folder: sanitizeFolderPath(msg.folder || 'Email Thread'),
      rootFolder: sanitizePart(msg.rootFolder || DOWNLOAD_ROOT, DOWNLOAD_ROOT),
      expectedFileName: sanitizePart(msg.fileName || 'attachment'),
      jobId: msg.jobId || null,
      taskId: msg.taskId || null,
      createdAt: Date.now(),
      expiresAt: Date.now() + Math.max(4000, Number(msg.ttlMs) || 9000)
    };
    watchers.set(token, { created: false, downloadId: null, fileName: null, expiresAt: currentRoute.expiresAt });
    sendResponse({ ok: true, token });
    return;
  }

  if (msg?.type === 'CHECK_CLICK_DOWNLOAD') {
    const w = watchers.get(msg.token);
    if (!w) {
      sendResponse({ ok: true, created: false });
      return;
    }
    sendResponse({ ok: true, created: !!w.created, persisted: w.persisted !== false, persistenceError: w.persistenceError, downloadId: w.downloadId, fileName: w.fileName });
    if (w.created || Date.now() > w.expiresAt) watchers.delete(msg.token);
    return;
  }

  if (msg?.type === 'CLEAR_DOWNLOAD_ROUTE') {
    currentRoute = null;
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === 'DIRECT_DOWNLOAD') {
    const url = String(msg.url || '');
    if (!isAllowedDownloadUrl(url)) {
      sendResponse({ ok: false, error: 'Invalid attachment URL' });
      return;
    }
    chrome.downloads.download({
      url,
      filename: routedFilename(msg.rootFolder, msg.folder, msg.fileName),
      conflictAction: 'uniquify',
      saveAs: false
    }, async (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err || !downloadId) { sendResponse({ ok: false, error: err?.message || 'Download did not start' }); return; }
      try {
        await jobStore.putDownload({
          id: msg.taskId || `download-${downloadId}`,
          jobId: msg.jobId || null,
          downloadId,
          fileName: sanitizePart(msg.fileName || 'attachment'),
          folder: sanitizeFolderPath(msg.folder || 'Email Thread'),
          rootFolder: sanitizePart(msg.rootFolder || DOWNLOAD_ROOT, DOWNLOAD_ROOT),
          state: 'in_progress',
          method: 'direct',
          startedAt: new Date().toISOString()
        });
        sendResponse({ ok: true, downloadId });
      } catch (error) {
        console.error('[InboxFoundry] Could not persist download', error);
        sendResponse({ ok: false, downloadStarted: true, downloadId, error: 'The file started downloading but its durable task checkpoint failed.' });
      }
    });
    return true;
  }
});

chrome.downloads.onCreated.addListener((item) => {
  if (!currentRoute || Date.now() > currentRoute.expiresAt) return;
  if (![item.url, item.finalUrl, item.referrer].some(isAllowedDownloadUrl)) return;

  const route = currentRoute;
  currentRoute = null;

  downloadRouting.set(item.id, {
    folder: route.folder,
    rootFolder: route.rootFolder,
    expectedFileName: route.expectedFileName,
    jobId: route.jobId,
    taskId: route.taskId
  });

  jobStore.putDownload({
    id: route.taskId || `download-${item.id}`,
    jobId: route.jobId,
    downloadId: item.id,
    fileName: route.expectedFileName,
    folder: route.folder,
    rootFolder: route.rootFolder,
    state: 'in_progress',
    method: 'click',
    mime: item.mime || null,
    bytesReceived: item.bytesReceived || 0,
    totalBytes: item.totalBytes || null,
    fileSize: item.fileSize || null,
    exists: item.exists !== false,
    startedAt: new Date().toISOString()
  }).then(() => {
    const w = watchers.get(route.token);
    if (w) watchers.set(route.token, { ...w, created:true, persisted:true, downloadId:item.id, fileName:route.expectedFileName || (item.filename || '').split(/[\\/]/).pop() || null });
  }).catch(error => {
    console.error('[InboxFoundry] Could not persist click download', error);
    const w = watchers.get(route.token);
    if (w) watchers.set(route.token, { ...w, created:true, persisted:false, persistenceError:'The file started downloading but its durable task checkpoint failed.', downloadId:item.id });
  });
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const route = downloadRouting.get(item.id);
  if (route) {
    downloadRouting.delete(item.id);
    const original = String(item.filename || '').split(/[\\/]/).pop();
    const baseName = original || route.expectedFileName || `attachment-${item.id}`;
    suggest({ filename: routedFilename(route.rootFolder, route.folder, baseName), conflictAction: 'uniquify' });
    return true;
  }
  jobStore.getDownloadByChromeId(item.id).then(saved => {
    if (!saved?.folder) { suggest(); return; }
    const original = String(item.filename || '').split(/[\\/]/).pop();
    suggest({ filename:routedFilename(saved.rootFolder, saved.folder, original || saved.fileName), conflictAction:'uniquify' });
  }).catch(() => suggest());
  return true;
});

chrome.downloads.onErased.addListener((id) => {
  downloadRouting.delete(id);
  jobStore.patchDownloadByChromeId(id, { state: 'erased', finishedAt: new Date().toISOString() })
    .catch(error => console.error('[InboxFoundry] Could not mark erased download', error));
});

chrome.downloads.onChanged.addListener((delta) => {
  const patch = {};
  if (delta.state?.current) patch.state = delta.state.current;
  if (delta.error?.current) patch.error = delta.error.current;
  if (delta.filename?.current) patch.finalPath = delta.filename.current;
  if (delta.mime?.current) patch.mime = delta.mime.current;
  if (delta.bytesReceived?.current != null) patch.bytesReceived = delta.bytesReceived.current;
  if (delta.totalBytes?.current != null) patch.totalBytes = delta.totalBytes.current;
  if (delta.fileSize?.current != null) patch.fileSize = delta.fileSize.current;
  if (delta.exists?.current != null) patch.exists = delta.exists.current;
  if (delta.endTime?.current) patch.endTime = delta.endTime.current;
  if (patch.state === 'complete' || patch.state === 'interrupted') patch.finishedAt = new Date().toISOString();
  if (!Object.keys(patch).length) return;
  jobStore.patchDownloadByChromeId(delta.id, patch)
    .catch(error => console.error('[InboxFoundry] Could not update download state', error));
});

setInterval(() => {
  const now = Date.now();
  for (const [token, watcher] of watchers.entries()) {
    if (now > watcher.expiresAt + 15000) watchers.delete(token);
  }
  if (currentRoute && now > currentRoute.expiresAt) currentRoute = null;
}, 30000);
