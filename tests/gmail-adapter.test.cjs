const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../lib/gmail-adapter.js');

test('parseView separates the list from page and open conversation', () => {
  const thread = 'FMfcgzQfBZdVqKZcSVBhqwWLKWCtDdWQ';
  assert.deepEqual(adapter.parseView('#inbox'), { base: '#inbox', page: 1 });
  assert.deepEqual(adapter.parseView('#inbox/p3'), { base: '#inbox', page: 3 });
  assert.deepEqual(adapter.parseView(`#inbox/p3/${thread}`), { base: '#inbox', page: 3 });
  assert.deepEqual(adapter.parseView(`#inbox/${thread}`), { base: '#inbox', page: 1 });
  assert.deepEqual(adapter.parseView('#search/invoice'), { base: '#search/invoice', page: 1 });
  assert.deepEqual(adapter.parseView('#search/abcdefghijklmnopqrstuvwxyz'), { base: '#search/abcdefghijklmnopqrstuvwxyz', page: 1 });
  assert.deepEqual(adapter.parseView(`#search/invoice/p2/${thread}`), { base: '#search/invoice', page: 2 });
  assert.deepEqual(adapter.parseView('#label/Work%2FClients/p2'), { base: '#label/Work%2FClients', page: 2 });
  assert.deepEqual(adapter.parseView('#search/p2'), { base: '#search/p2', page: 1 });
  assert.deepEqual(adapter.parseView(''), { base: '#inbox', page: 1 });
});

test('comparableBase treats re-encoded searches as the same', () => {
  assert.equal(adapter.comparableBase('#search/from%3Aa%20has%3Aattachment'), adapter.comparableBase('#search/from:a+has:attachment'));
  assert.equal(adapter.comparableBase('#search/%E0%A4'), '#search/%e0%a4');
});

test('sizes parse in several languages and ignore numbers in file names', () => {
  assert.equal(adapter.parseSizeBytes('24 KB'), 24576);
  assert.equal(adapter.parseSizeBytes('1,5 Mo'), 1572864);
  assert.equal(adapter.parseSizeBytes('1.5 MB'), 1572864);
  assert.equal(adapter.parseSizeBytes('2 ГБ'), 2147483648);
  assert.equal(adapter.parseSizeBytes('1,024 KB'), 1048576);
  assert.equal(adapter.parseSizeBytes('10 MB plan.pdf 300 KB'), 307200);
  assert.equal(adapter.parseSizeBytes('no size'), null);
});

test('only Gmail hosts may be downloaded from directly', () => {
  assert.equal(adapter.isAllowedDownloadUrl('https://mail.google.com/mail/u/0?view=att'), true);
  assert.equal(adapter.isAllowedDownloadUrl('https://mail-attachment.googleusercontent.com/x'), true);
  for (const bad of ['http://mail.google.com/x', 'https://sites.google.com/x', 'https://drive.google.com/uc', 'https://evil.test/mail.google.com', 'javascript:alert(1)', '', null]) {
    assert.equal(adapter.isAllowedDownloadUrl(bad), false, String(bad));
  }
});

test('waiting allows far longer in a hidden tab, where Gmail itself renders slowly', async () => {
  const stubs = { documentRef: {}, locationRef: { hash: '' }, historyRef: {}, sleep: () => new Promise(resolve => setTimeout(resolve, 5)) };
  const readyAfter = ms => {
    const start = Date.now();
    return () => (Date.now() - start >= ms ? 'ready' : null);
  };
  const visible = adapter.create({ ...stubs, isHidden: () => false });
  assert.equal(await visible.waitFor(readyAfter(100), 20, 5), null);
  const hidden = adapter.create({ ...stubs, isHidden: () => true });
  assert.equal(await hidden.waitFor(readyAfter(100), 20, 5), 'ready');
});

test('waiting always checks several times, even when timers are slower than the timeout', async () => {
  let checks = 0;
  const slow = adapter.create({ documentRef: {}, locationRef: { hash: '' }, historyRef: {}, sleep: () => new Promise(resolve => setTimeout(resolve, 30)) });
  assert.equal(await slow.waitFor(() => { checks++; return null; }, 1, 30), null);
  assert.ok(checks >= 3);
});
