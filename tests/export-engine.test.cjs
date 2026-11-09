const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const engine = require('../lib/export-engine.js');

const record = (over = {}) => ({
  recordId: 'record-1', subject: 'Résumé ✓\r\nBcc: attacker@example.com',
  messages: [
    { index: 1, messageId: 'abc123', from: 'sender@example.com', fromName: 'Zoë', recipients: ['r@example.com'], dateIso: '2026-01-02T03:04:05.000Z', bodyTextRaw: 'Hello 🌍', bodyHtmlRaw: '<b>Hello</b>', attachments: [{ fileName: 'résumé.pdf' }] },
    { index: 2, messageId: 'def456', from: 'other@example.com', recipients: [], dateIso: null, bodyTextRaw: 'Second' }
  ],
  ...over
});
const envelope = { formatVersion: 3, job: { name: 'Batch', isPartial: false }, exportedAt: '2026-11-09T00:00:00.000Z', totals: { matchedThreads: 1, messages: 2 } };
async function join(chunks) {
  let text = '';
  for await (const piece of chunks) text += piece;
  return text;
}
const unzipEntries = async blob => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const entries = {};
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    entries[name] = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    offset += 30 + nameLength + size;
  }
  return entries;
};

test('streamed JSON parses and its hashes verify', async () => {
  const text = await join(engine.jsonChunks(envelope, [record(), record({ recordId: 'record-2' })]));
  const parsed = JSON.parse(text);
  assert.equal(parsed.threads.length, 2);
  assert.equal(parsed.job.name, 'Batch');
  assert.equal(parsed.integrity.threads[1].sha256, createHash('sha256').update(JSON.stringify(parsed.threads[1])).digest('hex'));
  assert.equal(JSON.parse(await join(engine.jsonChunks(envelope, []))).threads.length, 0);
});

test('HTML escapes mail and carries no mail markup', async () => {
  const html = await join(engine.htmlChunks(envelope, [record({ subject: '<script>alert(1)</script>' })]));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>Hello/);
  assert.match(html, /Hello 🌍/);
  assert.match(html, /save as PDF/);
});

test('CSV neutralizes formulas, including after spaces, and handles quotes and missing bodies', async () => {
  assert.equal(engine.csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(engine.csvCell('  =1+1'), '"\'  =1+1"');
  assert.equal(engine.csvCell('ordinary'), '"ordinary"');
  assert.equal(engine.csvCell(undefined), '""');
  const csv = await join(engine.messagesCsvChunks([{ recordId: 'r', subject: 's', messages: [{ index: 1, from: 'a@b.c' }] }]));
  assert.ok(csv.startsWith('﻿'));
  assert.doesNotMatch(csv, /undefined/);
});

test('rebuilt EML: injection-safe, UTF-8, threaded, honest about estimates', () => {
  const thread = record();
  const context = { exportedAt: '2026-11-09T00:00:00.000Z', jobId: 'job-1' };
  const first = engine.reconstructedEml(thread, thread.messages[0], context);
  assert.doesNotMatch(first, /\r\nBcc:/);
  assert.match(first, /From: =\?UTF-8\?B\?.*\?= <sender@example\.com>\r\n/);
  assert.match(first, /Date: Fri, 02 Jan 2026 03:04:05 GMT/);
  assert.match(first, /multipart\/alternative/);
  assert.match(first, /X-InboxFoundry-Reconstructed: true/);
  assert.doesNotMatch(first, /Date-Estimated/);
  const second = engine.reconstructedEml(thread, thread.messages[1], context);
  assert.match(second, /In-Reply-To: <inboxfoundry-abc123@local\.invalid>/);
  assert.match(second, /X-InboxFoundry-Date-Estimated: true/);
  const body = second.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Second');
});

test('Message-IDs differ between batches when Gmail IDs are withheld', () => {
  const thread = { recordId: 'record-000001', subject: 's', messages: [{ index: 1, from: 'a@b.c', bodyTextRaw: 'x' }] };
  const id = job => engine.reconstructedEml(thread, thread.messages[0], { jobId: job }).match(/Message-ID: (.*)\r/)[1];
  assert.notEqual(id('job-1'), id('job-2'));
});

test('MBOX has one record per message and never a date from nowhere', async () => {
  const mbox = await join(engine.mboxChunks([record()], { exportedAt: '2026-11-09T00:00:00.000Z', jobId: 'j' }));
  assert.equal((mbox.match(/^From /gm) || []).length, 2);
  assert.match(mbox, /^From sender@example\.com Fri Jan {2}2 03:04:05 2026\r$/m);
});

test('ZIP entries are safe, unique, deterministic, and checksummed', async () => {
  const build = async () => {
    const zip = new engine.ZipBuilder();
    await zip.add('archive.json', '{"ok":true}');
    await zip.add('../unsafe/notes.txt', 'hello');
    await zip.add('archive.json', 'second');
    await zip.add('bytes.bin', (async function* pieces() { yield 'caf'; yield new Uint8Array([0xc3, 0xa9]); })());
    await zip.addChecksums();
    return zip.finish();
  };
  const blob = await build();
  const entries = await unzipEntries(blob);
  assert.deepEqual(Object.keys(entries), ['archive.json', 'unsafe/notes.txt', 'archive (2).json', 'bytes.bin', 'CHECKSUMS.sha256']);
  assert.equal(new TextDecoder().decode(entries['bytes.bin']), 'café');
  const sums = new TextDecoder().decode(entries['CHECKSUMS.sha256']);
  assert.ok(sums.includes(`${createHash('sha256').update('hello').digest('hex')}  unsafe/notes.txt`));
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(await (await build()).arrayBuffer()));
  assert.throws(() => new engine.ZipBuilder().finish(), /at least one/);
});

test('encryption round-trips across chunks and rejects tampering', async () => {
  const plain = new Blob([new Uint8Array(1000).fill(7), 'tail']);
  const options = { chunkSize: 256, iterations: 1000 };
  const encrypted = await engine.encryptBlob(plain, 'correct horse battery', options);
  const round = await engine.decryptBlob(encrypted, 'correct horse battery');
  assert.deepEqual(new Uint8Array(await round.blob.arrayBuffer()), new Uint8Array(await plain.arrayBuffer()));
  await assert.rejects(engine.decryptBlob(encrypted, 'wrong passphrase'));
  await assert.rejects(engine.decryptBlob(encrypted.slice(0, encrypted.size - 300), 'correct horse battery'));
  const bytes = new Uint8Array(await encrypted.arrayBuffer());
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(engine.decryptBlob(new Blob([bytes]), 'correct horse battery'));
  await assert.rejects(engine.encryptBlob(plain, 'short'));
  await assert.rejects(engine.decryptBlob(new Blob(['not encrypted']), 'correct horse battery'), /not an InboxFoundry/);
  assert.ok(engine.PBKDF2_ITERATIONS >= 600000);
  const empty = await engine.encryptBlob(new Blob([]), 'correct horse battery', options);
  assert.equal((await engine.decryptBlob(empty, 'correct horse battery')).blob.size, 0);
});
