const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pathSafety = require('../lib/path-safety.js');
const gmailAdapter = require('../lib/gmail-adapter.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const hook = store => ({ addListener(fn) { store.push(fn); }, removeListener(fn) { store.splice(store.indexOf(fn), 1); }, hasListener(fn) { return store.includes(fn); } });

function harness(overrides = {}) {
  const listeners = { message: [], created: [], filename: [], changed: [], erased: [] };
  const attachments = new Map(Object.entries(overrides.attachments || {}));
  const jobStore = {
    listJobs: async () => overrides.jobs || [],
    patchJob: async (id, patch) => { (overrides.patched ||= []).push({ id, patch }); },
    getAttachment: async id => attachments.get(id),
    patchAttachment: async (id, patch) => attachments.set(id, { ...attachments.get(id), ...patch }),
    patchByChromeId: async () => null,
    ...overrides.jobStore
  };
  const calls = [];
  const chrome = {
    runtime: { id: 'ext', lastError: null, onInstalled: hook([]), onStartup: hook([]), onMessage: hook(listeners.message) },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { onRemoved: hook(overrides.removed || []) },
    downloads: {
      download(options, callback) {
        calls.push(options);
        const failure = overrides.failDownload?.(options, calls.length);
        chrome.runtime.lastError = failure ? { message: failure } : null;
        callback(failure ? undefined : 99);
        chrome.runtime.lastError = null;
      },
      onCreated: hook(listeners.created), onChanged: hook(listeners.changed), onErased: hook(listeners.erased), onDeterminingFilename: hook(listeners.filename)
    }
  };
  const context = vm.createContext({
    chrome, console: { ...console, error() {} }, URL, Date, Math, Map, Number, String, Promise, crypto: globalThis.crypto, setTimeout,
    importScripts() {}, InboxFoundry: { jobStore, pathSafety, gmailAdapter }
  });
  vm.runInContext(source, context);
  const message = (msg, sender = { id: 'ext', tab: { id: 7 } }) => new Promise(resolve => {
    const handled = listeners.message[0](msg, sender, resolve);
    if (!handled) resolve('not-handled');
  });
  return { listeners, message, calls, attachments };
}
const file = { id: 'a', url: 'https://mail.google.com/mail/u/0?view=att', rootFolder: 'InboxFoundry', folder: 'Batch/00001 - x/Message-001', fileName: 'report.pdf', messageIndex: 1, ordinal: 1 };

test('refuses unknown messages and other senders', async () => {
  const h = harness();
  assert.equal(await h.message({ type: 'DB_CLEAR_JOBS' }), 'not-handled');
  assert.equal(await h.message({ type: 'GET_CONTEXT' }, { id: 'someone-else' }), 'not-handled');
  assert.equal((await h.message({ type: 'GET_CONTEXT' })).result.tabId, 7);
});

test('direct download routes into the batch folder', async () => {
  const h = harness({ attachments: { a: file } });
  const { result } = await h.message({ type: 'START_DIRECT_DOWNLOAD', attachmentId: 'a' });
  assert.equal(result.ok, true);
  assert.equal(h.calls[0].filename, 'InboxFoundry/Batch/00001 - x/Message-001/report.pdf');
  assert.equal(h.calls[0].conflictAction, 'uniquify');
  assert.equal(h.attachments.get('a').state, 'in_progress');
});

test('a name Chrome refuses is saved under a plain name, not lost', async () => {
  const h = harness({ attachments: { a: file }, failDownload: (_options, call) => (call === 1 ? 'Invalid filename' : null) });
  const { result } = await h.message({ type: 'START_DIRECT_DOWNLOAD', attachmentId: 'a' });
  assert.equal(result.ok, true);
  assert.equal(h.calls[1].filename, 'InboxFoundry/Batch/attachment-1-1.pdf');
});

test('other download errors are reported, and non-Gmail URLs are never fetched', async () => {
  const h = harness({ attachments: { a: file, b: { ...file, url: 'https://evil.test/x' } }, failDownload: () => 'Network down' });
  assert.equal(JSON.stringify((await h.message({ type: 'START_DIRECT_DOWNLOAD', attachmentId: 'a' })).result), JSON.stringify({ ok: false, error: 'Network down' }));
  assert.equal(JSON.stringify((await h.message({ type: 'START_DIRECT_DOWNLOAD', attachmentId: 'b' })).result), JSON.stringify({ ok: false, needsClick: true }));
  assert.equal(h.calls.length, 1);
});

test('the filename listener exists only while a click route is open', async () => {
  const h = harness({ attachments: { a: file } });
  assert.equal(h.listeners.filename.length, 0);
  const { result } = await h.message({ type: 'PREPARE_CLICK_DOWNLOAD', attachmentId: 'a', ttlMs: 9000 });
  assert.equal(h.listeners.filename.length, 1);
  assert.equal(h.listeners.created.length, 1);

  // Another extension's download, and an unrelated site's, don't consume the route.
  h.listeners.created[0]({ id: 1, url: 'https://mail.google.com/x', byExtensionId: 'other' });
  h.listeners.created[0]({ id: 2, url: 'https://example.test/x', referrer: 'https://example.test' });
  assert.equal((await h.message({ type: 'CHECK_CLICK_DOWNLOAD', token: result.token })).result.created, false);

  h.listeners.created[0]({ id: 55, url: 'https://mail.google.com/mail/u/0?view=att', filename: '' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.attachments.get('a').downloadId, 55);
  const suggestion = await new Promise(resolve => h.listeners.filename[0]({ id: 55, filename: 'actual.pdf' }, resolve));
  assert.equal(suggestion.filename, 'InboxFoundry/Batch/00001 - x/Message-001/actual.pdf');
  const other = await new Promise(resolve => h.listeners.filename[0]({ id: 2, filename: 'mine.pdf' }, value => resolve(value ?? 'default')));
  assert.equal(other, 'default');
  assert.equal((await h.message({ type: 'CHECK_CLICK_DOWNLOAD', token: result.token })).result.created, true);
});
