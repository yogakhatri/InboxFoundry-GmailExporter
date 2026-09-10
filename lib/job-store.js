(function initJobStore(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), jobStore: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createJobStore() {
  'use strict';

  const DB_NAME = 'inboxFoundry';
  const DB_VERSION = 2;
  const STORES = Object.freeze({
    jobs: 'jobs',
    threads: 'threads',
    messages: 'messages',
    attachments: 'attachments',
    downloads: 'downloads',
    presets: 'presets',
    events: 'events'
  });

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

  function open() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.jobs)) {
          const jobs = db.createObjectStore(STORES.jobs, { keyPath: 'id' });
          jobs.createIndex('status', 'status', { unique: false });
          jobs.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.threads)) {
          const threads = db.createObjectStore(STORES.threads, { keyPath: 'id' });
          threads.createIndex('jobId', 'jobId', { unique: false });
          threads.createIndex('jobOutcome', ['jobId', 'outcome'], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.downloads)) {
          const downloads = db.createObjectStore(STORES.downloads, { keyPath: 'id' });
          downloads.createIndex('jobId', 'jobId', { unique: false });
          downloads.createIndex('downloadId', 'downloadId', { unique: false });
          downloads.createIndex('jobState', ['jobId', 'state'], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.messages)) {
          const messages = db.createObjectStore(STORES.messages, { keyPath: 'id' });
          messages.createIndex('jobId', 'jobId', { unique: false });
          messages.createIndex('threadId', 'threadId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.attachments)) {
          const attachments = db.createObjectStore(STORES.attachments, { keyPath: 'id' });
          attachments.createIndex('jobId', 'jobId', { unique: false });
          attachments.createIndex('threadId', 'threadId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.presets)) {
          const presets = db.createObjectStore(STORES.presets, { keyPath: 'id' });
          presets.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.events)) {
          const events = db.createObjectStore(STORES.events, { keyPath: 'id' });
          events.createIndex('jobId', 'jobId', { unique: false });
          events.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databasePromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error('Could not open InboxFoundry database'));
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
    const tx = db.transaction(storeName, 'readonly');
    return requestResult(tx.objectStore(storeName).get(key));
  }

  async function getAll(storeName, indexName, query) {
    const db = await open();
    const tx = db.transaction(storeName, 'readonly');
    const source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
    return requestResult(source.getAll(query));
  }

  async function deleteKey(storeName, key) {
    const db = await open();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    await transactionDone(tx);
  }

  async function putJob(job) {
    return put(STORES.jobs, { ...job, updatedAt: new Date().toISOString() });
  }

  async function patchJob(jobId, patch) {
    const job = await get(STORES.jobs, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return putJob({ ...job, ...patch, id: jobId });
  }

  async function putThread(jobId, threadKey, value) {
    return put(STORES.threads, {
      ...value,
      id: `${jobId}:${threadKey}`,
      jobId,
      threadKey,
      updatedAt: new Date().toISOString()
    });
  }

  async function putThreadBundle(jobId, threadKey, value, messages = [], attachments = []) {
    const db = await open();
    const names = [STORES.threads, STORES.messages, STORES.attachments];
    const tx = db.transaction(names, 'readwrite');
    const now = new Date().toISOString();
    const threadId = `${jobId}:${threadKey}`;
    tx.objectStore(STORES.threads).put({ ...value, id: threadId, jobId, threadKey, updatedAt: now });
    messages.forEach((message, offset) => tx.objectStore(STORES.messages).put({ ...message, id: `${threadId}:message:${message.index || offset + 1}`, jobId, threadId, threadKey, updatedAt: now }));
    attachments.forEach((attachment, offset) => tx.objectStore(STORES.attachments).put({ ...attachment, id: `${threadId}:attachment:${attachment.messageIndex || 0}:${offset + 1}`, jobId, threadId, threadKey, updatedAt: now }));
    await transactionDone(tx);
    return value;
  }

  async function putDownload(value) {
    const id = value.id || `download-${value.downloadId || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return put(STORES.downloads, { ...value, id, updatedAt: new Date().toISOString() });
  }

  async function patchDownloadByChromeId(downloadId, patch) {
    const matches = await getAll(STORES.downloads, 'downloadId', IDBKeyRange.only(downloadId));
    if (!matches.length) return null;
    return putDownload({ ...matches[0], ...patch, downloadId });
  }

  async function getDownloadByChromeId(downloadId) {
    const matches = await getAll(STORES.downloads, 'downloadId', IDBKeyRange.only(downloadId));
    return matches[0] || null;
  }

  async function addEvent(jobId, type, detail = {}) {
    const createdAt = new Date().toISOString();
    return put(STORES.events, {
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      jobId,
      type,
      detail,
      createdAt
    });
  }

  async function deleteJob(jobId) {
    const db = await open();
    const storeNames = [STORES.jobs, STORES.threads, STORES.messages, STORES.attachments, STORES.downloads, STORES.events];
    const tx = db.transaction(storeNames, 'readwrite');
    tx.objectStore(STORES.jobs).delete(jobId);
    for (const storeName of [STORES.threads, STORES.messages, STORES.attachments, STORES.downloads, STORES.events]) {
      const index = tx.objectStore(storeName).index('jobId');
      const request = index.openKeyCursor(IDBKeyRange.only(jobId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        tx.objectStore(storeName).delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    await transactionDone(tx);
  }

  async function clearAll() {
    const db = await open();
    const names = Object.values(STORES);
    const tx = db.transaction(names, 'readwrite');
    names.forEach(name => tx.objectStore(name).clear());
    await transactionDone(tx);
  }

  async function clearStores(names) {
    const db = await open();
    const tx = db.transaction(names, 'readwrite');
    names.forEach(name => tx.objectStore(name).clear());
    await transactionDone(tx);
  }

  return {
    DB_NAME,
    DB_VERSION,
    STORES,
    open,
    putJob,
    getJob: jobId => get(STORES.jobs, jobId),
    patchJob,
    listJobs: () => getAll(STORES.jobs),
    putThread,
    putThreadBundle,
    getThreads: jobId => getAll(STORES.threads, 'jobId', IDBKeyRange.only(jobId)),
    getMessages: jobId => getAll(STORES.messages, 'jobId', IDBKeyRange.only(jobId)),
    getAttachments: jobId => getAll(STORES.attachments, 'jobId', IDBKeyRange.only(jobId)),
    putDownload,
    getDownloads: jobId => getAll(STORES.downloads, 'jobId', IDBKeyRange.only(jobId)),
    patchDownloadByChromeId,
    getDownloadByChromeId,
    putPreset: preset => put(STORES.presets, preset),
    listPresets: () => getAll(STORES.presets),
    deletePreset: presetId => deleteKey(STORES.presets, presetId),
    addEvent,
    getEvents: jobId => getAll(STORES.events, 'jobId', IDBKeyRange.only(jobId)),
    deleteJob,
    clearJobs: () => clearStores([STORES.jobs, STORES.threads, STORES.messages, STORES.attachments, STORES.downloads, STORES.events]),
    clearPresets: () => clearStores([STORES.presets]),
    clearAll
  };
});
