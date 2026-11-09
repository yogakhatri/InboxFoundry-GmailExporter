// Injected into the Gmail tab only when the side panel needs it. Drives Gmail's page to scan
// conversations and to start attachment downloads. Exports are built in the side panel instead.
(() => {
  if (window.__inboxFoundry?.isAlive?.()) return;
  const isAlive = () => !!globalThis.chrome?.runtime?.id;
  window.__inboxFoundry = { isAlive };

  const { schema, jobMachine, pathSafety, gmailAdapter, gmailDate, filterEngine } = globalThis.InboxFoundry;
  const CONSENT_KEY = 'inboxFoundryPrivacyAcknowledgedV1';
  const BATCH_COUNTER_KEY = 'inboxFoundryNextBatchNumber';
  const LEASE_MS = 180000;
  const MAX_THREAD_ATTEMPTS = 3;
  const MAX_CONSECUTIVE_FAILURES = 5;
  const MAX_UNREAD_SWEEPS = 25;
  const MAX_CONCURRENT_DOWNLOADS = 3;
  const DOWNLOAD_STALL_MS = 15 * 60 * 1000;
  const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  const state = {
    running: false,
    stopRequested: false,
    stage: 'Idle',
    job: null,
    config: null,
    done: new Set(),
    attempts: new Map(),
    ledger: new Map(),
    seq: 0,
    attachmentSeq: 0,
    page: 1,
    tabId: null
  };

  function backgroundSleep(ms) {
    return chrome.runtime.sendMessage({ type: 'SLEEP', ms }).then(() => {}, () => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** Chrome slows timers in hidden tabs to about one a minute, so hidden tabs wait on the service worker instead. */
  function sleep(ms) {
    if (document.hidden && isAlive()) return backgroundSleep(ms);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  const gmail = gmailAdapter.create({
    documentRef: document,
    locationRef: location,
    historyRef: history,
    sleep,
    isHidden: () => document.hidden,
    resolveDate: gmailDate.resolve,
    onStage: value => { state.stage = value; }
  });

  class ContextGone extends Error {}

  /** Storage calls survive a service worker restart by retrying; each one is safe to repeat. */
  async function request(type, payload = {}) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!isAlive()) throw new ContextGone('InboxFoundry was reloaded. Reopen the panel and resume.');
      try {
        const response = await chrome.runtime.sendMessage({ type, ...payload });
        if (response?.ok === false) throw Object.assign(new Error(response.error || `${type} failed`), { fromStore: true });
        if (response === undefined) throw new Error('The background worker did not respond.');
        return response.result;
      } catch (error) {
        if (error.fromStore) throw error;
        if (/context invalidated/i.test(error.message)) throw new ContextGone('InboxFoundry was reloaded. Reopen the panel and resume.');
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  const accountSlot = () => location.pathname.match(/\/mail\/u\/(\d+)/)?.[1] || '0';
  const accountEmail = () => document.title.match(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase() || '';
  const currentBase = () => gmailAdapter.parseView(location.hash).base;
  /** The hash of the list page behind any open conversation. */
  function currentListHash() {
    const { base, page } = gmailAdapter.parseView(location.hash);
    return page > 1 ? `${base}/p${page}` : base;
  }

  function logEvent(eventType, detail = {}) {
    if (!state.job) return Promise.resolve();
    return request('ADD_EVENT', { jobId: state.job.id, eventType, detail }).catch(() => {});
  }

  async function saveJob(patch = {}) {
    state.job = { ...state.job, ...patch };
    await request('PUT_JOB', { job: state.job });
  }

  function setStatus(next, detail = {}) {
    state.job = jobMachine.transition(state.job, next, detail);
  }

  function redact(value) {
    return String(value ?? '').replace(EMAIL_PATTERN, '[redacted-email]');
  }

  function renderFolder(meta, messages, ordinal) {
    const { output } = state.config;
    const sender = messages[0]?.from || '';
    const iso = messages[0]?.dateIso;
    const values = {
      index: String(ordinal).padStart(5, '0'),
      subject: pathSafety.sanitizePart(output.redactAddresses ? redact(meta.subject) : meta.subject, 'No subject'),
      senderDomain: output.redactAddresses ? 'redacted-domain' : pathSafety.sanitizePart(sender.split('@')[1], 'unknown-domain'),
      date: iso ? iso.slice(0, 10) : 'unknown-date'
    };
    const rendered = String(output.folderTemplate || '{index} - {subject}')
      .replace(/\{(index|subject|senderDomain|date)\}/g, (_, key) => values[key]);
    return `${state.job.name}/${rendered}`;
  }

  function shapeMessage(message) {
    const { output } = state.config;
    const scrub = output.redactAddresses ? redact : value => value;
    const full = output.contentMode === 'full';
    return {
      index: message.index,
      messageId: output.includeInternalIds ? message.messageId : undefined,
      from: scrub(message.from),
      fromName: output.redactAddresses ? undefined : message.fromName || undefined,
      recipients: (message.recipients || []).map(scrub),
      date: scrub(message.date),
      dateIso: message.dateIso,
      dateSource: message.dateSource,
      rawHeaderText: scrub(message.rawHeaderText),
      bodyTextRaw: full ? scrub(message.bodyTextRaw) : undefined,
      bodyHtmlRaw: full && output.includeRawHtml ? scrub(message.bodyHtmlRaw) : undefined,
      attachments: message.attachments.map(item => ({ fileName: item.fileName, sizeBytes: item.sizeBytes }))
    };
  }

  function attachmentRows(threadId, threadSeq, threadKey, subject, url, folder, evaluation, messageFilter) {
    const { attachments: rules, destination } = state.config;
    return evaluation.attachmentEvaluations
      .filter(item => messageFilter(item.attachment.messageIndex))
      .map(item => {
        const { attachment } = item;
        let fileState = 'discovered';
        if (rules.action === 'none') fileState = 'skipped';
        else if (!attachment.url && !attachment.canClick) fileState = 'unavailable';
        const clutter = item.reasons.some(reason => ['tiny-image', 'common-clutter-name'].includes(reason));
        const selected = fileState === 'discovered' && (rules.action === 'matching' ? item.matched : !clutter);
        return {
          id: `${threadId}:a:${attachment.messageIndex}:${attachment.ordinal}`,
          jobId: state.job.id,
          seq: state.attachmentSeq++,
          threadId,
          threadSeq,
          threadKey,
          threadUrl: url,
          subject,
          messageIndex: attachment.messageIndex,
          ordinal: attachment.ordinal,
          fileName: attachment.fileName,
          sizeBytes: attachment.sizeBytes ?? null,
          url: attachment.url,
          driveLink: !!attachment.driveLink,
          classification: item.classification,
          matched: item.matched,
          reasons: item.reasons,
          selected,
          state: fileState,
          rootFolder: destination.rootFolder,
          folder: `${folder}/Message-${String(attachment.messageIndex).padStart(3, '0')}`
        };
      });
  }

  function threadBase(rowInfo, identity, seq) {
    const threadKey = identity.key;
    return {
      id: `${state.job.id}:${threadKey}`,
      jobId: state.job.id,
      seq,
      threadKey,
      rowKey: rowInfo?.key || threadKey,
      permId: identity.permId,
      weakIdentity: identity.weak,
      wasUnread: !!rowInfo?.unread
    };
  }

  function markDone(...keys) {
    for (const key of keys) if (key) state.done.add(key);
  }

  /** Returns 'matched', 'rejected', 'unchanged', or 'duplicate'. Throws if the conversation can't be captured. */
  async function captureOpenThread(rowInfo) {
    state.stage = 'Reading the conversation…';
    await gmail.expandThread();
    let view = gmail.extractThread();
    if (!view.messages.length) {
      await sleep(1200);
      await gmail.expandThread();
      view = gmail.extractThread();
    }
    if (!view.messages.length) throw new Error('No message body could be read from this conversation.');

    const strongRowKey = rowInfo?.strong ? rowInfo.key : null;
    if (view.threadId && state.done.has(view.threadId)) {
      markDone(rowInfo?.key);
      // A row with its own Gmail ID should open its own conversation. If it didn't, say so: mail may be missing.
      if (rowInfo?.strong) {
        await saveJob({ counters: { ...state.job.counters, repeatedViews: (state.job.counters.repeatedViews || 0) + 1 } });
        await logEvent('row-opened-captured-conversation');
      }
      return 'duplicate';
    }
    const identity = {
      key: strongRowKey || view.threadId || rowInfo?.key || `open-${Date.now()}`,
      permId: view.threadId,
      weak: !strongRowKey && !view.threadId
    };
    const counters = { ...state.job.counters };
    counters.inspected++;
    const failedBefore = state.attempts.has(rowInfo?.key);
    if (failedBefore) {
      counters.failed = Math.max(0, counters.failed - 1);
      state.attempts.delete(rowInfo.key);
    }
    const removeThreadId = failedBefore && rowInfo.key !== identity.key ? `${state.job.id}:${rowInfo.key}` : undefined;
    if (rowInfo?.unread) counters.unread++;

    const lastMessageId = view.messages.at(-1).messageId;
    const previous = state.ledger.get(identity.key) || state.ledger.get(view.threadId);
    const seq = state.seq++;
    const base = threadBase(rowInfo, identity, seq);
    const summary = {
      subject: view.subject,
      from: view.messages[0].from,
      date: view.messages[0].dateIso,
      messageCount: view.messages.length,
      lastMessageId
    };

    if (previous && previous.messageCount === view.messages.length && (!lastMessageId || previous.lastMessageId === lastMessageId)) {
      counters.unchanged++;
      await request('PUT_THREAD_BUNDLE', { bundle: { removeThreadId, thread: { ...base, outcome: 'unchanged', ...summary, reasons: ['already-exported'] } } });
      markDone(identity.key, rowInfo?.key, view.threadId);
      await saveJob({ counters });
      return 'unchanged';
    }

    const evaluation = filterEngine.evaluateThread(view, view.messages, state.config);
    if (!evaluation.matched) {
      counters.rejected++;
      state.stage = 'Did not match; moving on…';
      const privateSummary = state.config.output.redactAddresses
        ? { ...summary, subject: redact(summary.subject), from: redact(summary.from) } : summary;
      await request('PUT_THREAD_BUNDLE', { bundle: { removeThreadId, thread: { ...base, outcome: 'rejected', ...privateSummary, reasons: evaluation.reasons } } });
      markDone(identity.key, rowInfo?.key, view.threadId);
      await saveJob({ counters });
      return 'rejected';
    }

    const { email, output } = state.config;
    const onlyMatching = email.threadMode === 'matching-messages';
    const included = onlyMatching ? new Set(evaluation.matchedMessageIndexes) : null;
    const keepMessage = index => !included || included.has(index);
    const kept = view.messages.filter(message => keepMessage(message.index));
    const ordinal = counters.matched + 1;
    const folder = renderFolder(view, kept, ordinal);
    const warnings = [];
    if (view.messagesNotExpanded > 0) warnings.push(`messages-not-readable:${view.messagesNotExpanded}`);
    if (rowInfo?.countHint && rowInfo.countHint > view.messages.length) warnings.push(`gmail-shows-${rowInfo.countHint}-messages-captured-${view.messages.length}`);
    if (evaluation.reasons.includes('date-unverified') || view.messages.some(message => message.dateSource === 'unknown')) warnings.push('date-unverified');
    if (identity.weak) warnings.push('no-gmail-thread-id');
    if (warnings.some(item => item.startsWith('messages-') || item.startsWith('gmail-shows'))) counters.incomplete++;

    const scrub = output.redactAddresses ? redact : value => value;
    const subject = scrub(view.subject);
    const record = {
      recordId: `record-${String(ordinal).padStart(6, '0')}`,
      threadKey: output.includeInternalIds ? identity.key : undefined,
      subject,
      url: output.includeGmailUrls && !output.redactAddresses ? view.url : undefined,
      captureMode: email.threadMode,
      folder,
      capturedAt: new Date().toISOString(),
      wasUnread: !!rowInfo?.unread,
      warnings,
      matchEvidence: {
        reasons: evaluation.reasons,
        matchingMessageIndexes: evaluation.matchedMessageIndexes,
        matchingAttachments: evaluation.matchedAttachments.map(item => ({ fileName: item.fileName, messageIndex: item.messageIndex }))
      },
      messages: kept.map(shapeMessage)
    };
    const threadId = base.id;
    const attachments = attachmentRows(threadId, seq, identity.key, subject, view.url, folder, evaluation, keepMessage);
    counters.matched++;
    counters.messages += kept.length;
    await request('PUT_THREAD_BUNDLE', {
      bundle: {
        removeThreadId,
        thread: {
          ...base,
          outcome: 'matched',
          ...summary,
          subject,
          from: scrub(summary.from),
          attachmentCount: attachments.length,
          reasons: evaluation.reasons,
          warnings,
          excluded: false,
          url: view.url
        },
        record: { id: threadId, jobId: state.job.id, seq, record },
        attachments
      }
    });
    markDone(identity.key, rowInfo?.key, view.threadId);
    await saveJob({ counters, nextAttachmentSeq: state.attachmentSeq, nextSeq: state.seq });
    return 'matched';
  }

  async function recordFailure(rowInfo, error) {
    const key = rowInfo?.key || `open-${Date.now()}`;
    const attempts = (state.attempts.get(key) || 0) + 1;
    state.attempts.set(key, attempts);
    const seq = state.seq++;
    await request('PUT_THREAD_BUNDLE', {
      bundle: {
        thread: {
          id: `${state.job.id}:${key}`,
          jobId: state.job.id,
          seq,
          threadKey: key,
          rowKey: key,
          outcome: 'failed',
          attempts,
          wasUnread: !!rowInfo?.unread,
          error: String(error?.message || error)
        }
      }
    });
    markDone(key);
    const counters = { ...state.job.counters, failed: state.job.counters.failed + 1 };
    await saveJob({ counters, nextSeq: state.seq });
    await logEvent('thread-failed', { ordinal: counters.inspected + counters.failed, attempts, code: String(error?.message || error).slice(0, 120) });
  }

  /** A single unreadable conversation is recorded and skipped, so it can never block everything after it. */
  async function processRow(rowInfo, listHash) {
    state.stage = `Opening conversation ${state.job.counters.inspected + 1}…`;
    let opened = await gmail.openThread(rowInfo.element);
    if (!opened) {
      await gmail.returnToList(listHash);
      await sleep(800);
      const again = gmail.listRows(state.page).find(row => row.key === rowInfo.key);
      if (again) opened = await gmail.openThread(again.element);
    }
    if (!opened) {
      await recordFailure(rowInfo, new Error('The conversation did not open.'));
      await gmail.returnToList(listHash);
      return false;
    }
    let succeeded = true;
    try {
      await captureOpenThread(rowInfo);
    } catch (error) {
      if (error instanceof ContextGone || error.fromStore) throw error;
      await recordFailure(rowInfo, error);
      succeeded = false;
    }
    await gmail.returnToList(listHash);
    return succeeded;
  }

  async function loadProgress() {
    state.done = new Set();
    state.attempts = new Map();
    let afterSeq = -1;
    let maxSeq = -1;
    for (;;) {
      const rows = await request('THREAD_PAGE', { jobId: state.job.id, afterSeq, limit: 2000 });
      if (!rows.length) break;
      for (const row of rows) {
        maxSeq = Math.max(maxSeq, row.seq);
        if (row.outcome === 'failed') {
          state.attempts.set(row.threadKey, row.attempts || 1);
          if ((row.attempts || 1) >= MAX_THREAD_ATTEMPTS) markDone(row.threadKey);
        } else markDone(row.threadKey, row.rowKey, row.permId);
      }
      afterSeq = rows.at(-1).seq;
      if (rows.length < 2000) break;
    }
    state.seq = Math.max(state.job.nextSeq || 0, maxSeq + 1);
    state.attachmentSeq = state.job.nextAttachmentSeq || 0;
  }

  async function loadLedger() {
    state.ledger = new Map();
    if (!state.config.source.incremental) return;
    const entries = await request('LEDGER_FOR_SCOPE', { scope: schema.ledgerScope(state.job) });
    for (const entry of entries) state.ledger.set(entry.threadKey, entry);
  }

  function isUnreadView() {
    const base = gmailAdapter.comparableBase(state.job.sourceBase);
    return /(^|[\s/-])(is|label):unread\b/.test(base);
  }

  function startHeartbeat() {
    const beat = () => {
      if (!state.running || !state.job) return;
      const patch = { ownerTabId: state.tabId, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
      state.job = { ...state.job, ...patch };
      request('PATCH_JOB', { jobId: state.job.id, patch }).catch(error => {
        state.stage = `Storage problem: ${error.message}`;
        state.stopRequested = true;
      });
    };
    beat();
    return setInterval(beat, 30000);
  }

  function addPartialReason(reason) {
    if (!state.job.partialReasons.includes(reason)) state.job.partialReasons = [...state.job.partialReasons, reason];
  }

  function nextUnprocessedRow(rows) {
    const { mode, selectedThreadKeys, incremental } = state.config.source;
    for (const row of rows) {
      if (state.done.has(row.key)) continue;
      if (mode === 'selected' && !selectedThreadKeys.includes(row.key)) continue;
      if ((state.attempts.get(row.key) || 0) >= MAX_THREAD_ATTEMPTS) continue;
      if (incremental && row.lastMessageId && state.ledger.get(row.key)?.lastMessageId === row.lastMessageId) {
        markDone(row.key);
        state.job.counters = { ...state.job.counters, unchanged: state.job.counters.unchanged + 1 };
        continue;
      }
      return row;
    }
    return null;
  }

  /** Scans the list until the end, a limit, or Stop. Every pass awaits a real timer, so Gmail stays responsive. */
  async function scanList() {
    const { source } = state.config;
    const sourceBase = gmailAdapter.comparableBase(state.job.sourceBase);
    let consecutiveFailures = 0;
    let sweeps = 0;
    let inspectedAtSweep = state.job.counters.inspected;
    let sawRows = false;

    for (;;) {
      await sleep(40);
      if (state.stopRequested) return 'stopped';
      if (state.job.accountSlot !== accountSlot()) throw new Error('The active Gmail account changed. Return to the original account and resume.');
      if (state.job.counters.matched >= source.maxMatchedThreads) {
        addPartialReason('limit-matched');
        return 'limit';
      }
      if (state.job.counters.inspected >= source.maxInspectedThreads) {
        addPartialReason('limit-inspected');
        return 'limit';
      }
      if (gmail.isThreadOpen() && !gmail.listRows(state.page).length) await gmail.returnToList(currentListHash());
      if (gmailAdapter.comparableBase(currentBase()) !== sourceBase) throw Object.assign(new Error('Gmail moved to a different list while scanning. Nothing was mixed in; resume to continue.'), { interrupted: true });

      state.page = gmailAdapter.parseView(location.hash).page;
      const hasRows = await gmail.waitForRows(sawRows ? 15000 : 8000);
      if (hasRows) sawRows = true;
      // Rows that were there and have gone are not proof of the end: the list may just be slow or broken.
      // An unread search is the exception, because reading mail really does empty it.
      if (!hasRows && sawRows && !isUnreadView()) {
        addPartialReason('pagination-end-unconfirmed');
        await logEvent('list-disappeared', { page: state.page });
        return 'finished';
      }
      const row = hasRows ? nextUnprocessedRow(gmail.listRows(state.page)) : null;
      if (row) {
        const succeeded = await processRow(row, currentListHash());
        consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error(`${MAX_CONSECUTIVE_FAILURES} conversations in a row could not be read. Gmail may have changed or you may be signed out. Run "Check Gmail compatibility", then resume.`);
        }
        await sleep(source.pacingMs);
        continue;
      }
      if (source.mode === 'current-page' || source.mode === 'selected') return 'finished';

      state.stage = 'Moving to the next page…';
      const result = hasRows ? await gmail.nextPage() : { status: 'end', method: 'empty-list' };
      if (result.status === 'advanced') {
        await logEvent('page-advanced', { method: result.method });
        continue;
      }
      if (result.status === 'unconfirmed') {
        addPartialReason('pagination-end-unconfirmed');
        await logEvent('pagination-unconfirmed');
        return 'finished';
      }
      // Reading unread mail removes it from an unread search, which shifts results, so sweep until nothing new appears.
      if (isUnreadView() && state.job.counters.inspected > inspectedAtSweep && sweeps < MAX_UNREAD_SWEEPS) {
        sweeps++;
        inspectedAtSweep = state.job.counters.inspected;
        state.stage = 'Checking the unread list again…';
        location.hash = state.job.sourceBase;
        await sleep(1200);
        continue;
      }
      if (!sawRows) addPartialReason('no-rows-found');
      return 'finished';
    }
  }

  async function runScan() {
    state.running = true;
    state.stopRequested = false;
    state.stage = 'Scanning…';
    const heartbeat = startHeartbeat();
    try {
      setStatus('running', { phase: 'scan', ownerTabId: state.tabId, lastError: null, stopReason: null });
      state.job.partialReasons = [];
      await saveJob();
      await logEvent('scan-started', { mode: state.config.source.mode });
      await loadProgress();
      await loadLedger();

      let outcome;
      if (state.config.source.mode === 'current-thread') {
        if (!gmail.isThreadOpen()) throw new Error('Open the conversation you want to save, then start.');
        await captureOpenThread(null);
        outcome = 'finished';
      } else {
        outcome = await scanList();
      }

      const { counters } = state.job;
      if (counters.failed > 0) addPartialReason('threads-failed');
      if (counters.incomplete > 0) addPartialReason('threads-incomplete');
      if (counters.repeatedViews > 0) addPartialReason('rows-opened-same-conversation');
      if (outcome === 'stopped' || outcome === 'limit') {
        if (state.job.status === 'running') setStatus('pausing');
        setStatus('stopped', { stopReason: outcome === 'limit' ? 'limit' : 'user', leaseExpiresAt: null });
        state.stage = outcome === 'limit' ? 'Safety limit reached. Raise it and resume to continue.' : 'Stopped safely. Everything captured so far is kept.';
      } else {
        setStatus('ready', { leaseExpiresAt: null });
        state.stage = 'Scan finished. Review the results, then save.';
      }
      await logEvent('scan-finished', { outcome, ...counters, partialReasons: state.job.partialReasons });
    } catch (error) {
      if (error instanceof ContextGone) return;
      console.error('[InboxFoundry]', error);
      state.stage = error.message;
      setStatus(error.interrupted ? 'interrupted' : 'failed', { lastError: error.message, leaseExpiresAt: null });
      await logEvent('scan-error', { message: error.message });
    } finally {
      clearInterval(heartbeat);
      state.running = false;
      if (isAlive()) await saveJob().catch(error => { state.stage = `Could not save the job: ${error.message}`; });
    }
  }

  async function ensureTabId() {
    if (state.tabId == null) state.tabId = (await request('GET_CONTEXT')).tabId;
  }

  async function nextBatch() {
    const stored = await chrome.storage.local.get(BATCH_COUNTER_KEY);
    const number = Number(stored[BATCH_COUNTER_KEY]) || 1;
    await chrome.storage.local.set({ [BATCH_COUNTER_KEY]: number + 1 });
    return number;
  }

  async function assertNoOtherLiveJob(exceptId) {
    const jobs = await request('LIST_JOBS');
    const now = Date.now();
    for (const job of jobs) {
      if (job.id === exceptId || !jobMachine.isActive(job)) continue;
      if (Date.parse(job.leaseExpiresAt || 0) > now && job.ownerTabId !== state.tabId) {
        throw new Error(`${job.name} is running in another Gmail tab. Stop it before starting another.`);
      }
      await request('PATCH_JOB', { jobId: job.id, patch: { status: 'interrupted', leaseExpiresAt: null, lastError: 'The Gmail tab stopped responding.' } });
    }
  }

  async function settleAfterNavigation(previousSignature) {
    await gmail.waitFor(() => {
      const signature = gmail.listSignature();
      return signature && signature !== previousSignature ? true : null;
    }, 6000, 150);
    await sleep(300);
  }

  async function startScan(rawConfig) {
    if (state.running) throw new Error('A job is already running in this Gmail tab.');
    await ensureTabId();
    const consent = await chrome.storage.local.get(CONSENT_KEY);
    if (consent[CONSENT_KEY] !== true) throw new Error('Please read and accept the notice in the InboxFoundry panel first.');
    await assertNoOtherLiveJob(null);

    const config = schema.normalizeConfig(rawConfig);
    const { mode, gmailQuery } = config.source;
    if (mode === 'current-thread' && !gmail.isThreadOpen()) throw new Error('Open the conversation you want to save, then start.');
    if (mode === 'selected') {
      if (gmail.isThreadOpen()) throw new Error('Go back to the Gmail list to use selected rows.');
      config.source.selectedThreadKeys = gmail.listRows(1).filter(row => row.selected).map(row => row.key);
      if (!config.source.selectedThreadKeys.length) throw new Error('Tick at least one conversation in Gmail first.');
    } else if (mode !== 'current-thread') {
      if (gmailQuery) {
        const before = gmail.listSignature();
        const hashBefore = location.hash;
        gmail.search(gmailQuery);
        state.stage = 'Opening your search in Gmail…';
        if (location.hash !== hashBefore) await settleAfterNavigation(before);
      } else if (gmail.isThreadOpen()) {
        await gmail.returnToList(currentListHash());
      }
    }

    const batchNumber = await nextBatch();
    const date = new Date().toISOString().slice(0, 10);
    state.config = config;
    state.page = 1;
    state.job = schema.createJob(config, {
      name: `Batch ${String(batchNumber).padStart(3, '0')} ${date}`,
      batchNumber,
      sourceUrl: location.href,
      sourceBase: currentBase(),
      accountSlot: accountSlot(),
      accountEmail: accountEmail(),
      ownerTabId: state.tabId
    });
    await saveJob();
    return state.job.id;
  }

  async function loadJob(jobId) {
    const job = await request('GET_JOB', { jobId });
    if (!job) throw new Error('That batch no longer exists.');
    state.job = job;
    state.config = schema.normalizeConfig(job.config);
  }

  async function prepareResume(jobId, overrides = {}) {
    if (state.running) throw new Error('A job is already running in this Gmail tab.');
    await ensureTabId();
    await loadJob(jobId);
    if (!jobMachine.isResumable(state.job) && !jobMachine.isActive(state.job)) throw new Error('This batch has nothing to resume.');
    await assertNoOtherLiveJob(jobId);
    if (state.job.accountSlot !== accountSlot()) throw new Error('This batch belongs to another Gmail account. Switch to that account first.');
    if (jobMachine.isActive(state.job)) state.job = { ...state.job, status: 'interrupted' };
    const source = state.config.source;
    if (overrides.maxMatchedThreads) source.maxMatchedThreads = Math.max(source.maxMatchedThreads, Number(overrides.maxMatchedThreads));
    if (overrides.maxInspectedThreads) source.maxInspectedThreads = Math.max(source.maxInspectedThreads, Number(overrides.maxInspectedThreads));
    state.job.config = state.config;
    if (source.mode !== 'current-thread' && gmailAdapter.comparableBase(currentBase()) !== gmailAdapter.comparableBase(state.job.sourceBase)) {
      const before = gmail.listSignature();
      location.hash = state.job.sourceBase;
      await settleAfterNavigation(before);
    } else if (source.mode !== 'current-thread' && gmail.isThreadOpen()) {
      await gmail.returnToList(state.job.sourceBase);
    }
  }

  // ---- Attachment downloads ----

  async function clickDownload(attachment) {
    const control = gmail.attachmentControlFor(attachment.messageIndex, attachment.ordinal);
    if (!control) return { ok: false, error: 'Gmail shows no download control for this file.' };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const route = await request('PREPARE_CLICK_DOWNLOAD', { attachmentId: attachment.id, ttlMs: 10000 });
      gmail.press(control);
      let created = false;
      for (let poll = 0; poll < 12 && !created; poll++) {
        await sleep(400);
        created = (await request('CHECK_CLICK_DOWNLOAD', { token: route.token })).created;
      }
      await request('CLEAR_DOWNLOAD_ROUTE');
      if (created) return { ok: true };
    }
    return { ok: false, error: 'Chrome did not report a download after clicking. Check that Gmail is allowed to download multiple files.' };
  }

  async function openThreadForClick(attachment) {
    const targetHash = new URL(attachment.threadUrl).hash;
    if (location.hash !== targetHash) location.hash = targetHash;
    const open = await gmail.waitFor(() => gmail.isThreadOpen(), 12000, 150);
    if (!open) return false;
    await gmail.expandThread();
    return true;
  }

  async function runDownloads(previousStatus) {
    state.running = true;
    state.stopRequested = false;
    const heartbeat = startHeartbeat();
    const listHash = currentListHash();
    let openedThreadForClick = false;
    try {
      setStatus('downloading', { phase: 'download', ownerTabId: state.tabId, statusBeforeDownload: previousStatus, lastError: null });
      await saveJob();
      for (;;) {
        await sleep(40);
        if (state.stopRequested) break;
        const batch = await request('PENDING_ATTACHMENTS', { jobId: state.job.id, limit: 50 });
        if (!batch.length) break;
        for (const attachment of batch) {
          if (state.stopRequested) break;
          state.stage = `Saving ${attachment.fileName}…`;
          while (await request('COUNT_IN_PROGRESS', { jobId: state.job.id }) >= MAX_CONCURRENT_DOWNLOADS) {
            if (state.stopRequested) break;
            await sleep(400);
          }
          if (state.stopRequested) break;
          let result = attachment.url
            ? await request('START_DIRECT_DOWNLOAD', { attachmentId: attachment.id })
            : { ok: false, needsClick: true };
          if (!result.ok && result.needsClick) {
            if (await openThreadForClick(attachment)) {
              openedThreadForClick = true;
              result = await clickDownload(attachment);
            } else {
              result = { ok: false, error: 'The conversation could not be reopened to download this file.' };
            }
          }
          if (!result.ok) {
            await request('PATCH_ATTACHMENT', { id: attachment.id, patch: { state: 'failed', error: result.error, finishedAt: new Date().toISOString() } });
          }
          await sleep(Math.max(120, state.config.source.pacingMs));
        }
      }
      if (openedThreadForClick && listHash !== location.hash) location.hash = listHash;

      state.stage = 'Waiting for Chrome to finish the downloads…';
      let last = -1;
      let lastChange = Date.now();
      while (!state.stopRequested) {
        const inProgress = await request('COUNT_IN_PROGRESS', { jobId: state.job.id });
        if (!inProgress) break;
        if (inProgress !== last) {
          last = inProgress;
          lastChange = Date.now();
        }
        if (Date.now() - lastChange > DOWNLOAD_STALL_MS) {
          await logEvent('downloads-stalled', { inProgress });
          break;
        }
        await sleep(600);
      }
      const back = previousStatus === 'ready' ? 'ready' : 'stopped';
      setStatus(back, { leaseExpiresAt: null });
      state.stage = state.stopRequested ? 'Stopped. Remaining files stay queued.' : 'Attachments finished.';
    } catch (error) {
      if (error instanceof ContextGone) return;
      console.error('[InboxFoundry]', error);
      state.stage = error.message;
      setStatus('failed', { lastError: error.message, leaseExpiresAt: null });
    } finally {
      clearInterval(heartbeat);
      state.running = false;
      if (isAlive()) await saveJob().catch(() => {});
    }
  }

  // ---- Messages from the side panel ----

  const handlers = {
    PING: () => ({ alive: true }),
    GET_STATUS: () => ({
      running: state.running,
      stage: state.stage,
      jobId: state.job?.id || null,
      jobStatus: state.job?.status || 'idle',
      counters: state.job?.counters || null,
      hidden: document.hidden,
      page: state.page
    }),
    VIEW_INFO: () => {
      const range = gmail.paginationRange();
      return { threadOpen: gmail.isThreadOpen(), rows: gmail.listRows(1).length, total: range?.total ?? null, base: currentBase() };
    },
    CHECK_COMPAT: () => ({ report: gmail.compatibilityReport() }),
    OPEN_QUERY: message => {
      gmail.search(message.query);
      return {};
    },
    START_SCAN: async message => {
      const jobId = await startScan(message.config);
      runScan();
      return { jobId };
    },
    RESUME_SCAN: async message => {
      await prepareResume(message.jobId, message.overrides);
      runScan();
      return { jobId: state.job.id };
    },
    START_DOWNLOADS: async message => {
      if (state.running) throw new Error('A job is already running in this Gmail tab.');
      await ensureTabId();
      await loadJob(message.jobId);
      await assertNoOtherLiveJob(message.jobId);
      if (state.job.accountSlot !== accountSlot()) throw new Error('This batch belongs to another Gmail account. Switch to that account first.');
      let previous = state.job.status;
      if (jobMachine.isActive(state.job)) {
        previous = 'interrupted';
        state.job = { ...state.job, status: 'interrupted' };
      }
      runDownloads(previous);
      return { jobId: state.job.id };
    },
    STOP: async () => {
      state.stopRequested = true;
      state.stage = 'Stopping after the current item…';
      if (state.running && state.job?.status === 'running') {
        setStatus('pausing');
        await saveJob();
      }
      return {};
    },
    PREVIEW_THREAD: async message => {
      if (!gmail.isThreadOpen()) throw new Error('Open a conversation in Gmail to preview it. Nothing is saved or downloaded.');
      await gmail.expandThread();
      const view = gmail.extractThread();
      if (!view.messages.length) throw new Error('No message body is visible in this conversation.');
      const evaluation = filterEngine.evaluateThread(view, view.messages, schema.normalizeConfig(message.config));
      return {
        matched: evaluation.matched,
        subject: view.subject,
        reasons: evaluation.reasons,
        messageCount: view.messages.length,
        attachments: evaluation.attachmentEvaluations.map(item => ({ fileName: item.attachment.fileName, matched: item.matched, reasons: item.reasons }))
      };
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(message))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => {
        console.error('[InboxFoundry]', error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  });
})();
