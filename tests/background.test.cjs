const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const downloadPolicy = require('../lib/download-policy.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function harness(overrides = {}) {
  const listeners = { messages:[], created:[], changed:[], erased:[], determining:[], removed:[] };
  const resumed = [];
  const saved = [];
  const rows = overrides.rows || [];
  const jobStore = {
    listJobs: async () => [], patchJob: async () => {},
    getDownloads: async () => rows,
    putDownload: async value => { saved.push(value); return value; },
    getDownloadByChromeId: async id => rows.find(row => row.downloadId === id) || null,
    patchDownloadByChromeId: async () => null,
    ...overrides.jobStore
  };
  const chrome = {
    runtime: {
      lastError:null,
      onInstalled:{ addListener() {} },
      onMessage:{ addListener(fn) { listeners.messages.push(fn); } }
    },
    sidePanel:{ setPanelBehavior:async () => {}, open:async () => {} },
    tabs:{ onRemoved:{ addListener(fn) { listeners.removed.push(fn); } } },
    storage:{ local:{ remove:async () => {}, get:async () => ({}) } },
    downloads:{
      search: async ({ id }) => overrides.downloadItems?.filter(item => item.id === id) || [],
      resume: async id => { resumed.push(id); },
      download: overrides.download || ((_options, callback) => callback(99)),
      onCreated:{ addListener(fn) { listeners.created.push(fn); } },
      onChanged:{ addListener(fn) { listeners.changed.push(fn); } },
      onErased:{ addListener(fn) { listeners.erased.push(fn); } },
      onDeterminingFilename:{ addListener(fn) { listeners.determining.push(fn); } }
    }
  };
  const context = vm.createContext({
    chrome, console:{ ...console, error:() => {} }, URL, Map, Date, Math,
    setInterval:() => 1,
    importScripts:() => {},
    InboxFoundry:{
      jobStore,
      pathSafety:{ sanitizePart:value => String(value || 'fallback'), sanitizeFolderPath:value => String(value || 'fallback') },
      downloadPolicy
    }
  });
  vm.runInContext(source, context, { filename:'background.js' });

  async function message(msg) {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of listeners.messages) {
        const result = listener(msg, { tab:{ id:7, windowId:1 } }, resolve);
        if (result === true) handled = true;
      }
      if (!handled) reject(new Error(`No handler for ${msg.type}`));
      setTimeout(() => reject(new Error(`Timed out handling ${msg.type}`)), 1000).unref?.();
    });
  }

  return { listeners, message, resumed, saved };
}

test('selective retry resumes only chosen interrupted Chrome tasks', async () => {
  const rows = [
    { id:'a', state:'interrupted', downloadId:11 },
    { id:'b', state:'interrupted', downloadId:12 },
    { id:'c', state:'complete', downloadId:13 }
  ];
  const h = harness({ rows, downloadItems:[
    { id:11, state:'interrupted', canResume:true, exists:true },
    { id:12, state:'interrupted', canResume:true, exists:true }
  ] });
  const result = await h.message({ type:'RETRY_INTERRUPTED_DOWNLOADS', jobId:'job', taskIds:['b','c'] });
  assert.equal(result.ok, true);
  assert.equal(result.requested, 1);
  assert.equal(result.resumed, 1);
  assert.deepEqual(h.resumed, [12]);
  assert.equal(h.saved.at(-1).state, 'in_progress');
});

test('direct downloads report a started-but-uncheckpointed failure', async () => {
  const h = harness({ jobStore:{
    listJobs:async () => [], getDownloads:async () => [],
    putDownload:async () => { throw new Error('quota'); },
    getDownloadByChromeId:async () => null, patchDownloadByChromeId:async () => null
  } });
  const result = await h.message({ type:'DIRECT_DOWNLOAD', url:'https://mail.google.com/file', jobId:'job', taskId:'opaque', fileName:'file.pdf', folder:'Batch' });
  assert.equal(result.ok, false);
  assert.equal(result.downloadStarted, true);
  assert.equal(result.downloadId, 99);
});

test('click downloads become visible only after their durable checkpoint succeeds', async () => {
  let release;
  const checkpoint = new Promise(resolve => { release = resolve; });
  const h = harness({ jobStore:{
    listJobs:async () => [], getDownloads:async () => [],
    putDownload:async value => { await checkpoint; h.saved.push(value); return value; },
    getDownloadByChromeId:async () => null, patchDownloadByChromeId:async () => null
  } });
  const prepared = await h.message({ type:'PREPARE_CLICK_DOWNLOAD', jobId:'job', taskId:'opaque', fileName:'file.pdf', folder:'Batch' });
  h.listeners.created[0]({ id:55, url:'https://mail.google.com/file', filename:'file.pdf', exists:true });
  const before = await h.message({ type:'CHECK_CLICK_DOWNLOAD', token:prepared.token });
  assert.equal(before.created, false);
  release();
  await checkpoint;
  await new Promise(resolve => setImmediate(resolve));
  const after = await h.message({ type:'CHECK_CLICK_DOWNLOAD', token:prepared.token });
  assert.equal(after.created, true);
  assert.equal(after.persisted, true);
  assert.equal(after.downloadId, 55);
});

test('filename routing recovers from IndexedDB after a service-worker restart', async () => {
  const h = harness({ rows:[{ id:'task', downloadId:77, rootFolder:'InboxFoundry', folder:'Batch/Message-001', fileName:'saved.pdf' }] });
  const suggestion = await new Promise(resolve => {
    const keepAlive = h.listeners.determining[0]({ id:77, filename:'actual.pdf' }, resolve);
    assert.equal(keepAlive, true);
  });
  assert.equal(suggestion.filename, 'InboxFoundry/Batch/Message-001/actual.pdf');
  assert.equal(suggestion.conflictAction, 'uniquify');
});
