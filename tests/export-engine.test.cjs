const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/export-engine.js');

const envelope = { job: { name: 'Batch 001', isPartial: false }, exportedAt: '2026-01-01', totals: { matchedThreads: 1, capturedMessages: 1 }, threads: [{ threadKey: 'abc', subject: '<Invoice>', messages: [{ from: 'a@example.com', recipients: ['b@example.com'], date: '2026-01-01', bodyTextRaw: 'Amount (paid)' }] }] };

test('creates self-contained escaped printable HTML', () => {
  const html = engine.printableHtml(envelope);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;Invoice&gt;/);
  assert.doesNotMatch(html, /<Invoice>/);
  assert.match(html, /Search this local archive/);
});

test('round-trips a passphrase-encrypted local archive', async () => {
  const encrypted = await engine.encryptText('private mailbox record', 'correct horse battery staple');
  assert.equal(JSON.parse(encrypted).cipher, 'AES-256-GCM');
  assert.equal(await engine.decryptText(encrypted, 'correct horse battery staple'), 'private mailbox record');
  await assert.rejects(engine.decryptText(encrypted, 'incorrect passphrase'));
});

test('splits envelopes without losing or repeating ordered threads', () => {
  const source = { threads:[1,2,3,4,5].map(n => ({ threadKey:`t${n}` })), integrity:{ threads:[1,2,3,4,5].map(n => ({ threadKey:`t${n}`, sha256:`h${n}` })) } };
  const parts = engine.splitEnvelope(source, 2);
  assert.deepEqual(parts.map(part => part.threads.map(thread => thread.threadKey)), [['t1','t2'],['t3','t4'],['t5']]);
  assert.deepEqual(parts.map(part => part.part), [{index:1,count:3},{index:2,count:3},{index:3,count:3}]);
  assert.deepEqual(parts.flatMap(part => part.integrity.threads.map(item => item.threadKey)), ['t1','t2','t3','t4','t5']);
});

test('creates a structurally complete basic PDF', () => {
  const pdf = engine.basicPdf(envelope);
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /xref/);
  assert.match(pdf, /%%EOF$/);
  assert.ok(pdf.includes('Amount \\(paid\\)'));
});

test('neutralizes spreadsheet formulas and escapes quotes in CSV', () => {
  assert.equal(engine.csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(engine.csvCell('ordinary'), '"ordinary"');
});

test('creates a deterministic safe classic ZIP package', () => {
  const zip = engine.zipArchive([
    { name:'archive.json', data:'{"ok":true}' },
    { name:'../unsafe/notes.txt', data:'hello' }
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(zip.length - 12, true), 2);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  const text = new TextDecoder().decode(zip);
  assert.match(text, /archive\.json/);
  assert.match(text, /unsafe\/notes\.txt/);
  assert.doesNotMatch(text, /\.\.\/unsafe/);
  assert.deepEqual(zip, engine.zipArchive([{ name:'archive.json', data:'{"ok":true}' }, { name:'../unsafe/notes.txt', data:'hello' }]));
});

test('creates safely named individual PDF entries without losing thread order', () => {
  const source = { job:{ name:'Batch' }, totals:{ matchedThreads:2, capturedMessages:2 }, threads:[
    { threadKey:'a', subject:'../Invoice: 1', messages:[{ bodyTextRaw:'one' }] },
    { threadKey:'b', subject:'Contract', messages:[{ bodyTextRaw:'two' }] }
  ] };
  const entries = engine.individualPdfEntries(source);
  assert.deepEqual(entries.map(entry => entry.threadKey), ['a','b']);
  assert.equal(entries[0].name, '00001 - __Invoice_ 1.pdf');
  assert.match(entries[0].data, /^%PDF-1\.4/);
  assert.match(entries[1].data, /%%EOF$/);
});

test('creates injection-safe reconstructed EML with UTF-8 content', () => {
  const source = { exportedAt:'2026-01-01T00:00:00Z', threads:[{ subject:'Résumé ✓\r\nBcc: attacker@example.com', messages:[{
    index:7, from:'Sender <sender@example.com>\r\nX-Evil: yes', recipients:['recipient@example.com'], date:'2026-01-02T03:04:05Z', bodyTextRaw:'Hello 🌍', attachments:[{ fileName:'résumé.pdf' }]
  }] }] };
  const entries = engine.emlEntries(source);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '00001 - Résumé ✓__Bcc_ attacker@example.com/message-001.eml');
  assert.match(entries[0].data, /X-InboxFoundry-Reconstructed: true/);
  assert.match(entries[0].data, /not original raw RFC 5322 source/);
  assert.match(entries[0].data, /From: Sender <sender@example\.com> X-Evil: yes\r\n/);
  assert.doesNotMatch(entries[0].data, /\r\nX-Evil:/);
  const body = entries[0].data.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Hello 🌍');
});

test('creates importable reconstructed MBOX records without exposing internal keys', () => {
  const source = { exportedAt:'2026-01-01T00:00:00Z', threads:[
    { threadKey:'private-thread-key', subject:'One', messages:[{ from:'Alice <alice@example.com>', date:'bad date', bodyTextRaw:'First' }] },
    { subject:'Two', messages:[{ from:'unknown sender', bodyTextRaw:'Second' }] }
  ] };
  const mbox = engine.reconstructedMbox(source);
  assert.equal((mbox.match(/^From /gm) || []).length, 2);
  assert.match(mbox, /^From alice@example\.com Thu Jan {2}1 00:00:00 2026\r$/m);
  assert.match(mbox, /Date: Thu, 01 Jan 2026 00:00:00 GMT/);
  assert.match(mbox, /From MAILER-DAEMON /);
  assert.doesNotMatch(mbox, /private-thread-key/);
  assert.equal((mbox.match(/X-InboxFoundry-Reconstructed: true/g) || []).length, 2);
});
