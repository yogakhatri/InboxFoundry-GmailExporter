const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const sha256 = require('../lib/sha256.js');

test('matches standard vectors and arbitrary chunk boundaries', () => {
  assert.equal(sha256.hashBytes(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256.hashBytes(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const bytes = new Uint8Array(randomBytes(100003));
  const hasher = new sha256.Hasher();
  for (let offset = 0; offset < bytes.length; offset += 997) hasher.update(bytes.subarray(offset, offset + 997));
  assert.equal(hasher.digestHex(), createHash('sha256').update(bytes).digest('hex'));
});
