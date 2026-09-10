const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const sha256 = require('../lib/sha256.js');

test('matches standard SHA-256 vectors and arbitrary chunk boundaries', () => {
  assert.equal(sha256.hashBytes(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256.hashBytes(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const bytes = new Uint8Array(randomBytes(100003));
  const expected = createHash('sha256').update(bytes).digest('hex');
  const hasher = new sha256.Hasher();
  for (let offset = 0; offset < bytes.length; offset += 997) hasher.update(bytes.subarray(offset, offset + 997));
  assert.equal(hasher.digestHex(), expected);
});

function chunkedFile(bytes) {
  return { size:bytes.length, slice:(start, end) => ({ arrayBuffer:async () => bytes.slice(start, end).buffer }) };
}

test('hashes files incrementally with progress and bounded slices', async () => {
  const bytes = new Uint8Array(randomBytes(250000));
  const progress = [];
  const actual = await sha256.hashFile(chunkedFile(bytes), { chunkSize:65536, onProgress:value => progress.push(value.processedBytes) });
  assert.equal(actual, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(progress, [65536,131072,196608,250000]);
});

test('honors large-file limits and cancellation', async () => {
  const bytes = new Uint8Array(1000);
  await assert.rejects(sha256.hashFile(chunkedFile(bytes), { maxBytes:999 }), /hash-size-limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sha256.hashFile(chunkedFile(bytes), { signal:controller.signal }), /analysis-cancelled/);
});
