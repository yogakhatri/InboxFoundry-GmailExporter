// Service worker: storage for the Gmail tab's script, and Chrome download management.
importScripts('lib/job-store.js', 'lib/path-safety.js', 'lib/gmail-adapter.js');

const { jobStore, pathSafety, gmailAdapter } = globalThis.InboxFoundry;
const ACTIVE_STATES = ['running', 'pausing', 'downloading'];
const MAX_SLEEP_MS = 10000;

function enableActionPanel() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enableActionPanel);
chrome.runtime.onStartup.addListener(enableActionPanel);

chrome.tabs.onRemoved.addListener(tabId => {
  jobStore.listJobs()
    .then(jobs => Promise.all(jobs
      .filter(job => job.ownerTabId === tabId && ACTIVE_STATES.includes(job.status))
      .map(job => jobStore.patchJob(job.id, {
        status: 'interrupted',
        leaseExpiresAt: null,
        lastError: 'The Gmail tab was closed.'
      }))))
    .catch(error => console.error('[InboxFoundry] Could not release a closed tab', error));
});

// ---- Click-route tracking, only for the rare attachment with no direct URL ----
// The filename listener exists only while a route is open, so it never touches the user's other downloads.

let route = null;
const watchers = new Map();
const pendingNames = new Map();

function isGmailDownload(item) {
  if (item.byExtensionId) return false;
  return [item.url, item.finalUrl, item.referrer].some(gmailAdapter.isAllowedDownloadUrl);
}

function onRouteCreated(item) {
  if (!route || Date.now() > route.expiresAt || !isGmailDownload(item)) return;
  const current = route;
  route = null;
  pendingNames.set(item.id, current.attachment);
  jobStore.patchAttachment(current.attachment.id, {
    state: 'in_progress',
    method: 'click',
    downloadId: item.id,
    error: null,
    startedAt: new Date().toISOString()
  }).then(() => watchers.set(current.token, { created: true }))
    .catch(error => {
      console.error('[InboxFoundry] Could not record a download', error);
      watchers.set(current.token, { created: true });
    });
}

function onRouteFilename(item, suggest) {
  const attachment = pendingNames.get(item.id);
  if (!attachment) {
    suggest();
    return;
  }
  pendingNames.delete(item.id);
  const base = String(item.filename ?? '').split(/[\\/]/).pop() || attachment.fileName;
  suggest({ filename: pathSafety.relativeDownloadPath(attachment.rootFolder, attachment.folder, base), conflictAction: 'uniquify' });
}

function openRoute(attachment, ttlMs) {
  const token = crypto.randomUUID();
  route = { token, attachment, expiresAt: Date.now() + Math.max(4000, Number(ttlMs) || 9000) };
  if (!chrome.downloads.onCreated.hasListener(onRouteCreated)) chrome.downloads.onCreated.addListener(onRouteCreated);
  if (!chrome.downloads.onDeterminingFilename.hasListener(onRouteFilename)) chrome.downloads.onDeterminingFilename.addListener(onRouteFilename);
  return token;
}

function closeRoute() {
  route = null;
  // Leave a moment for a filename decision already in flight.
  setTimeout(() => {
    if (route) return;
    chrome.downloads.onCreated.removeListener(onRouteCreated);
    chrome.downloads.onDeterminingFilename.removeListener(onRouteFilename);
    pendingNames.clear();
  }, 3000);
}

// ---- Direct downloads ----

function download(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, id => {
      const error = chrome.runtime.lastError;
      if (error || !id) reject(new Error(error?.message || 'Chrome did not start the download.'));
      else resolve(id);
    });
  });
}

async function startDirectDownload(attachmentId) {
  const attachment = await jobStore.getAttachment(attachmentId);
  if (!attachment) return { ok: false, error: 'This file is no longer in the batch.' };
  if (!gmailAdapter.isAllowedDownloadUrl(attachment.url)) return { ok: false, needsClick: true };
  const base = { url: attachment.url, conflictAction: 'uniquify', saveAs: false };
  const filename = pathSafety.relativeDownloadPath(attachment.rootFolder, attachment.folder, attachment.fileName);
  let id;
  try {
    id = await download({ ...base, filename });
  } catch (error) {
    if (!/filename/i.test(error.message)) return { ok: false, error: error.message };
    // A name Chrome refuses must not lose the file: save it under a plain name, keeping the extension.
    const extension = String(attachment.fileName).match(/\.[A-Za-z0-9]{1,10}$/)?.[0] || '';
    const safeName = `attachment-${attachment.messageIndex}-${attachment.ordinal}${extension}`;
    try {
      id = await download({ ...base, filename: pathSafety.relativeDownloadPath(attachment.rootFolder, attachment.folder.split('/')[0], safeName) });
    } catch (retryError) {
      return { ok: false, error: retryError.message };
    }
  }
  await jobStore.patchAttachment(attachmentId, {
    state: 'in_progress',
    method: 'direct',
    downloadId: id,
    error: null,
    startedAt: new Date().toISOString()
  });
  return { ok: true, downloadId: id };
}

chrome.downloads.onChanged.addListener(delta => {
  const patch = {};
  if (delta.state?.current) patch.state = delta.state.current;
  if (delta.error?.current) patch.error = delta.error.current;
  if (delta.filename?.current) patch.finalPath = delta.filename.current;
  if (delta.fileSize?.current != null) patch.fileSize = delta.fileSize.current;
  if (patch.state === 'complete' || patch.state === 'interrupted') patch.finishedAt = new Date().toISOString();
  if (!Object.keys(patch).length) return;
  jobStore.patchByChromeId(delta.id, patch).catch(error => console.error('[InboxFoundry] Could not update a download', error));
});

chrome.downloads.onErased.addListener(id => {
  jobStore.patchByChromeId(id, { state: 'erased', finishedAt: new Date().toISOString() })
    .catch(error => console.error('[InboxFoundry] Could not mark an erased download', error));
});

// ---- Messages ----
// Only what the Gmail tab's scan needs. Destructive storage actions happen in the side panel, never from Gmail's process.

const handlers = {
  GET_CONTEXT: (_message, sender) => ({ tabId: sender.tab?.id ?? null }),
  SLEEP: message => new Promise(resolve => setTimeout(() => resolve(true), Math.min(MAX_SLEEP_MS, Math.max(0, Number(message.ms) || 0)))),
  PUT_JOB: message => jobStore.putJob(message.job).then(() => true),
  GET_JOB: message => jobStore.getJob(message.jobId),
  PATCH_JOB: message => jobStore.patchJob(message.jobId, message.patch).then(() => true),
  LIST_JOBS: () => jobStore.listJobs(),
  PUT_THREAD_BUNDLE: message => jobStore.putThreadBundle(message.bundle),
  THREAD_PAGE: message => jobStore.threadPage(message.jobId, message.afterSeq, message.limit),
  PENDING_ATTACHMENTS: message => jobStore.pendingAttachments(message.jobId, message.limit),
  PATCH_ATTACHMENT: message => jobStore.patchAttachment(message.id, message.patch).then(() => true),
  COUNT_IN_PROGRESS: message => jobStore.countInProgress(message.jobId),
  ADD_EVENT: message => jobStore.addEvent(message.jobId, message.eventType, message.detail).then(() => true),
  LEDGER_FOR_SCOPE: message => jobStore.ledgerForScope(message.scope),
  START_DIRECT_DOWNLOAD: message => startDirectDownload(message.attachmentId),
  PREPARE_CLICK_DOWNLOAD: async message => {
    const attachment = await jobStore.getAttachment(message.attachmentId);
    if (!attachment) throw new Error('This file is no longer in the batch.');
    const token = openRoute(attachment, message.ttlMs);
    return { token };
  },
  CHECK_CLICK_DOWNLOAD: message => {
    const watcher = watchers.get(message.token);
    if (watcher?.created) watchers.delete(message.token);
    return { created: !!watcher?.created };
  },
  CLEAR_DOWNLOAD_ROUTE: () => {
    closeRoute();
    return true;
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(result => {
      // Direct downloads report their own success or failure shape.
      if (message.type === 'START_DIRECT_DOWNLOAD') sendResponse({ result });
      else sendResponse({ ok: true, result: result ?? null });
    })
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
