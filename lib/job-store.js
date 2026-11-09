(function initJobStore(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), jobStore: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createJobStore() {
  'use strict';

  const DB_NAME = 'inboxFoundry';
  const DB_VERSION = 3;
  const PAGE_SIZE = 200;
  const STORES = Object.freeze({
    jobs: 'jobs',
    threads: 'threads', // light per-thread outcome and summary
    records: 'records', // full captured content, read only when exporting
    attachments: 'attachments', // discovered files and their download state
    presets: 'presets',
    events: 'events', // lifecycle notes with no mailbox content
    ledger: 'ledger' // what has already been exported, across batches
  });
  const PER_JOB_STORES = [STORES.threads, STORES.records, STORES.attachments, STORES.events];

  let databasePromise;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function createStores(db) {
    for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
    const jobs = db.createObjectStore(STORES.jobs, { keyPath: 'id' });
    jobs.createIndex('updatedAt', 'updatedAt');
    const threads = db.createObjectStore(STORES.threads, { keyPath: 'id' });
    threads.createIndex('jobId', 'jobId');
    threads.createIndex('jobSeq', ['jobId', 'seq']);
    threads.createIndex('jobOutcomeSeq', ['jobId', 'outcome', 'seq']);
    const records = db.createObjectStore(STORES.records, { keyPath: 'id' });
    records.createIndex('jobId', 'jobId');
    records.createIndex('jobSeq', ['jobId', 'seq']);
    const attachments = db.createObjectStore(STORES.attachments, { keyPath: 'id' });
    attachments.createIndex('jobId', 'jobId');
    attachments.createIndex('jobSeq', ['jobId', 'seq']);
    attachments.createIndex('jobState', ['jobId', 'state']);
    attachments.createIndex('jobThread', ['jobId', 'threadId']);
    attachments.createIndex('downloadId', 'downloadId');
    const presets = db.createObjectStore(STORES.presets, { keyPath: 'id' });
    presets.createIndex('updatedAt', 'updatedAt');
    const events = db.createObjectStore(STORES.events, { keyPath: 'id' });
    events.createIndex('jobId', 'jobId');
    const ledger = db.createObjectStore(STORES.ledger, { keyPath: 'id' });
    ledger.createIndex('scope', 'scope');
  }

  function open() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => createStores(request.result);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databasePromise = null;
        };
        db.onclose = () => {
          databasePromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error('Could not open the InboxFoundry database'));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error('The InboxFoundry database is busy. Close other InboxFoundry panels and try again.'));
      };
    });
    return databasePromise;
  }

  async function put(storeName, value) {
    const db = await open();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    await transactionDone(tx);
    return value;
  }

  async function get(storeName, key) {
    const db = await open();
    return requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
  }

  async function getAll(storeName, indexName, query, count) {
    const db = await open();
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    return requestResult((indexName ? store.index(indexName) : store).getAll(query, count));
  }

  async function count(storeName, indexName, query) {
    const db = await open();
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    return requestResult((indexName ? store.index(indexName) : store).count(query));
  }

  async function update(storeName, key, patch) {
    const db = await open();
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const current = await requestResult(store.get(key));
    if (!current) {
      tx.abort();
      await transactionDone(tx).catch(() => {});
      return null;
    }
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    store.put(next);
    await transactionDone(tx);
    return next;
  }

  /** Reads one page ordered by sequence number; pass the last row's seq to continue. */
  function jobPage(storeName, jobId, afterSeq = -1, limit = PAGE_SIZE) {
    const range = IDBKeyRange.bound([jobId, afterSeq + 1], [jobId, Number.MAX_SAFE_INTEGER]);
    return getAll(storeName, 'jobSeq', range, limit);
  }

  /** Walks a whole job in pages, so even very large jobs never need to fit in memory or one message. */
  async function* iterate(storeName, jobId, limit = PAGE_SIZE) {
    let afterSeq = -1;
    for (;;) {
      const rows = await jobPage(storeName, jobId, afterSeq, limit);
      if (!rows.length) return;
      for (const row of rows) yield row;
      afterSeq = rows.at(-1).seq;
      if (rows.length < limit) return;
    }
  }

  async function putThreadBundle({ thread, record, attachments = [], removeThreadId }) {
    const db = await open();
    const names = [STORES.threads, STORES.records, STORES.attachments];
    const tx = db.transaction(names, 'readwrite');
    const now = new Date().toISOString();
    if (removeThreadId) tx.objectStore(STORES.threads).delete(removeThreadId);
    tx.objectStore(STORES.threads).put({ ...thread, updatedAt: now });
    if (record) tx.objectStore(STORES.records).put({ ...record, updatedAt: now });
    const store = tx.objectStore(STORES.attachments);
    attachments.forEach(attachment => store.put({ ...attachment, updatedAt: now }));
    await transactionDone(tx);
    return true;
  }

  /** Applies a change to every attachment of a job in one transaction, skipping rows the filter rejects. */
  async function updateAttachments(jobId, change) {
    const db = await open();
    const tx = db.transaction(STORES.attachments, 'readwrite');
    const store = tx.objectStore(STORES.attachments);
    const request = store.index('jobId').openCursor(IDBKeyRange.only(jobId));
    let changed = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const patch = change(cursor.value);
      if (patch) {
        cursor.update({ ...cursor.value, ...patch });
        changed++;
      }
      cursor.continue();
    };
    await transactionDone(tx);
    return changed;
  }

  async function attachmentCounts(jobId) {
    const states = ['discovered', 'skipped', 'unavailable', 'pending', 'in_progress', 'complete', 'interrupted', 'failed', 'erased'];
    const entries = await Promise.all(states.map(async state => [state, await count(STORES.attachments, 'jobState', IDBKeyRange.only([jobId, state]))]));
    return Object.fromEntries(entries);
  }

  async function patchByChromeId(downloadId, patch) {
    const rows = await getAll(STORES.attachments, 'downloadId', IDBKeyRange.only(downloadId));
    return rows.length ? update(STORES.attachments, rows[0].id, patch) : null;
  }

  async function addEvent(jobId, type, detail = {}) {
    const stamp = Date.now().toString(36).padStart(10, '0');
    const id = `${jobId}:${stamp}-${Math.random().toString(36).slice(2, 8)}`;
    return put(STORES.events, { id, jobId, type, detail, createdAt: new Date().toISOString() });
  }

  async function deleteByIndex(tx, storeName, indexName, key) {
    const store = tx.objectStore(storeName);
    const request = store.index(indexName).openKeyCursor(IDBKeyRange.only(key));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }

  async function deleteJob(jobId) {
    const db = await open();
    const tx = db.transaction([STORES.jobs, ...PER_JOB_STORES], 'readwrite');
    tx.objectStore(STORES.jobs).delete(jobId);
    for (const name of PER_JOB_STORES) deleteByIndex(tx, name, 'jobId', jobId);
    await transactionDone(tx);
  }

  async function clearStores(names) {
    const db = await open();
    const tx = db.transaction(names, 'readwrite');
    names.forEach(name => tx.objectStore(name).clear());
    await transactionDone(tx);
  }

  async function putLedgerEntries(entries) {
    if (!entries.length) return;
    const db = await open();
    const tx = db.transaction(STORES.ledger, 'readwrite');
    entries.forEach(entry => tx.objectStore(STORES.ledger).put(entry));
    await transactionDone(tx);
  }

  return {
    PAGE_SIZE,
    putJob: job => put(STORES.jobs, { ...job, updatedAt: new Date().toISOString() }),
    getJob: jobId => get(STORES.jobs, jobId),
    patchJob: (jobId, patch) => update(STORES.jobs, jobId, patch),
    listJobs: () => getAll(STORES.jobs),
    putThreadBundle,
    patchThread: (id, patch) => update(STORES.threads, id, patch),
    threadPage: (jobId, afterSeq, limit) => jobPage(STORES.threads, jobId, afterSeq, limit),
    matchedThreadPage(jobId, afterSeq = -1, limit = PAGE_SIZE) {
      const range = IDBKeyRange.bound([jobId, 'matched', afterSeq + 1], [jobId, 'matched', Number.MAX_SAFE_INTEGER]);
      return getAll(STORES.threads, 'jobOutcomeSeq', range, limit);
    },
    iterateThreads: jobId => iterate(STORES.threads, jobId),
    iterateRecords: jobId => iterate(STORES.records, jobId, 50),
    iterateAttachments: jobId => iterate(STORES.attachments, jobId),
    attachmentPage: (jobId, afterSeq, limit) => jobPage(STORES.attachments, jobId, afterSeq, limit),
    pendingAttachments: (jobId, limit = PAGE_SIZE) => getAll(STORES.attachments, 'jobState', IDBKeyRange.only([jobId, 'pending']), limit),
    getAttachment: id => get(STORES.attachments, id),
    patchAttachment: (id, patch) => update(STORES.attachments, id, patch),
    patchByChromeId,
    updateAttachments,
    attachmentCounts,
    countInProgress: jobId => count(STORES.attachments, 'jobState', IDBKeyRange.only([jobId, 'in_progress'])),
    addEvent,
    getEvents: jobId => getAll(STORES.events, 'jobId', IDBKeyRange.only(jobId)),
    putPreset: preset => put(STORES.presets, preset),
    listPresets: () => getAll(STORES.presets),
    deletePreset: async id => {
      const db = await open();
      const tx = db.transaction(STORES.presets, 'readwrite');
      tx.objectStore(STORES.presets).delete(id);
      await transactionDone(tx);
    },
    deleteJob,
    clearJobs: () => clearStores([STORES.jobs, ...PER_JOB_STORES]),
    putLedgerEntries,
    ledgerForScope: scope => getAll(STORES.ledger, 'scope', IDBKeyRange.only(scope)),
    clearLedger: () => clearStores([STORES.ledger])
  };
});
