// The side panel: the only user interface. It reads storage directly and asks the Gmail tab's script to act.
const { schema, jobMachine, gmailQuery, attachmentAnalysis, jobStore: store, exportEngine, exporter, pathSafety } = globalThis.InboxFoundry;

const CONSENT_KEY = 'inboxFoundryPrivacyAcknowledgedV1';
const CURRENT_JOB_KEY = 'inboxFoundryCurrentJobId';
const FORM_KEY = 'inboxFoundryForm';
const LARGE_SCAN_WARNING = 200;
const SECONDS_PER_THREAD = 3;
const CONTENT_FILES = [
  'lib/product-schema.js', 'lib/job-machine.js', 'lib/path-safety.js', 'lib/gmail-date.js',
  'lib/gmail-adapter.js', 'lib/filter-engine.js', 'content.js'
];
const FORM_FIELD_IDS = [
  'scopeMode', 'fFrom', 'fTo', 'fSubject', 'fKeywords', 'fAfter', 'fBefore', 'fLabel', 'fFilename', 'fFileType',
  'customQuery', 'largerMb', 'smallerMb', 'inAnywhere', 'incremental', 'includeTerms', 'excludeTerms', 'includeMode',
  'matchType', 'wholeWord', 'caseSensitive', 'threadMode', 'ruleScope', 'filenameExclude', 'customExtensions', 'minMb',
  'maxMb', 'excludeClutter', 'rootFolder', 'folderTemplate', 'contentMode', 'includeRawHtml', 'includeGmailUrls',
  'includeInternalIds', 'redactAddresses', 'pacingMs', 'maxThreads', 'maxInspected'
];
const STATE_LABELS = {
  draft: 'Preparing', running: 'Scanning', pausing: 'Stopping', stopped: 'Stopped', ready: 'Ready to review',
  downloading: 'Saving files', failed: 'Needs attention', interrupted: 'Interrupted'
};
const FILE_STATE_LABELS = {
  discovered: 'not saved yet', skipped: 'not requested', unavailable: 'cannot download', pending: 'queued', in_progress: 'saving',
  complete: 'saved', interrupted: 'interrupted', failed: 'failed', erased: 'removed from Chrome'
};

const $ = id => document.getElementById(id);
let consented = false;
let currentJob = null;
let shownJobKey = '';
let missedPings = 0;
let formatsTouched = false;
let lastStage = '';
let threadCursor = -1;
let fileCursor = -1;
let exporting = false;
let pendingPassphrase = '';

// ---- Messages: stay on screen until dismissed or replaced, so an error can't vanish unread ----

function notice(message, kind = 'error') {
  $('noticeText').textContent = message || '';
  $('notice').hidden = !message;
  $('notice').classList.toggle('info', kind === 'info');
}

function guarded(handler) {
  return async event => {
    try {
      await handler(event);
    } catch (error) {
      notice(friendlyError(error));
    }
  };
}

function friendlyError(error) {
  const text = error?.message || String(error);
  if (/quota|QuotaExceeded/i.test(text)) return 'Your disk or browser storage is full. Free some space or delete old batches, then resume.';
  return text;
}

// ---- Talking to Gmail ----

async function activeGmailTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id && tab.url?.startsWith('https://mail.google.com/') ? tab : null;
}

async function requireGmailTab() {
  const tab = await activeGmailTab();
  if (!tab) throw new Error('Open Gmail in this window first, then try again.');
  return tab;
}

function askTab(tabId, type, extra = {}) {
  return chrome.tabs.sendMessage(tabId, { type, ...extra });
}

/** Loads the Gmail script only when it's needed, so InboxFoundry does nothing in Gmail until asked. */
async function ensureInjected(tabId) {
  try {
    if ((await askTab(tabId, 'PING'))?.alive) return;
  } catch {
    // Not there yet: inject below.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
}

async function command(type, extra = {}, tabId = null) {
  const id = tabId ?? (await requireGmailTab()).id;
  await ensureInjected(id);
  const response = await askTab(id, type, extra);
  if (!response?.ok) throw new Error(response?.error || 'Gmail did not respond. Reload the Gmail tab and try again.');
  return response;
}

// ---- The form ----

const selectedIntent = () => document.querySelector('input[name="intent"]:checked')?.value || 'attachments';
const checkedValues = id => [...$(id).querySelectorAll('input:checked')].map(input => input.value);
const megabytes = id => {
  const value = Number($(id).value);
  return $(id).value !== '' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1048576) : null;
};

function usesSearchFields() {
  return ['current-view', 'current-page'].includes($('scopeMode').value);
}

function buildQuery() {
  if (!usesSearchFields()) return '';
  const intent = selectedIntent();
  const fileTerms = schema.parseTerms($('fFilename').value);
  return gmailQuery.build({
    raw: $('customQuery').value,
    keywords: $('fKeywords').value,
    from: $('fFrom').value,
    to: $('fTo').value,
    subject: $('fSubject').value,
    label: $('fLabel').value,
    filename: intent !== 'emails' && fileTerms.length === 1 ? fileTerms[0] : '',
    after: $('fAfter').value,
    before: $('fBefore').value,
    largerMb: $('largerMb').value,
    smallerMb: $('smallerMb').value,
    hasAttachment: intent === 'attachments',
    inAnywhere: $('inAnywhere').checked
  });
}

function readConfig() {
  const intent = selectedIntent();
  const fileType = $('fFileType').value;
  const filenameInclude = intent === 'emails' ? [] : schema.parseTerms($('fFilename').value);
  const filenameExclude = schema.parseTerms($('filenameExclude').value);
  const customExtensions = schema.parseTerms($('customExtensions').value);
  const minBytes = megabytes('minMb');
  const maxBytes = megabytes('maxMb');
  const hasFileRules = fileType !== 'all' || filenameInclude.length || filenameExclude.length || customExtensions.length || minBytes != null || maxBytes != null;
  const typeGroups = fileType === 'all' ? ['all'] : [fileType];
  return schema.normalizeConfig({
    source: {
      mode: $('scopeMode').value,
      gmailQuery: buildQuery(),
      incremental: $('incremental').checked,
      pacingMs: Number($('pacingMs').value),
      maxMatchedThreads: $('maxThreads').value,
      maxInspectedThreads: $('maxInspected').value
    },
    email: {
      includeTerms: schema.parseTerms($('includeTerms').value),
      excludeTerms: schema.parseTerms($('excludeTerms').value),
      includeMode: $('includeMode').value,
      matchType: $('matchType').value,
      wholeWord: $('wholeWord').checked,
      caseSensitive: $('caseSensitive').checked,
      fields: checkedValues('fields'),
      threadMode: $('threadMode').value,
      ruleScope: $('ruleScope').value,
      // Gmail searches whole conversations, so a date range only trims messages locally in this mode.
      dateFrom: $('threadMode').value === 'matching-messages' ? $('fAfter').value : '',
      dateTo: $('threadMode').value === 'matching-messages' ? $('fBefore').value : '',
      requireMatchingAttachment: intent === 'attachments' && !!hasFileRules
    },
    attachments: {
      action: intent === 'emails' ? 'none' : hasFileRules ? 'matching' : 'all',
      typeGroups,
      customExtensions,
      filenameInclude,
      filenameExclude,
      excludeClutter: $('excludeClutter').checked,
      minBytes,
      maxBytes
    },
    destination: { rootFolder: $('rootFolder').value.trim() || 'InboxFoundry' },
    output: {
      formats: checkedValues('formats'),
      contentMode: $('contentMode').value,
      includeRawHtml: $('includeRawHtml').checked,
      includeGmailUrls: $('includeGmailUrls').checked,
      includeInternalIds: $('includeInternalIds').checked,
      redactAddresses: $('redactAddresses').checked,
      folderTemplate: $('folderTemplate').value.trim() || '{index} - {subject}'
    }
  });
}

function validatedConfig() {
  const config = readConfig();
  const { email, attachments } = config;
  if (!email.fields.length && (email.includeTerms.length || email.excludeTerms.length)) throw new Error('Tick at least one place to look for your terms.');
  if ($('fAfter').value && $('fBefore').value && $('fAfter').value > $('fBefore').value) throw new Error('The "From date" is after the "To date".');
  if (attachments.minBytes != null && attachments.maxBytes != null && attachments.minBytes > attachments.maxBytes) throw new Error('The minimum file size is larger than the maximum.');
  return config;
}

function readForm() {
  const form = { intent: selectedIntent(), fields: checkedValues('fields') };
  for (const id of FORM_FIELD_IDS) {
    const element = $(id);
    form[id] = element.type === 'checkbox' ? element.checked : element.value;
  }
  return form;
}

function writeForm(form) {
  if (!form) return;
  for (const id of FORM_FIELD_IDS) {
    const element = $(id);
    if (form[id] === undefined) continue;
    if (element.type === 'checkbox') element.checked = !!form[id];
    else element.value = form[id];
  }
  const intent = document.querySelector(`input[name="intent"][value="${form.intent}"]`);
  if (intent) intent.checked = true;
  if (Array.isArray(form.fields)) {
    for (const input of $('fields').querySelectorAll('input')) input.checked = form.fields.includes(input.value);
  }
}

function refreshFormHints() {
  const query = buildQuery();
  const scope = $('scopeMode').value;
  $('searchFields').hidden = !usesSearchFields();
  $('fileFields').hidden = selectedIntent() === 'emails';
  if (!usesSearchFields()) {
    $('queryLabelText').textContent = 'Will scan';
    $('queryPreview').textContent = scope === 'selected' ? 'the conversations you ticked in Gmail' : 'the conversation you have open';
  } else if (query) {
    $('queryLabelText').textContent = 'Gmail search';
    $('queryPreview').textContent = query;
  } else {
    $('queryLabelText').textContent = 'Will scan';
    $('queryPreview').textContent = 'whatever Gmail is showing now';
  }
  chrome.storage.local.set({ [FORM_KEY]: readForm() }).catch(() => {});
}

function applyIntentDefaults() {
  if (formatsTouched) return;
  const defaults = selectedIntent() === 'attachments' ? ['manifest'] : ['archive'];
  for (const input of $('formats').querySelectorAll('input')) input.checked = defaults.includes(input.value);
}

// ---- Job display ----

function formatBytes(value) {
  const size = Number(value);
  if (value == null || !Number.isFinite(size)) return 'size unknown';
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

function makeRow({ checked, onToggle, name, meta, badge, problem }) {
  const row = document.createElement('label');
  row.className = 'file-row';
  if (onToggle) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', guarded(() => onToggle(input.checked)));
    row.append(input);
  } else {
    row.append(document.createElement('span'));
  }
  const main = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'file-name';
  title.textContent = name || '(No name)';
  const detail = document.createElement('span');
  detail.className = 'file-meta';
  detail.textContent = meta || '';
  main.append(title, detail);
  const state = document.createElement('span');
  state.className = `state${problem ? ' problem' : ''}`;
  state.textContent = badge || '';
  row.append(main, state);
  return row;
}

function threadRow(thread) {
  const when = thread.date ? thread.date.slice(0, 10) : 'date unknown';
  const notes = [
    `${thread.messageCount || 0} message(s)`,
    `${thread.attachmentCount || 0} file(s)`,
    when,
    thread.wasUnread ? 'was unread' : '',
    (thread.warnings || []).length ? 'may be incomplete' : ''
  ].filter(Boolean).join(' · ');
  return makeRow({
    checked: !thread.excluded,
    name: thread.subject || '(No subject)',
    meta: `${thread.from || ''} · ${notes}`,
    badge: (thread.warnings || []).length ? 'check' : '',
    problem: (thread.warnings || []).length > 0,
    onToggle: value => store.patchThread(thread.id, { excluded: !value })
  });
}

function fileRow(file) {
  const canChoose = ['discovered', 'pending'].includes(file.state);
  const problem = ['failed', 'interrupted', 'erased', 'unavailable'].includes(file.state);
  let badge = FILE_STATE_LABELS[file.state] || file.state;
  if (file.driveLink) badge = 'Drive link';
  const why = (file.reasons || []).filter(reason => reason !== 'attachment-rules').join(', ');
  const meta = [formatBytes(file.sizeBytes), file.subject, why && `rule: ${why}`, file.error].filter(Boolean).join(' · ');
  return makeRow({
    checked: file.selected,
    name: file.fileName,
    meta,
    badge,
    problem,
    onToggle: canChoose ? value => store.patchAttachment(file.id, { selected: value }) : null
  });
}

async function appendThreads() {
  const rows = await store.matchedThreadPage(currentJob.id, threadCursor, store.PAGE_SIZE);
  for (const thread of rows) $('threadList').append(threadRow(thread));
  if (rows.length) threadCursor = rows.at(-1).seq;
  $('threadsMore').hidden = rows.length < store.PAGE_SIZE;
}

async function appendFiles() {
  const rows = await store.attachmentPage(currentJob.id, fileCursor, store.PAGE_SIZE);
  for (const file of rows) $('fileList').append(fileRow(file));
  if (rows.length) fileCursor = rows.at(-1).seq;
  $('filesMore').hidden = rows.length < store.PAGE_SIZE;
}

async function renderFailed() {
  $('failedList').replaceChildren();
  let count = 0;
  for await (const thread of store.iterateThreads(currentJob.id)) {
    if (thread.outcome !== 'failed') continue;
    count++;
    if (count <= 50) $('failedList').append(makeRow({ name: `Conversation ${thread.seq + 1}`, meta: thread.error, badge: `tried ${thread.attempts || 1}x`, problem: true }));
  }
  $('failedPanel').hidden = !count;
  $('failedCount').textContent = String(count);
}

async function renderReviewLists() {
  threadCursor = -1;
  fileCursor = -1;
  $('threadList').replaceChildren();
  $('fileList').replaceChildren();
  await Promise.all([appendThreads(), appendFiles(), renderFailed()]);
  $('threadsCount').textContent = String(currentJob.counters.matched);
}

function renderWarnings(job, counts) {
  const items = [];
  for (const reason of exporter.partialReasons(job)) {
    if (reason !== 'stopped' || job.status === 'stopped') items.push(exporter.REASON_TEXT[reason] || reason);
  }
  if (job.counters.unread > 0) items.push(`${job.counters.unread} conversation(s) were unread and are now marked as read in Gmail.`);
  if (counts?.unavailable) items.push(`${counts.unavailable} file(s) can't be downloaded here, such as Google Drive links. They are listed in the file list.`);
  if (job.lastError) items.push(job.lastError);
  $('warnings').replaceChildren(...items.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  $('warnings').hidden = !items.length;
}

async function renderJob() {
  const job = currentJob;
  const active = jobMachine.isActive(job);
  const counters = job?.counters;
  $('jobState').textContent = job ? STATE_LABELS[job.status] || job.status : 'Idle';
  $('inspected').textContent = counters?.inspected ?? 0;
  $('matched').textContent = counters?.matched ?? 0;
  $('rejected').textContent = (counters?.rejected ?? 0) + (counters?.unchanged ?? 0);
  $('failedThreads').textContent = counters?.failed ?? 0;
  $('start').disabled = !consented || active || exporting;
  $('stop').disabled = !active;
  const scanDone = !!job?.scanFinishedAt && job.phase === 'download';
  $('resume').disabled = !job || active || exporting || scanDone || !jobMachine.isResumable(job);
  $('save').disabled = !job || active || exporting || job.status === 'draft';
  $('reviewSection').hidden = !job;
  if (!job) {
    $('warnings').hidden = true;
    return;
  }
  const counts = await store.attachmentCounts(job.id);
  $('filesDone').textContent = counts.complete;
  const problems = counts.failed + counts.interrupted;
  $('filesProblem').textContent = problems;
  $('retryFailed').disabled = active || exporting || !problems;
  $('deleteBatch').disabled = active || exporting;
  const totalFiles = Object.values(counts).reduce((sum, value) => sum + value, 0);
  $('filesCount').textContent = String(totalFiles);
  $('reviewTitle').textContent = job.name;
  $('reviewSummary').textContent = `${counters.matched} conversation(s) matched from ${counters.inspected} opened. ${counts.discovered + counts.pending} file(s) waiting, ${counts.complete} saved.${job.savedAt ? ` Last saved ${new Date(job.savedAt).toLocaleString()}.` : ''}`;
  renderWarnings(job, counts);
  // Rebuild the lists only when the job's shape changes, so ticking a box is never undone by the refresh.
  const key = active ? `${job.id}|active` : `${job.id}|${job.status}|${counters.matched}|${counters.failed}|${counts.complete}|${problems}`;
  if (key !== shownJobKey && !active) {
    shownJobKey = key;
    await renderReviewLists();
  }
}

async function setCurrentJob(jobId) {
  currentJob = jobId ? await store.getJob(jobId) : null;
  shownJobKey = '';
  await chrome.storage.local.set({ [CURRENT_JOB_KEY]: currentJob?.id || null });
}

async function checkActiveJob() {
  const job = currentJob;
  if (!jobMachine.isActive(job)) return;
  let status = null;
  try {
    if (job.ownerTabId != null) status = await chrome.tabs.sendMessage(job.ownerTabId, { type: 'GET_STATUS' });
  } catch {
    status = null;
  }
  if (status?.ok && status.running && status.jobId === job.id) {
    missedPings = 0;
    lastStage = status.stage;
    if (status.hidden) lastStage += ' (this Gmail tab is in the background, so it may run slowly)';
    return;
  }
  // Allow for a moment between the job row being written and the script reporting it.
  missedPings++;
  if (missedPings >= 4) {
    missedPings = 0;
    await store.patchJob(job.id, { status: 'interrupted', leaseExpiresAt: null, lastError: 'The Gmail tab was reloaded or closed. Everything captured so far is kept. Resume to continue.' });
    currentJob = await store.getJob(job.id);
  }
}

async function tick() {
  if (currentJob) {
    await checkActiveJob();
    currentJob = await store.getJob(currentJob.id);
    if (!currentJob) shownJobKey = '';
  }
  if (currentJob) {
    const active = jobMachine.isActive(currentJob);
    if (active) {
      const { inspected = 0 } = currentJob.counters;
      const started = Date.parse(currentJob.startedAt || currentJob.createdAt);
      const minutes = Math.max(1 / 60, (Date.now() - started) / 60000);
      $('rate').textContent = currentJob.phase === 'scan' ? `${(inspected / minutes).toFixed(1)} conversations a minute` : '';
    } else {
      $('rate').textContent = '';
    }
    if (!exporting) {
      $('status').textContent = active ? lastStage || 'Working…' : statusSentence(currentJob);
    }
    if (!active && currentJob.pendingExport && !exporting) await continueExport();
  } else if (!exporting) {
    const tab = await activeGmailTab();
    $('status').textContent = tab ? 'Ready' : 'Open Gmail in this window to begin';
    $('rate').textContent = '';
  }
  await renderJob();
}

function statusSentence(job) {
  switch (job.status) {
    case 'ready': return job.savedAt ? 'Saved. You can save again or start a new search.' : 'Scan finished. Review the results, then save.';
    case 'stopped': return job.stopReason === 'limit' ? 'Stopped at your safety limit. Raise it and resume to continue.' : 'Stopped safely. Everything captured so far is kept.';
    case 'interrupted': return 'Interrupted. Everything captured so far is kept.';
    case 'failed': return 'This job needs attention.';
    default: return STATE_LABELS[job.status] || job.status;
  }
}

// ---- Scan actions ----

async function confirmLargeScan(tabId, config) {
  if (config.source.mode !== 'current-view' || config.source.gmailQuery) return true;
  const view = await command('VIEW_INFO', {}, tabId);
  if (!view.total || view.total < LARGE_SCAN_WARNING) return true;
  const minutes = Math.ceil((view.total * SECONDS_PER_THREAD) / 60);
  return confirm(`Gmail shows about ${view.total} conversations here. InboxFoundry will open each one (marking them as read), which could take ${minutes} minutes or more. Continue?`);
}

async function startScan() {
  notice('');
  const config = validatedConfig();
  const tab = await requireGmailTab();
  if (!await confirmLargeScan(tab.id, config)) return;
  const response = await command('START_SCAN', { config }, tab.id);
  lastStage = 'Starting…';
  missedPings = 0;
  $('previewResult').hidden = true;
  await setCurrentJob(response.jobId);
  await loadBatches();
  await tick();
}

async function resumeScan() {
  notice('');
  const overrides = { maxMatchedThreads: $('maxThreads').value, maxInspectedThreads: $('maxInspected').value };
  if (currentJob.stopReason === 'limit' && Number(overrides.maxMatchedThreads) <= currentJob.config.source.maxMatchedThreads && currentJob.partialReasons.includes('limit-matched')) {
    throw new Error('This batch stopped at its limit. Raise "Stop after matching" under More options, then resume.');
  }
  if (currentJob.stopReason === 'limit' && Number(overrides.maxInspectedThreads) <= currentJob.config.source.maxInspectedThreads && currentJob.partialReasons.includes('limit-inspected')) {
    throw new Error('This batch stopped at its limit. Raise "Stop after opening" under More options, then resume.');
  }
  const tab = await requireGmailTab();
  await command('RESUME_SCAN', { jobId: currentJob.id, overrides }, tab.id);
  lastStage = 'Resuming…';
  missedPings = 0;
  await tick();
}

async function stopJob() {
  if (currentJob?.ownerTabId == null) return;
  await command('STOP', {}, currentJob.ownerTabId);
  lastStage = 'Stopping after the current item…';
}

async function previewThread() {
  const result = await command('PREVIEW_THREAD', { config: validatedConfig() });
  const box = $('previewResult');
  const heading = document.createElement('h3');
  heading.textContent = result.matched ? 'This conversation matches' : 'This conversation does not match';
  const summary = document.createElement('p');
  summary.className = 'micro';
  summary.textContent = `${result.subject || '(No subject)'} · ${result.messageCount} message(s) · ${result.reasons.join(', ')}`;
  const list = document.createElement('ul');
  for (const file of result.attachments) {
    const item = document.createElement('li');
    item.textContent = `${file.fileName}: ${file.matched ? 'included' : `left out (${file.reasons.join(', ')})`}`;
    list.append(item);
  }
  box.replaceChildren(heading, summary, list);
  box.hidden = false;
}

// ---- Save ----

function saveBlob(job, file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file.blob);
    const finish = (callback, value) => {
      chrome.downloads.onChanged.removeListener(watch);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      callback(value);
    };
    let downloadId = null;
    const watch = delta => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') finish(resolve, file.name);
      if (delta.state?.current === 'interrupted') finish(reject, new Error(`Could not save ${file.name}: ${delta.error?.current || 'the download was interrupted'}.`));
    };
    chrome.downloads.onChanged.addListener(watch);
    chrome.downloads.download({ url, filename: exporter.downloadPathFor(job, file.name), conflictAction: 'uniquify', saveAs: false }, id => {
      if (chrome.runtime.lastError || !id) finish(reject, new Error(chrome.runtime.lastError?.message || `Could not save ${file.name}.`));
      else downloadId = id;
    });
  });
}

async function refreshDownloadStates(jobId) {
  for await (const file of store.iterateAttachments(jobId)) {
    if (!Number.isInteger(file.downloadId)) continue;
    const [item] = await chrome.downloads.search({ id: file.downloadId });
    if (!item) {
      if (file.state === 'in_progress') await store.patchAttachment(file.id, { state: 'interrupted', error: 'Chrome no longer lists this download.' });
      continue;
    }
    await store.patchAttachment(file.id, { state: item.state, finalPath: item.filename || file.finalPath, error: item.error || null });
  }
}

async function recordExportedMail(job) {
  const scope = schema.ledgerScope(job);
  const savedAt = new Date().toISOString();
  let afterSeq = -1;
  for (;;) {
    const rows = await store.matchedThreadPage(job.id, afterSeq, 500);
    if (!rows.length) return;
    const entries = [];
    for (const thread of rows) {
      if (thread.excluded) continue;
      const entry = { scope, lastMessageId: thread.lastMessageId || null, messageCount: thread.messageCount, savedAt };
      entries.push({ ...entry, id: `${scope}|${thread.threadKey}`, threadKey: thread.threadKey });
      if (thread.permId && thread.permId !== thread.threadKey) entries.push({ ...entry, id: `${scope}|${thread.permId}`, threadKey: thread.permId });
    }
    await store.putLedgerEntries(entries);
    afterSeq = rows.at(-1).seq;
  }
}

async function runExports(job, formats, passphrase) {
  exporting = true;
  try {
    $('status').textContent = 'Preparing your files…';
    await renderJob();
    await refreshDownloadStates(job.id);
    const fresh = await store.getJob(job.id);
    const { files, isPartial } = await exporter.buildFiles(fresh, formats, {
      store,
      version: chrome.runtime.getManifest().version,
      onProgress: text => { $('status').textContent = text; }
    });
    const output = passphrase ? await exporter.encryptFiles(files, passphrase) : files;
    for (const file of output) {
      $('status').textContent = `Saving ${file.name}…`;
      await saveBlob(fresh, file);
    }
    await recordExportedMail(fresh);
    await store.patchJob(job.id, { savedAt: new Date().toISOString(), pendingExport: null });
    const where = exporter.downloadPathFor(fresh, '').replace(/\/[^/]*$/, '');
    const counts = await store.attachmentCounts(job.id);
    const parts = [`Saved to Downloads/${where}.`];
    if (isPartial) parts.push('This batch is marked partial; the reasons are listed above and in the files.');
    if (counts.failed + counts.interrupted) parts.push(`${counts.failed + counts.interrupted} file(s) failed. Use "Retry failed files".`);
    if (counts.pending) parts.push(`${counts.pending} file(s) are still waiting. Press "Save selected" with Gmail open to continue.`);
    notice(parts.join(' '), isPartial || counts.failed + counts.interrupted + counts.pending ? 'error' : 'info');
  } finally {
    exporting = false;
    currentJob = await store.getJob(job.id);
  }
}

async function continueExport() {
  const job = currentJob;
  const formats = job.pendingExport.formats || [];
  if (job.pendingExport.encrypted && !pendingPassphrase) {
    await store.patchJob(job.id, { pendingExport: null });
    notice('Attachments finished. Enter your passphrase again and press Save to write the encrypted export.');
    return;
  }
  const passphrase = pendingPassphrase;
  pendingPassphrase = '';
  if (!formats.length) {
    await recordExportedMail(job);
    await store.patchJob(job.id, { savedAt: new Date().toISOString(), pendingExport: null });
    const counts = await store.attachmentCounts(job.id);
    const problems = counts.failed + counts.interrupted + counts.pending;
    notice(problems ? `${counts.complete} file(s) saved, ${problems} not saved. Use "Retry failed files" or "Save selected".` : `${counts.complete} file(s) saved to Downloads.`, problems ? 'error' : 'info');
    return;
  }
  await runExports(job, formats, passphrase);
  $('encryptionPassphrase').value = '';
}

async function save() {
  notice('');
  const job = currentJob;
  const formats = checkedValues('formats');
  const encrypted = $('encryptExport').checked;
  const passphrase = encrypted ? $('encryptionPassphrase').value : '';
  if (encrypted && passphrase.length < 10) throw new Error('Use an encryption passphrase of at least 10 characters.');
  if (encrypted && !formats.length) throw new Error('Choose at least one format to encrypt.');

  const excluded = new Set();
  for await (const thread of store.iterateThreads(job.id)) if (thread.excluded) excluded.add(thread.id);
  await store.updateAttachments(job.id, file => {
    const wanted = file.selected && !excluded.has(file.threadId);
    if (file.state === 'discovered' && wanted) return { state: 'pending' };
    if (file.state === 'pending' && !wanted) return { state: 'discovered' };
    return null;
  });
  const counts = await store.attachmentCounts(job.id);
  if (!counts.pending && !formats.length) throw new Error('Nothing to save: tick some files or choose an email format.');

  if (counts.pending) {
    const tab = await requireGmailTab();
    pendingPassphrase = passphrase;
    await store.patchJob(job.id, { pendingExport: { formats, encrypted } });
    await command('START_DOWNLOADS', { jobId: job.id }, tab.id);
    lastStage = 'Saving files…';
    missedPings = 0;
    currentJob = await store.getJob(job.id);
    await tick();
    return;
  }
  await runExports(job, formats, passphrase);
  $('encryptionPassphrase').value = '';
}

async function retryFailed() {
  notice('');
  const job = currentJob;
  const rows = [];
  for await (const file of store.iterateAttachments(job.id)) if (['failed', 'interrupted'].includes(file.state)) rows.push(file);
  let resumed = 0;
  for (const file of rows) {
    if (file.state === 'interrupted' && Number.isInteger(file.downloadId)) {
      const [item] = await chrome.downloads.search({ id: file.downloadId });
      if (item?.state === 'interrupted' && item.canResume) {
        try {
          await chrome.downloads.resume(file.downloadId);
          await store.patchAttachment(file.id, { state: 'in_progress', error: null });
          resumed++;
          continue;
        } catch {
          // Fall through and download it again.
        }
      }
    }
    await store.patchAttachment(file.id, { state: 'pending', error: null, downloadId: null });
  }
  const counts = await store.attachmentCounts(job.id);
  if (counts.pending) {
    await command('START_DOWNLOADS', { jobId: job.id });
    lastStage = 'Retrying files…';
    missedPings = 0;
  } else if (resumed) {
    notice(`Resumed ${resumed} download(s).`, 'info');
  }
  currentJob = await store.getJob(job.id);
  shownJobKey = '';
  await tick();
}

async function setAllFiles(selected) {
  await store.updateAttachments(currentJob.id, file => (['discovered', 'pending'].includes(file.state) ? { selected } : null));
  shownJobKey = '';
  await tick();
}

async function deselectDuplicates() {
  const files = [];
  for await (const file of store.iterateAttachments(currentJob.id)) if (file.selected && file.state === 'discovered') files.push({ id: file.id, fileName: file.fileName, sizeBytes: file.sizeBytes });
  const ids = new Set(attachmentAnalysis.likelyDuplicateIds(files));
  await store.updateAttachments(currentJob.id, file => (ids.has(file.id) ? { selected: false } : null));
  notice(`Unticked ${ids.size} file(s) with the same name and size as another. Compared by name and size only, not by content.`, 'info');
  shownJobKey = '';
  await tick();
}

// ---- Batches, presets and tools ----

async function loadBatches() {
  const jobs = await store.listJobs();
  jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const options = [new Option('Choose a batch…', '')];
  for (const job of jobs) options.push(new Option(`${job.name} · ${job.counters.matched} matched · ${STATE_LABELS[job.status] || job.status}`, job.id));
  $('jobs').replaceChildren(...options);
  const estimate = await navigator.storage?.estimate?.();
  $('storageUsage').textContent = estimate?.usage == null ? '' : `${(estimate.usage / 1048576).toFixed(1)} MB of captured mail is stored in this browser. Batches stay until you delete them.`;
}

async function deleteBatch() {
  if (!confirm(`Delete ${currentJob.name} from this browser? Files already saved to disk stay.`)) return;
  await store.deleteJob(currentJob.id);
  await setCurrentJob(null);
  await loadBatches();
  notice('Batch deleted.', 'info');
  await tick();
}

async function loadPresets() {
  const presets = await store.listPresets();
  const options = [new Option('Choose a saved search…', '')];
  for (const preset of presets.sort((a, b) => a.name.localeCompare(b.name))) options.push(new Option(preset.name, preset.id));
  $('presets').replaceChildren(...options);
}

async function savePreset() {
  const name = $('presetName').value.trim();
  if (!name) throw new Error('Type a name for this search first.');
  const now = new Date().toISOString();
  const existing = (await store.listPresets()).find(preset => preset.name === name);
  await store.putPreset({ id: existing?.id || `preset-${crypto.randomUUID()}`, name, form: readForm(), updatedAt: now });
  $('presetName').value = '';
  await loadPresets();
  notice(`Saved "${name}".`, 'info');
}

async function diagnosticsText() {
  const job = currentJob;
  const events = job ? await store.getEvents(job.id) : [];
  const counts = job ? await store.attachmentCounts(job.id) : null;
  const report = {
    extensionVersion: chrome.runtime.getManifest().version,
    browser: navigator.userAgent.replace(/\([^)]*\)/g, '(platform hidden)'),
    job: job && {
      status: job.status, phase: job.phase, counters: job.counters, partialReasons: job.partialReasons, stopReason: job.stopReason,
      scope: job.config.source.mode, formats: job.config.output.formats, pacingMs: job.config.source.pacingMs
    },
    files: counts,
    events: events.map(event => ({ at: event.createdAt, type: event.type, detail: event.detail }))
  };
  return JSON.stringify(report, null, 2);
}

async function checkCompatibility() {
  const response = await command('CHECK_COMPAT');
  $('compatReport').textContent = JSON.stringify(response.report, null, 2);
  $('compatReport').hidden = false;
}

async function decrypt() {
  const file = $('decryptFile').files?.[0];
  if (!file) return;
  try {
    const result = await exportEngine.decryptBlob(file, $('decryptPassphrase').value);
    const url = URL.createObjectURL(result.blob);
    const name = pathSafety.sanitizeFileName(result.contentName, 'inboxfoundry-export.zip');
    await new Promise((resolve, reject) => chrome.downloads.download({ url, filename: `InboxFoundry/decrypted/${name}`, conflictAction: 'uniquify', saveAs: false }, id => (id ? resolve() : reject(new Error(chrome.runtime.lastError?.message)))));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    notice(`Decrypted to Downloads/InboxFoundry/decrypted/${name}.`, 'info');
  } catch {
    notice('Could not decrypt this file. Check the passphrase and that the file is complete.');
  } finally {
    $('decryptFile').value = '';
    $('decryptPassphrase').value = '';
  }
}

// ---- Wiring ----

function wire() {
  $('noticeClose').addEventListener('click', () => notice(''));
  $('acknowledge').addEventListener('click', guarded(async () => {
    consented = true;
    await chrome.storage.local.set({ [CONSENT_KEY]: true });
    $('consent').hidden = true;
    await tick();
  }));
  $('start').addEventListener('click', guarded(startScan));
  $('resume').addEventListener('click', guarded(resumeScan));
  $('stop').addEventListener('click', guarded(stopJob));
  $('preview').addEventListener('click', guarded(previewThread));
  $('save').addEventListener('click', guarded(save));
  $('retryFailed').addEventListener('click', guarded(retryFailed));
  $('deleteBatch').addEventListener('click', guarded(deleteBatch));
  $('threadsMore').addEventListener('click', guarded(appendThreads));
  $('filesMore').addEventListener('click', guarded(appendFiles));
  $('selectAllFiles').addEventListener('click', guarded(() => setAllFiles(true)));
  $('selectNoFiles').addEventListener('click', guarded(() => setAllFiles(false)));
  $('deselectDuplicates').addEventListener('click', guarded(deselectDuplicates));
  $('encryptExport').addEventListener('change', () => { $('encryptFields').hidden = !$('encryptExport').checked; });
  $('formats').addEventListener('change', () => { formatsTouched = true; });
  $('searchSection').addEventListener('input', refreshFormHints);
  $('searchSection').addEventListener('change', event => {
    if (event.target.name === 'intent') applyIntentDefaults();
    refreshFormHints();
  });
  $('savePreset').addEventListener('click', guarded(savePreset));
  $('loadPreset').addEventListener('click', guarded(async () => {
    const preset = (await store.listPresets()).find(item => item.id === $('presets').value);
    if (!preset) throw new Error('Choose a saved search first.');
    writeForm(preset.form);
    applyIntentDefaults();
    refreshFormHints();
  }));
  $('deletePreset').addEventListener('click', guarded(async () => {
    if (!$('presets').value) throw new Error('Choose a saved search first.');
    await store.deletePreset($('presets').value);
    await loadPresets();
  }));
  $('openBatch').addEventListener('click', guarded(async () => {
    if (!$('jobs').value) throw new Error('Choose a batch first.');
    await setCurrentJob($('jobs').value);
    await tick();
  }));
  $('clearJobs').addEventListener('click', guarded(async () => {
    if (jobMachine.isActive(currentJob)) throw new Error('Stop the running job first.');
    if (!confirm('Delete every batch from this browser? Files already saved to disk stay.')) return;
    await store.clearJobs();
    await setCurrentJob(null);
    await loadBatches();
    notice('All batches deleted.', 'info');
    await tick();
  }));
  $('forgetHistory').addEventListener('click', guarded(async () => {
    if (!confirm('Forget which mail was already saved? The next repeat export will include it again.')) return;
    await store.clearLedger();
    notice('Saved-mail history cleared.', 'info');
  }));
  $('checkCompat').addEventListener('click', guarded(checkCompatibility));
  $('copyDiagnostics').addEventListener('click', guarded(async () => {
    const text = await diagnosticsText();
    $('compatReport').textContent = text;
    $('compatReport').hidden = false;
    await navigator.clipboard?.writeText(text).catch(() => {});
    notice('Diagnostics are shown below and copied if the browser allowed it. They contain no mail content.', 'info');
  }));
  $('decryptFile').addEventListener('change', guarded(decrypt));
}

async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  wire();
  const stored = await chrome.storage.local.get([CONSENT_KEY, CURRENT_JOB_KEY, FORM_KEY]);
  consented = stored[CONSENT_KEY] === true;
  $('consent').hidden = consented;
  writeForm(stored[FORM_KEY]);
  applyIntentDefaults();
  refreshFormHints();
  await Promise.all([loadPresets(), loadBatches()]);
  if (stored[CURRENT_JOB_KEY]) await setCurrentJob(stored[CURRENT_JOB_KEY]);
  await tick();
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (error) {
      console.error('[InboxFoundry]', error);
    } finally {
      busy = false;
    }
  }, 1200);
}

init().catch(error => notice(friendlyError(error)));
