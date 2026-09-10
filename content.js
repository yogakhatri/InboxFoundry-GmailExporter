(() => {
  if (window.__gmailThreadExporterLoaded) return;
  window.__gmailThreadExporterLoaded = true;

  const STORE_KEY = 'gmailThreadExporterStateV1';
  const LEGACY_STORE_KEY = 'tqoGmailRawScraperV23';
  const ACTIVE_JOB_KEY = 'inboxFoundryActiveJobId';
  const DOWNLOAD_ROOT = 'InboxFoundry';
  const schema = globalThis.InboxFoundry.schema;
  const jobMachine = globalThis.InboxFoundry.jobMachine;
  const pathSafety = globalThis.InboxFoundry.pathSafety;
  const gmailAdapterModule = globalThis.InboxFoundry.gmailAdapter;
  const filterEngine = globalThis.InboxFoundry.filterEngine;
  const attachmentAnalysis = globalThis.InboxFoundry.attachmentAnalysis;
  const exportEngine = globalThis.InboxFoundry.exportEngine;
  const state = {
    running: false,
    stopRequested: false,
    status: 'Idle',
    scanned: 0,
    matched: 0,
    skipped: 0,
    messages: 0,
    attachments: 0,
    attachmentFailures: 0,
    job: null,
    config: schema.normalizeConfig(),
    lastStoppedAt: null,
    tabId: null,
    exported: [],
    scannedThreadKeys: new Set(),
    options: {
      downloadAttachments: true,
      includeAllThreadMessages: true,
      keywords: []
    }
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rawText = (el) => (el?.innerText || el?.textContent || '').trim();
  const normalize = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  const downloadRoot = () => state.config.destination?.rootFolder || DOWNLOAD_ROOT;
  const accountSlot = () => location.pathname.match(/\/mail\/u\/(\d+)/)?.[1] || '';

  function sanitizeFolderName(value, fallback = 'Email Thread') {
    return pathSafety.sanitizePart(value, fallback, 90);
  }

  function sanitizeFileName(value, fallback = 'attachment') {
    return pathSafety.sanitizePart(value, fallback, 150);
  }

  function opaqueTaskId() {
    const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${state.job?.id || 'job'}:file:${random}`;
  }

  function parseSizeBytes(value) {
    const match = String(value || '').match(/([\d.,]+)\s*(B|KB|MB|GB)\b/i);
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ''));
    const factor = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2].toUpperCase()];
    return Number.isFinite(amount) ? Math.round(amount * factor) : null;
  }

  const gmail = gmailAdapterModule.create({
    documentRef:document,
    locationRef:location,
    historyRef:history,
    sleep,
    rawText,
    normalize,
    sanitizeFileName,
    parseSizeBytes,
    includeAllThreadMessages:() => state.options.includeAllThreadMessages,
    onStage:value => { state.status = value; }
  });

  function renderFolderTemplate(meta, messages) {
    const sender = messages[0]?.from || '';
    const domain = sender.match(/@([^>\s,;]+)/)?.[1] || 'unknown-domain';
    const parsedDate = Date.parse(messages[0]?.date || '');
    const values = {
      batch: sanitizeFolderName(state.job?.name || 'Export'),
      index: String(state.matched + 1).padStart(5, '0'),
      subject: sanitizeFolderName(meta.subject || 'No subject'),
      senderDomain: state.config.output.redactAddresses ? 'redacted-domain' : sanitizeFolderName(domain),
      date: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString().slice(0, 10) : 'unknown-date'
    };
    const template = state.config.output.folderTemplate || '{batch}/{index} - {subject}';
    return pathSafety.sanitizeFolderPath(template.replace(/\{(batch|index|subject|senderDomain|date)\}/g, (_, key) => values[key]), 'Export');
  }

  function redactEmails(value) {
    return String(value || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
  }

  async function save() {
    if (!state.job) return;
    state.job = {
        ...state.job,
        updatedAt: new Date().toISOString(),
        config: state.config,
        counters: {
          ...state.job.counters,
          inspected: state.scanned,
          matched: state.matched,
          rejected: state.skipped,
          messages: state.messages,
          downloadsStarted: state.attachments,
          downloadsFailed: state.attachmentFailures
        }
    };
    await runtimeMessage({ type: 'DB_PUT_JOB', job: state.job });
    const key = state.tabId ? `${ACTIVE_JOB_KEY}:${state.tabId}` : ACTIVE_JOB_KEY;
    await chrome.storage.local.set({ [key]: state.job.id });
  }

  async function load() {
    const context = await runtimeMessage({ type: 'GET_EXTENSION_CONTEXT' });
    state.tabId = context?.tabId || null;
    const tabJobKey = state.tabId ? `${ACTIVE_JOB_KEY}:${state.tabId}` : ACTIVE_JOB_KEY;
    const obj = await chrome.storage.local.get([STORE_KEY, LEGACY_STORE_KEY, ACTIVE_JOB_KEY, tabJobKey]);
    const p = obj[STORE_KEY] || obj[LEGACY_STORE_KEY];
    const activeJobId = obj[tabJobKey] || obj[ACTIVE_JOB_KEY] || p?.activeJobId;
    if (activeJobId) {
      const jobId = activeJobId;
      const found = await runtimeMessage({ type: 'DB_GET_JOB', jobId });
      if (found?.ok && found.result) {
        state.job = found.result;
        state.config = schema.normalizeConfig(state.job.config);
        const threads = await runtimeMessage({ type: 'DB_GET_THREADS', jobId });
        const terminal = (threads?.result || []).filter(row => ['matched','rejected'].includes(row.outcome));
        state.exported = terminal.filter(row => row.outcome === 'matched').map(row => row.record).filter(Boolean);
        const downloads = await runtimeMessage({ type: 'DB_GET_DOWNLOADS', jobId });
        const downloadRows = downloads?.result || [];
        Object.assign(state, {
          scanned: terminal.length, matched: state.exported.length,
          skipped: terminal.filter(row => row.outcome === 'rejected').length,
          messages: state.exported.reduce((total, thread) => total + (thread.messages?.length || 0), 0),
          attachments: downloadRows.filter(row => ['in_progress','complete','interrupted'].includes(row.state)).length,
          attachmentFailures: downloadRows.filter(row => ['failed','interrupted'].includes(row.state)).length
        });
        state.scannedThreadKeys = new Set(terminal.map(row => row.threadKey));
        if (['running','pausing'].includes(state.job.status) && state.job.ownerTabId === state.tabId) {
          state.job = jobMachine.transition(state.job, 'interrupted');
          state.status = 'Interrupted — ready to resume';
          await save();
        }
        await chrome.storage.local.set({ [tabJobKey]: state.job.id });
        await chrome.storage.local.remove([STORE_KEY, LEGACY_STORE_KEY, ACTIVE_JOB_KEY].filter(key => key !== tabJobKey));
        return;
      }
    }
    if (!p) return;
    state.exported = Array.isArray(p.exported) ? p.exported : [];
    state.scannedThreadKeys = new Set(Array.isArray(p.scannedThreadKeys) ? p.scannedThreadKeys : []);
    state.scanned = p.scanned || 0;
    state.matched = p.matched || state.exported.length;
    state.skipped = p.skipped || Math.max(0, state.scanned - state.matched);
    state.messages = p.messages || state.exported.reduce((n, t) => n + (t.messages?.length || 0), 0);
    state.attachments = p.attachments || 0;
    state.attachmentFailures = p.attachmentFailures || 0;
    if (p.options) state.options = { ...state.options, ...p.options };
    state.config = schema.normalizeConfig(p.config || {
      attachments: { action: state.options.downloadAttachments === false ? 'metadata' : 'all' }
    });
    const jobId = obj[ACTIVE_JOB_KEY] || p.activeJobId;
    if (jobId) {
      const found = await runtimeMessage({ type: 'DB_GET_JOB', jobId });
      if (found?.ok && found.result) state.job = found.result;
    }
    if (!state.job && (state.exported.length || state.scannedThreadKeys.size)) {
      state.job = schema.createJob(state.config, { name: 'Migrated Gmail export', sourceUrl: location.href });
      state.job.status = 'stopped';
      for (const thread of state.exported) {
        await runtimeMessage({ type: 'DB_PUT_THREAD', jobId: state.job.id, threadKey: thread.threadKey, value: { outcome: 'matched', record: thread } });
      }
      await save();
    }
    await chrome.storage.local.remove([STORE_KEY, LEGACY_STORE_KEY, ACTIVE_JOB_KEY].filter(key => key !== tabJobKey));
  }

  function getRows() {
    return gmail.getVisibleThreads();
  }

  function getRowKey(row) {
    return gmail.threadKey(row);
  }

  function isRowSelected(row) {
    return gmail.isThreadSelected(row);
  }

  function getNextButton() {
    return gmail.nextResultsPageControl();
  }

  function disabled(el) {
    return gmail.isDisabled(el);
  }

  async function waitRowsChange(oldSignature) {
    return gmail.waitRowsChange(oldSignature);
  }

  function pageSignature() {
    return gmail.pageSignature();
  }

  async function waitForListRows(timeout = 15000) {
    return gmail.waitForList(timeout);
  }

  function visibleThreadView() {
    return gmail.isThreadView();
  }

  async function expandCollapsedMessages() {
    return gmail.expandCollapsedMessages();
  }

  async function expandTrimmedContent() {
    return gmail.expandTrimmedContent();
  }

  function collectAttachmentTargets() {
    return gmail.extractAttachments();
  }

  function extractMessages() {
    return gmail.extractMessageMetadata();
  }

  function extractThreadMeta(rowKey) {
    return gmail.extractThreadMetadata(rowKey);
  }

  async function runtimeMessage(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (message?.type?.startsWith('DB_') && response?.ok === false) throw new Error(response.error || `Database action failed: ${message.type}`);
      return response;
    } catch (e) {
      if (message?.type?.startsWith('DB_')) throw e;
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function logEvent(eventType, detail = {}) {
    if (!state.job) return;
    try { await runtimeMessage({ type: 'DB_ADD_EVENT', jobId: state.job.id, eventType, detail }); }
    catch (error) { console.warn('[InboxFoundry] Event log unavailable', error); }
  }

  async function clickAndVerifyDownload(target, folder, taskId) {
    const name = sanitizeFileName(target.name);

    // Prefer an explicit URL when Gmail exposes one. This avoids UI timing issues.
    if (target.url) {
      const direct = await runtimeMessage({ type: 'DIRECT_DOWNLOAD', url: target.url, folder, rootFolder: downloadRoot(), fileName: name, jobId: state.job?.id, taskId });
      if (direct?.ok) return { fileName: name, status: 'started', method: 'direct', downloadId: direct.downloadId };
      if (direct?.downloadStarted) throw new Error(direct.error || 'The attachment started but its checkpoint failed.');
    }

    if (!target.element) {
      return { fileName: name, status: 'failed', method: 'none', error: 'Attachment detected but Gmail exposed no usable download control.' };
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const prep = await runtimeMessage({ type: 'PREPARE_CLICK_DOWNLOAD', folder, rootFolder: downloadRoot(), fileName: name, ttlMs: 9000, jobId: state.job?.id, taskId });
      if (!prep?.ok || !prep.token) {
        throw new Error(prep?.error || 'Could not establish a safe download route. No Gmail download was clicked.');
      }
      const token = prep?.token;
      try {
        await gmail.downloadAttachment(target);
      } catch (e) {
        await runtimeMessage({ type: 'CLEAR_DOWNLOAD_ROUTE' });
        if (attempt === 3) return { fileName: name, status: 'failed', method: 'click', error: e?.message || String(e) };
        continue;
      }

      let checked = { ok: false, created: false };
      for (let poll = 0; token && poll < 8 && !checked.created; poll++) {
        await sleep(350 + attempt * 100);
        checked = await runtimeMessage({ type: 'CHECK_CLICK_DOWNLOAD', token });
      }
      await runtimeMessage({ type: 'CLEAR_DOWNLOAD_ROUTE' });
      if (checked?.created) {
        if (checked.persisted === false) throw new Error(checked.persistenceError || 'The attachment started but its checkpoint failed.');
        return { fileName: checked.fileName || name, status: 'started', method: 'click', downloadId: checked.downloadId };
      }
      await sleep(300 * (2 ** (attempt - 1)));
    }

    return { fileName: name, status: 'failed', method: 'click', error: 'No Chrome download event detected after three attempts.' };
  }

  async function downloadAttachmentsForThread(folder, matchingMessageIndexes = null) {
    const action = state.config.attachments.action;
    const allowedMessages = matchingMessageIndexes ? new Set(matchingMessageIndexes) : null;
    const targets = collectAttachmentTargets().filter(target => {
      if (allowedMessages && !allowedMessages.has(target.messageIndex)) return false;
      const decision = filterEngine.attachmentMatches({ fileName: target.name, sizeBytes: target.sizeBytes, inline: !!target.inline }, state.config.attachments);
      if (action === 'matching') return decision.matched;
      if (action === 'all') return !decision.reasons.some(reason => ['inline-file', 'common-clutter-name', 'tiny-image'].includes(reason));
      return true;
    });
    if (action === 'none' || action === 'metadata') {
      return targets.map(t => ({ fileName: t.name, sizeBytes: t.sizeBytes, messageIndex: t.messageIndex, status: action === 'none' ? 'ignored' : 'metadata-only' }));
    }

    const results = [];
    for (let i = 0; i < targets.length; i++) {
      state.status = `Downloading file ${i + 1}/${targets.length}…`;
      const messageFolder = `${folder}/Message-${String(targets[i].messageIndex).padStart(3, '0')}`;
      if (state.attachments >= state.config.attachments.maxDownloads) {
        results.push({ fileName: targets[i].name, messageIndex: targets[i].messageIndex, status: 'limit-reached' });
        continue;
      }
      const taskId = opaqueTaskId();
      await runtimeMessage({ type: 'DB_PUT_DOWNLOAD', value: { id: taskId, jobId: state.job?.id, fileName: targets[i].name, folder: messageFolder, state: 'queued', queuedAt: new Date().toISOString() } });
      const result = await clickAndVerifyDownload(targets[i], messageFolder, taskId);
      results.push({ ...result, sizeBytes: targets[i].sizeBytes, messageIndex: targets[i].messageIndex });
      if (result.status === 'started') state.attachments++;
      else {
        state.attachmentFailures++;
        await runtimeMessage({ type: 'DB_PUT_DOWNLOAD', value: { id: taskId, jobId: state.job?.id, fileName: targets[i].name, folder: messageFolder, state: 'failed', error: result.error, finishedAt: new Date().toISOString() } });
      }
      await sleep(300);
    }
    await runtimeMessage({ type: 'CLEAR_DOWNLOAD_ROUTE' });
    return results;
  }

  async function openRow(row) {
    return gmail.openThread(row);
  }

  async function goBackToList(listUrl, listHash) {
    return gmail.returnToSearchResults(listUrl, listHash);
  }

  async function captureOpenedThread(rowKey) {
    await expandCollapsedMessages();
    await expandTrimmedContent();
    await sleep(250);

    const meta = extractThreadMeta(rowKey);
    let messages = extractMessages();
    if (!messages.length) {
      state.status = 'Waiting for conversation content…';
      await sleep(1200);
      await expandCollapsedMessages();
      await expandTrimmedContent();
      messages = extractMessages();
    }
    if (!messages.length) {
      throw new Error('Gmail thread opened but no message body could be captured. Thread was NOT marked processed.');
    }

    const evaluation = filterEngine.evaluateThread(meta, messages, state.config);
    if (!evaluation.matched) {
      state.status = `Skipped: ${evaluation.reasons.join(', ')}`;
      await runtimeMessage({
        type: 'DB_PUT_THREAD', jobId: state.job.id, threadKey: rowKey,
        value: { outcome: 'rejected', subject: meta.subject, reasons: evaluation.reasons, inspectedAt: new Date().toISOString() }
      });
      state.scannedThreadKeys.add(rowKey);
      state.scanned++;
      state.skipped++;
      await logEvent('thread-rejected', { ordinal: state.scanned, reasons: evaluation.reasons });
      try { await save(); } catch (error) { error.threadCommitted = true; throw error; }
      return { matched: false };
    }

    state.status = `Saving match ${state.matched + 1} (${messages.length} message${messages.length === 1 ? '' : 's'})…`;

    const selectedMessages = state.config.email.threadMode === 'matching-messages'
      ? messages.filter(message => evaluation.matchedMessageIndexes.includes(message.index))
      : messages;

    const folder = renderFolderTemplate(meta, selectedMessages);
    const attachmentResults = await downloadAttachmentsForThread(
      folder,
      state.config.email.threadMode === 'matching-messages' ? evaluation.matchedMessageIndexes : null
    );

    // Attach per-file download result back to its individual conversation message.
    const enrichedMessages = selectedMessages.map((message) => ({
      ...message,
      messageId: state.config.output.includeInternalIds ? message.messageId : undefined,
      from: state.config.output.redactAddresses ? redactEmails(message.from) : message.from,
      recipients: state.config.output.redactAddresses ? (message.recipients || []).map(redactEmails) : message.recipients,
      rawHeaderText: state.config.output.redactAddresses ? redactEmails(message.rawHeaderText) : message.rawHeaderText,
      bodyTextRaw: state.config.output.contentMode === 'full' ? message.bodyTextRaw : undefined,
      bodyTextNormalized: state.config.output.contentMode === 'full' ? message.bodyTextNormalized : undefined,
      bodyHtmlRaw: state.config.output.contentMode === 'full' && state.config.output.includeRawHtml ? message.bodyHtmlRaw : undefined,
      attachmentFolder: `Downloads/${downloadRoot()}/${folder}/Message-${String(message.index).padStart(3, '0')}`,
      attachmentResults: attachmentResults.filter(r => r.messageIndex === message.index)
    }));

    const record = {
      ...meta,
      recordId: `record-${String(state.matched + 1).padStart(5, '0')}`,
      threadKey: state.config.output.includeInternalIds ? meta.threadKey : undefined,
      url: state.config.output.includeGmailUrls ? meta.url : undefined,
      captureMode: state.config.email.threadMode,
      attachmentFolder: `Downloads/${downloadRoot()}/${folder}`,
      exportedAt: new Date().toISOString(),
      matchEvidence: {
        reasons: evaluation.reasons,
        matchingMessageIndexes: evaluation.matchedMessageIndexes,
        matchingAttachments: evaluation.matchedAttachments.map(item => ({ fileName: item.fileName || item.name, messageIndex: item.messageIndex }))
      },
      attachmentSelection: evaluation.attachmentEvaluations.map(item => ({
        fileName: item.attachment.fileName || item.attachment.name,
        messageIndex: item.attachment.messageIndex,
        sizeBytes: item.attachment.sizeBytes ?? null,
        matched: item.matched,
        reasons: item.reasons,
        classification: item.classification
      })),
      rawThreadText: state.config.output.contentMode === 'full' ? enrichedMessages.map((m, i) => `--- MESSAGE ${i + 1} ---\n${m.bodyTextRaw}`).join('\n\n') : undefined,
      messages: enrichedMessages,
      attachmentResults
    };
    await runtimeMessage({
      type: 'DB_PUT_THREAD_BUNDLE', jobId: state.job.id, threadKey: rowKey, value: { outcome: 'matched', record },
      messages: enrichedMessages,
      attachments: record.attachmentSelection
    });
    state.scannedThreadKeys.add(rowKey);
    state.scanned++;
    state.exported.push(record);
    state.matched++;
    state.messages += enrichedMessages.length;
    await logEvent('thread-exported', { ordinal: state.scanned, messageCount: enrichedMessages.length, attachmentResultCount: attachmentResults.length });
    try { await save(); } catch (error) { error.threadCommitted = true; throw error; }
    return { matched: true, record };
  }

  async function processRow(row, rowKey) {
    const listUrl = location.href;
    const listHash = location.hash;
    state.status = `Opening ${state.scanned + 1}…`;
    const ok = await openRow(row);
    if (!ok) {
      await runtimeMessage({ type: 'DB_PUT_THREAD', jobId: state.job.id, threadKey: rowKey, value: { outcome: 'retryable', error: 'Could not open a Gmail thread.', attemptedAt: new Date().toISOString() } });
      throw new Error('Could not open a Gmail thread.');
    }
    await sleep(500);
    try {
      await captureOpenedThread(rowKey);
    } catch (error) {
      if (!error.threadCommitted) await runtimeMessage({ type: 'DB_PUT_THREAD', jobId: state.job.id, threadKey: rowKey, value: { outcome: 'retryable', error: error?.message || String(error), attemptedAt: new Date().toISOString() } });
      throw error;
    }
    await goBackToList(listUrl, listHash);
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    state.status = 'Scanning…';
    let heartbeat = null;
    try {
      if (state.job.status === 'draft') state.job = jobMachine.transition(state.job, 'validating');
      state.job = jobMachine.transition(state.job, 'running', { ownerTabId: state.tabId, leaseExpiresAt: new Date(Date.now() + 90000).toISOString() });
      await save();
      await logEvent('job-started', { resumed: !!state.job.stoppedAt, scopeMode: state.config.source.mode });
      heartbeat = setInterval(() => {
        if (!state.running || !state.job) return;
        state.job.leaseExpiresAt = new Date(Date.now() + 90000).toISOString();
        runtimeMessage({ type: 'DB_PATCH_JOB', jobId: state.job.id, patch: { ownerTabId: state.tabId, leaseExpiresAt: state.job.leaseExpiresAt } })
          .catch(error => { state.status = `Storage heartbeat failed: ${error.message}`; state.stopRequested = true; });
      }, 30000);
      if (state.config.source.mode === 'current-thread') {
        if (!visibleThreadView()) throw new Error('Open the Gmail conversation you want to export, then start the current-thread job.');
        const key = extractThreadMeta('current-thread').threadKey;
        if (!state.scannedThreadKeys.has(key)) await captureOpenedThread(key);
      }
      while (!state.stopRequested && state.config.source.mode !== 'current-thread') {
        if (state.job.accountSlot !== accountSlot()) throw new Error('The active Gmail account changed. Return to the original account before resuming this batch.');
        if (state.matched >= state.config.source.maxMatchedThreads) {
          state.status = `Finished at the ${state.config.source.maxMatchedThreads}-thread Free safety limit`;
          break;
        }
        const rows = await waitForListRows(15000);
        if (!rows?.length) throw new Error('No Gmail rows found. Open Inbox, All Mail, a label, or search results.');

        let nextRow = null;
        let nextKey = null;
        for (const row of rows) {
          const key = getRowKey(row);
          if (state.config.source.mode === 'selected' && !state.config.source.selectedThreadKeys.includes(key)) continue;
          if (key && !state.scannedThreadKeys.has(key) && !state.config.source.excludeThreadKeys.includes(key)) {
            nextRow = row;
            nextKey = key;
            break;
          }
        }

        if (nextRow && nextKey) {
          await processRow(nextRow, nextKey);
          await sleep(Math.min(5000, Math.max(0, Number(state.config.source.pacingMs) || 300)));
          continue;
        }

        if (state.config.source.mode === 'current-page' || state.config.source.mode === 'selected') break;
        const oldSig = pageSignature();
        const next = getNextButton();
        if (disabled(next)) break;

        state.status = 'Current page done — opening older emails…';
        next.click();
        const changed = await waitRowsChange(oldSig);
        if (!changed) {
          await sleep(1200);
          const currentSig = pageSignature();
          if (!currentSig || currentSig === oldSig) throw new Error('Gmail did not open the next page of emails.');
        }
      }
      state.status = state.stopRequested ? 'Stopped safely — partial export ready' : (state.status.startsWith('Finished at') ? state.status : 'Finished');
      if (state.stopRequested) {
        state.lastStoppedAt = new Date().toISOString();
        state.job = jobMachine.transition(state.job, 'stopped', { stoppedAt: state.lastStoppedAt });
      } else {
        state.job = jobMachine.transition(state.job, 'completed');
      }
      await logEvent(state.job.status === 'stopped' ? 'job-stopped' : 'job-completed', { inspected: state.scanned, matched: state.matched, rejected: state.skipped });
    } catch (e) {
      console.error('[InboxFoundry]', e);
      state.status = `Error: ${e.message || String(e)}`;
      state.job = jobMachine.transition(state.job, 'failed', { lastError: e.message || String(e) });
      state.job.counters.errors = (state.job.counters.errors || 0) + 1;
      await logEvent('error', { message: e.message || String(e), stage: state.status });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      state.running = false;
      if (state.job) state.job.leaseExpiresAt = null;
      await runtimeMessage({ type: 'CLEAR_DOWNLOAD_ROUTE' });
      await save();
      const shouldExport = state.stopRequested ? state.config.output.autoExportOnStop : state.config.output.autoExportOnComplete;
      if (shouldExport && (state.job.status === 'stopped' || state.job.status === 'completed')) await downloadExports();
    }
  }

  function exportEnvelope() {
    const partial = state.job?.status !== 'completed';
    return {
      formatVersion: 2,
      schemaVersion: schema.SCHEMA_VERSION,
      generator: { name: 'InboxFoundry', version: chrome.runtime.getManifest().version },
      job: { id: state.job?.id, name: state.job?.name, status: state.job?.status || 'draft', isPartial: partial, createdAt: state.job?.createdAt, startedAt: state.job?.startedAt, stoppedAt: state.job?.stoppedAt, completedAt: state.job?.completedAt },
      exportedAt: new Date().toISOString(),
      source: { mode: 'current-view', url: state.job?.sourceUrl || location.href },
      config: state.config,
      totals: { inspected: state.scanned, matchedThreads: state.matched, rejected: state.skipped, capturedMessages: state.messages, attachmentDownloadsStarted: state.attachments, attachmentDownloadFailures: state.attachmentFailures },
      threads: state.exported
    };
  }

  function triggerDownload(content, type, extension) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inboxfoundry-${state.job?.id || 'export'}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    document.documentElement.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  const csvCell = exportEngine.csvCell;

  function messageCsv(threads) {
    const rows = [['threadKey','subject','messageIndex','from','recipients','date','bodyText','attachmentNames']];
    for (const thread of threads || []) for (const message of thread.messages || []) rows.push([thread.threadKey || thread.recordId, thread.subject, message.index, message.from, (message.recipients || []).join('; '), message.date, message.bodyTextRaw, (message.attachments || []).map(a => a.fileName).join('; ')]);
    return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  }

  function attachmentManifestCsv(threads) {
    const rows = [['threadKey','subject','messageIndex','fileName','status','downloadId']];
    for (const thread of threads || []) for (const item of thread.attachmentResults || []) rows.push([thread.threadKey || thread.recordId, thread.subject, item.messageIndex, item.fileName, item.status, item.downloadId || '']);
    return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function preparedEnvelope() {
    const payload = exportEnvelope();
    if (state.job) {
      const refreshed = await runtimeMessage({ type: 'REFRESH_DOWNLOAD_STATES', jobId: state.job.id });
      if (!refreshed?.ok) throw new Error(refreshed?.error || 'Could not refresh Chrome download states.');
    }
    const persistedDownloads = state.job ? await runtimeMessage({ type: 'DB_GET_DOWNLOADS', jobId: state.job.id }) : null;
    payload.downloads = persistedDownloads?.result || [];
    payload.totals.attachmentDownloadsComplete = payload.downloads.filter(row => row.state === 'complete').length;
    payload.totals.attachmentDownloadsInterrupted = payload.downloads.filter(row => row.state === 'interrupted').length;
    payload.attachmentAnalysis = attachmentAnalysis.analyze(payload.threads.flatMap(thread => (thread.attachmentSelection || []).map(item => ({ ...item, threadKey:thread.threadKey || thread.recordId }))));
    payload.integrity = { algorithm: 'SHA-256', scope: 'captured thread records', generatedAt: new Date().toISOString(), threads: [] };
    for (const thread of payload.threads) payload.integrity.threads.push({ threadKey: thread.threadKey || thread.recordId, sha256: await sha256(JSON.stringify(thread)) });
    payload.integrity.exportSha256 = await sha256(JSON.stringify(payload.threads));
    return payload;
  }

  async function downloadExports(requestedFormats) {
    const payload = await preparedEnvelope();
    const formats = requestedFormats?.length ? requestedFormats : state.config.output.formats;
    if (formats.includes('json')) {
      const split = Number(state.config.output.splitRecords);
      if (Number.isFinite(split) && split > 0 && payload.threads.length > split) {
        for (const part of exportEngine.splitEnvelope(payload, split)) {
          part.integrity.exportSha256 = await sha256(JSON.stringify(part.threads));
          triggerDownload(JSON.stringify(part, null, state.config.output.prettyJson ? 2 : 0), 'application/json', `part-${String(part.part.index).padStart(3, '0')}.json`);
        }
      } else {
        triggerDownload(JSON.stringify(payload, null, state.config.output.prettyJson ? 2 : 0), 'application/json', 'json');
      }
    }
    if (formats.includes('ndjson')) triggerDownload(state.exported.map(thread => JSON.stringify(thread)).join('\n'), 'application/x-ndjson', 'ndjson');
    if (formats.includes('csv')) triggerDownload(messageCsv(payload.threads), 'text/csv', 'csv');
    if (formats.includes('text')) triggerDownload(state.exported.map(thread => `# ${thread.subject}\n\n${thread.messages.map(message => `From: ${message.from}\nDate: ${message.date}\n\n${message.bodyTextRaw}`).join('\n\n---\n\n')}`).join('\n\n========\n\n'), 'text/plain', 'txt');
    if (formats.includes('markdown')) triggerDownload(state.exported.map(thread => `# ${thread.subject || '(No subject)'}\n\n${thread.messages.map(message => `**From:** ${message.from || ''}  \n**Date:** ${message.date || ''}\n\n${String(message.bodyTextRaw || '').split('\n').map(line => `    ${line}`).join('\n')}`).join('\n\n---\n\n')}`).join('\n\n***\n\n'), 'text/markdown', 'md');
    if (formats.includes('html')) triggerDownload(exportEngine.printableHtml(payload), 'text/html', 'html');
    if (formats.includes('pdf')) triggerDownload(exportEngine.basicPdf(payload), 'application/pdf', 'pdf');
    if (formats.includes('manifest')) triggerDownload(attachmentManifestCsv(payload.threads), 'text/csv', 'attachments.csv');
    if (formats.includes('pdfzip')) {
      const pdfEntries = exportEngine.individualPdfEntries(payload);
      const indexRows = [['ordinal','threadKey','subject','messageCount','pdfFile']];
      pdfEntries.forEach((entry, index) => indexRows.push([index + 1, entry.threadKey, entry.subject, entry.messageCount, entry.name]));
      const entries = pdfEntries.map(({ name, data }) => ({ name:`pdf/${name}`, data }));
      entries.push({ name:'index.csv', data:indexRows.map(row => row.map(csvCell).join(',')).join('\r\n') });
      entries.push({ name:'README.txt', data:`InboxFoundry individual PDF package\n\nBatch: ${payload.job?.name || ''}\nPDF count: ${pdfEntries.length}\nPartial: ${payload.job?.isPartial ? 'yes' : 'no'}\n\nThese are text-oriented convenience PDFs derived from captured Gmail content. Consult archive.json/evidence exports for canonical structured records and integrity metadata.\n` });
      const checksums = [];
      for (const entry of entries) checksums.push(`${await sha256(entry.data)}  ${entry.name}`);
      entries.push({ name:'CHECKSUMS.sha256', data:`${checksums.join('\n')}\n` });
      triggerDownload(exportEngine.zipArchive(entries), 'application/zip', 'individual-pdfs.zip');
    }
    if (formats.includes('emlzip')) {
      const emlEntries = exportEngine.emlEntries(payload);
      const indexRows = [['ordinal','threadKey','subject','messageIndex','emlFile']];
      emlEntries.forEach((entry, index) => indexRows.push([index + 1, entry.threadKey, entry.subject, entry.messageIndex, entry.name]));
      const entries = emlEntries.map(({ name, data }) => ({ name:`eml/${name}`, data }));
      entries.push({ name:'index.csv', data:indexRows.map(row => row.map(csvCell).join(',')).join('\r\n') });
      entries.push({ name:'README.txt', data:`InboxFoundry reconstructed EML package\n\nBatch: ${payload.job?.name || ''}\nMessage count: ${emlEntries.length}\nPartial: ${payload.job?.isPartial ? 'yes' : 'no'}\n\nThese EML files are portable reconstructions from fields captured through the Gmail interface. They are not Google's original raw RFC 5322 source, omit unavailable transport headers, and do not embed separately downloaded attachment binaries. The canonical InboxFoundry JSON remains the highest-fidelity record produced by DOM mode.\n` });
      const checksums = [];
      for (const entry of entries) checksums.push(`${await sha256(entry.data)}  ${entry.name}`);
      entries.push({ name:'CHECKSUMS.sha256', data:`${checksums.join('\n')}\n` });
      triggerDownload(exportEngine.zipArchive(entries), 'application/zip', 'reconstructed-eml.zip');
    }
    if (formats.includes('mbox')) triggerDownload(exportEngine.reconstructedMbox(payload), 'application/mbox', 'reconstructed.mbox');
    if (formats.includes('zip')) {
      const entries = [
        { name:'archive.json', data:JSON.stringify(payload, null, 2) },
        { name:'records.ndjson', data:payload.threads.map(thread => JSON.stringify(thread)).join('\n') },
        { name:'records.csv', data:messageCsv(payload.threads) },
        { name:'attachments.csv', data:attachmentManifestCsv(payload.threads) },
        { name:'attachment-analysis.json', data:JSON.stringify(payload.attachmentAnalysis, null, 2) },
        { name:'index.html', data:exportEngine.printableHtml(payload) },
        { name:'README.txt', data:`InboxFoundry evidence package\n\nBatch: ${payload.job?.name || ''}\nExported: ${payload.exportedAt}\nPartial: ${payload.job?.isPartial ? 'yes' : 'no'}\n\nThis ZIP contains message records and manifests. Attachment binaries remain in the separately recorded Downloads folders and are not embedded because the extension does not request broad filesystem-read permission. Verify package files with CHECKSUMS.sha256.\n` }
      ];
      const checksums = [];
      for (const entry of entries) checksums.push(`${await sha256(entry.data)}  ${entry.name}`);
      entries.push({ name:'CHECKSUMS.sha256', data:`${checksums.join('\n')}\n` });
      triggerDownload(exportEngine.zipArchive(entries), 'application/zip', 'zip');
    }
  }

  async function downloadJSON() {
    return downloadExports(['json']);
  }

  async function downloadEncrypted(passphrase) {
    const payload = await preparedEnvelope();
    const encrypted = await exportEngine.encryptText(JSON.stringify(payload), passphrase);
    triggerDownload(encrypted, 'application/vnd.inboxfoundry.encrypted+json', 'ifenc');
  }

  async function downloadDiagnostics() {
    const events = state.job ? await runtimeMessage({ type: 'DB_GET_EVENTS', jobId: state.job.id }) : null;
    const downloads = state.job ? await runtimeMessage({ type: 'DB_GET_DOWNLOADS', jobId: state.job.id }) : null;
    const report = {
      generatedAt: new Date().toISOString(), extensionVersion: chrome.runtime.getManifest().version,
      browser: navigator.userAgent.replace(/\([^)]*\)/g, '(redacted platform)'),
      job: state.job ? { id: state.job.id, status: state.job.status, createdAt: state.job.createdAt, updatedAt: state.job.updatedAt, counters: state.job.counters } : null,
      configShape: state.config ? { emailRuleCounts: Object.fromEntries(Object.entries(state.config.email).filter(([,value]) => Array.isArray(value)).map(([key,value]) => [key,value.length])), attachmentAction: state.config.attachments.action, typeGroupCount: state.config.attachments.typeGroups.length, outputFormats: state.config.output.formats } : null,
      events: events?.result || [],
      downloads: (downloads?.result || []).map((row, index) => ({ ordinal: index + 1, state: row.state, method: row.method, error: row.error || null, startedAt: row.startedAt, finishedAt: row.finishedAt }))
    };
    triggerDownload(JSON.stringify(report, null, 2), 'application/json', 'diagnostics.json');
  }

  const initialLoad = load();

  async function waitUntilStopped(timeoutMs = 45000) {
    const startedAt = Date.now();
    while (state.running && Date.now() - startedAt < timeoutMs) await sleep(100);
    return !state.running;
  }

  function clearState() {
    state.exported = [];
    state.scannedThreadKeys = new Set();
    state.scanned = 0;
    state.matched = 0;
    state.skipped = 0;
    state.messages = 0;
    state.attachments = 0;
    state.attachmentFailures = 0;
    state.status = 'Reset';
    state.lastStoppedAt = null;
  }

  async function createFreshJob(config) {
    const listed = await runtimeMessage({ type: 'DB_LIST_JOBS' });
    const jobs = listed?.result || [];
    const now = Date.now();
    const liveJob = jobs.find(job => ['running','pausing'].includes(job.status) && (Date.parse(job.leaseExpiresAt || 0) > now || now - Date.parse(job.updatedAt || job.startedAt || 0) < 120000));
    if (liveJob) throw new Error(`Another export (${liveJob.name}) is active. Stop it before starting a new job.`);
    for (const stale of jobs.filter(job => ['running','pausing'].includes(job.status))) {
      await runtimeMessage({ type: 'DB_PATCH_JOB', jobId: stale.id, patch: { status: 'interrupted', lastError: 'The Gmail tab closed or stopped responding.' } });
    }
    clearState();
    state.config = schema.normalizeConfig(config);
    if (state.config.source.mode === 'selected') {
      state.config.source.selectedThreadKeys = getRows().filter(isRowSelected).map(getRowKey).filter(Boolean);
      if (!state.config.source.selectedThreadKeys.length) throw new Error('Select at least one Gmail row before starting a selected-rows export.');
    }
    if (state.config.source.incremental) {
      const previous = jobs.filter(job => job.status === 'completed' && job.sourceUrl === location.href)
        .sort((a, b) => String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt)))[0];
      if (previous) {
        const rows = await runtimeMessage({ type: 'DB_GET_THREADS', jobId: previous.id });
        state.config.source.excludeThreadKeys = (rows?.result || []).filter(row => row.outcome === 'matched').map(row => row.threadKey);
        state.config.source.incrementalBaseJobId = previous.id;
      }
    }
    state.options.downloadAttachments = ['all', 'matching'].includes(state.config.attachments.action);
    const batchNumber = jobs.reduce((max, job) => Math.max(max, Number(job.batchNumber) || 0), 0) + 1;
    state.job = schema.createJob(state.config, { name: `Batch ${String(batchNumber).padStart(3, '0')} · ${new Date().toLocaleDateString()}`, sourceUrl: location.href, accountSlot: accountSlot() });
    state.job.batchNumber = batchNumber;
    state.job.ownerTabId = state.tabId;
    const old = jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(schema.FREE_LIMITS.retainedJobs - 1);
    for (const job of old) await runtimeMessage({ type: 'DB_DELETE_JOB', jobId: job.id });
    await save();
  }

  async function previewCurrentThread(config) {
    if (!visibleThreadView()) throw new Error('Open a Gmail conversation to preview it. Preview never saves or downloads anything.');
    await expandCollapsedMessages();
    await expandTrimmedContent();
    const messages = extractMessages();
    if (!messages.length) throw new Error('No message body is available in the open conversation.');
    const meta = extractThreadMeta('preview');
    const evaluation = filterEngine.evaluateThread(meta, messages, schema.normalizeConfig(config));
    return {
      matched: evaluation.matched, subject: meta.subject, reasons: evaluation.reasons,
      messageCount: messages.length, matchingMessageCount: evaluation.matchedMessageIndexes.length,
      attachmentCount: messages.reduce((total, message) => total + (message.attachments?.length || 0), 0),
      matchingAttachmentCount: evaluation.matchedAttachments.length,
      attachments: evaluation.attachmentEvaluations.map(item => ({
        fileName:item.attachment.fileName || item.attachment.name,
        messageIndex:item.attachment.messageIndex,
        sizeBytes:item.attachment.sizeBytes ?? null,
        matched:item.matched,
        reasons:item.reasons,
        classification:item.classification
      }))
    };
  }

  async function dryRunSample(config, requestedLimit = 3) {
    if (state.running) throw new Error('Stop the active export before running a sample.');
    if (visibleThreadView()) throw new Error('Return to a Gmail list or search before running a sample.');
    const sampleConfig = schema.normalizeConfig(config);
    const limit = Math.min(10, Math.max(1, Number(requestedLimit) || 3));
    const originalStatus = state.status;
    const initialRows = await waitForListRows(15000);
    const keys = (initialRows || []).map(getRowKey).filter(Boolean).slice(0, limit);
    if (!keys.length) throw new Error('No Gmail rows found for the sample.');
    const listUrl = location.href;
    const listHash = location.hash;
    const results = [];

    try {
      for (let index = 0; index < keys.length; index++) {
        const rowKey = keys[index];
        state.status = `Dry run ${index + 1}/${keys.length}…`;
        const row = getRows().find(candidate => getRowKey(candidate) === rowKey);
        if (!row) {
          results.push({ ordinal:index + 1, matched:false, error:'The Gmail row was no longer visible.' });
          continue;
        }
        if (!await openRow(row)) {
          results.push({ ordinal:index + 1, matched:false, error:'Could not open this Gmail thread.' });
          continue;
        }
        await sleep(350);
        try {
          await expandCollapsedMessages();
          await expandTrimmedContent();
          const meta = extractThreadMeta(rowKey);
          const messages = extractMessages();
          if (!messages.length) throw new Error('No message body could be captured.');
          const evaluation = filterEngine.evaluateThread(meta, messages, sampleConfig);
          results.push({
            ordinal:index + 1,
            subject:meta.subject,
            matched:evaluation.matched,
            reasons:evaluation.reasons,
            messageCount:messages.length,
            matchingMessageCount:evaluation.matchedMessageIndexes.length,
            attachmentCount:messages.reduce((total, message) => total + (message.attachments?.length || 0), 0),
            matchingAttachmentCount:evaluation.matchedAttachments.length
          });
        } catch (error) {
          results.push({ ordinal:index + 1, matched:false, error:error?.message || String(error) });
        }
        await goBackToList(listUrl, listHash);
      }
    } finally {
      state.status = originalStatus;
      if (visibleThreadView()) {
        try { await goBackToList(listUrl, listHash); } catch (_) {}
      }
    }

    return {
      requested:limit,
      inspected:results.length,
      matched:results.filter(result => result.matched).length,
      rejected:results.filter(result => !result.matched && !result.error).length,
      errors:results.filter(result => result.error).length,
      results
    };
  }

  async function loadRetainedJob(jobId) {
    if (state.running) throw new Error('Stop the active export before opening another batch.');
    const found = await runtimeMessage({ type: 'DB_GET_JOB', jobId });
    if (!found?.result) throw new Error('That retained batch no longer exists.');
    const rows = await runtimeMessage({ type: 'DB_GET_THREADS', jobId });
    const records = rows?.result || [];
    state.job = found.result;
    if (['running','pausing'].includes(state.job.status) && Date.parse(state.job.leaseExpiresAt || 0) <= Date.now()) {
      state.job = jobMachine.transition(state.job, 'interrupted', { lastError: 'The previous Gmail tab stopped before releasing its job lease.' });
      await runtimeMessage({ type: 'DB_PUT_JOB', job: state.job });
    }
    state.config = schema.normalizeConfig(state.job.config);
    state.exported = records.filter(row => row.outcome === 'matched').map(row => row.record).filter(Boolean);
    state.scannedThreadKeys = new Set(records.filter(row => ['matched', 'rejected'].includes(row.outcome)).map(row => row.threadKey));
    state.scanned = state.scannedThreadKeys.size;
    state.matched = state.exported.length;
    state.skipped = records.filter(row => row.outcome === 'rejected').length;
    state.messages = state.exported.reduce((total, thread) => total + (thread.messages?.length || 0), 0);
    const downloads = await runtimeMessage({ type: 'DB_GET_DOWNLOADS', jobId });
    const downloadRows = downloads?.result || [];
    state.attachments = downloadRows.filter(row => ['in_progress','complete','interrupted'].includes(row.state)).length;
    state.attachmentFailures = downloadRows.filter(row => ['failed','interrupted'].includes(row.state)).length;
    state.status = `Loaded ${state.job.name}`;
    const key = state.tabId ? `${ACTIVE_JOB_KEY}:${state.tabId}` : ACTIVE_JOB_KEY;
    await chrome.storage.local.set({ [key]: state.job.id });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        await initialLoad;

        if (msg.type === 'START_EXPORT') {
          if (state.running) {
            sendResponse({ ok: false, error: 'An export is already running in this Gmail tab.' });
            return;
          }
          const disclosure = await chrome.storage.local.get('inboxFoundryPrivacyAcknowledgedV1');
          if (disclosure.inboxFoundryPrivacyAcknowledgedV1 !== true) throw new Error('Open the InboxFoundry workspace and acknowledge the local data disclosure before your first export.');
          const suppliedConfig = msg.config || schema.normalizeConfig({
            attachments: { action: msg.options?.downloadAttachments === false ? 'metadata' : 'all' }
          });
          await createFreshJob(suppliedConfig);
          run();
          sendResponse({ ok: true });
        } else if (msg.type === 'RESUME_EXPORT') {
          if (state.running) throw new Error('This export is already running.');
          if (!state.job || !['stopped', 'interrupted', 'failed'].includes(state.job.status)) throw new Error('There is no stopped or interrupted export to resume.');
          if (state.job.sourceUrl && location.href !== state.job.sourceUrl) throw new Error('Return to the Gmail list/search where this batch started before resuming it.');
          const jobs = await runtimeMessage({ type: 'DB_LIST_JOBS' });
          const otherLive = (jobs?.result || []).find(job => job.id !== state.job.id && ['running','pausing'].includes(job.status) && Date.parse(job.leaseExpiresAt || job.updatedAt || 0) > Date.now());
          if (otherLive) throw new Error(`Another export (${otherLive.name}) is active.`);
          state.job.ownerTabId = state.tabId;
          run();
          sendResponse({ ok: true });
        } else if (msg.type === 'STOP_EXPORT') {
          state.stopRequested = true;
          state.status = state.running ? 'Stopping after the current item…' : 'Stopped';
          if (state.running && state.job?.status === 'running') state.job = jobMachine.transition(state.job, 'pausing');
          if (state.job) await save();
          if (state.job) await logEvent('stop-requested', { afterCurrentThread: true });
          sendResponse({ ok: true });
        } else if (msg.type === 'DOWNLOAD_JSON') {
          await downloadJSON();
          sendResponse({ ok: true });
        } else if (msg.type === 'DOWNLOAD_EXPORTS') {
          await downloadExports(msg.formats);
          sendResponse({ ok: true });
        } else if (msg.type === 'DOWNLOAD_DIAGNOSTICS') {
          await downloadDiagnostics();
          sendResponse({ ok: true });
        } else if (msg.type === 'DOWNLOAD_ENCRYPTED') {
          await downloadEncrypted(msg.passphrase);
          sendResponse({ ok: true });
        } else if (msg.type === 'GET_EXPORT_ESTIMATE') {
          const bytes = new Blob([JSON.stringify(exportEnvelope())]).size;
          sendResponse({ ok: true, bytes, threads: state.exported.length, messages: state.messages, attachments: state.attachments });
        } else if (msg.type === 'PREVIEW_CURRENT_THREAD') {
          sendResponse({ ok: true, ...(await previewCurrentThread(msg.config)) });
        } else if (msg.type === 'DRY_RUN_SAMPLE') {
          sendResponse({ ok: true, ...(await dryRunSample(msg.config, msg.limit)) });
        } else if (msg.type === 'OPEN_GMAIL_QUERY') {
          const query = String(msg.query || '').trim();
          gmail.searchMessages(query);
          sendResponse({ ok: true });
        } else if (msg.type === 'LOAD_JOB') {
          await loadRetainedJob(msg.jobId);
          sendResponse({ ok: true });
        } else if (msg.type === 'RESET_EXPORT') {
          state.stopRequested = true;
          if (!await waitUntilStopped()) {
            sendResponse({ ok: false, error: 'The active export did not stop in time. Try again after its status changes to Stopped.' });
            return;
          }
          const oldJobId = state.job?.id;
          clearState();
          state.job = null;
          state.config = schema.normalizeConfig();
          const tabJobKey = state.tabId ? `${ACTIVE_JOB_KEY}:${state.tabId}` : ACTIVE_JOB_KEY;
          await chrome.storage.local.remove([STORE_KEY, LEGACY_STORE_KEY, tabJobKey]);
          if (oldJobId) await runtimeMessage({ type: 'DB_DELETE_JOB', jobId: oldJobId });
          sendResponse({ ok: true });
        } else if (msg.type === 'CLEAR_MEMORY_STATE') {
          if (state.running) throw new Error('Stop this export before clearing its local state.');
          clearState(); state.job = null; state.config = schema.normalizeConfig();
          sendResponse({ ok: true });
        } else if (msg.type === 'GET_STATUS') {
          const downloads = state.job ? await runtimeMessage({ type: 'DB_GET_DOWNLOADS', jobId: state.job.id }) : null;
          const downloadRows = downloads?.result || [];
          const elapsedSeconds = state.job?.startedAt ? Math.max(0, (Date.now() - Date.parse(state.job.startedAt)) / 1000) : 0;
          sendResponse({
            ok: true,
            running: state.running,
            status: state.status,
            scanned: state.scanned,
            matched: state.matched,
            skipped: state.skipped,
            messages: state.messages,
            attachments: state.attachments,
            attachmentFailures: state.attachmentFailures,
            downloadsComplete: downloadRows.filter(row => row.state === 'complete').length,
            downloadsInterrupted: downloadRows.filter(row => row.state === 'interrupted').length,
            downloadsQueued: downloadRows.filter(row => row.state === 'queued').length,
            downloadsFailed: downloadRows.filter(row => row.state === 'failed').length,
            elapsedSeconds,
            ratePerMinute: elapsedSeconds ? state.scanned / elapsedSeconds * 60 : 0,
            downloadAttachments: state.options.downloadAttachments,
            config: state.config,
            jobId: state.job?.id || null,
            jobStatus: state.job?.status || 'idle',
            justStopped: !!state.lastStoppedAt
          });
        }
      } catch (error) {
        console.error('[InboxFoundry] Message handling failed', error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  });
})();
