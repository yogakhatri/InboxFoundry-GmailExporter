const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../lib/path-safety.js');

test('sanitizes traversal, reserved device names, controls, and trailing dots', () => {
  assert.equal(paths.sanitizePart('../invoice:2026?.pdf'), '-invoice-2026-.pdf');
  assert.equal(paths.sanitizePart('CON.txt'), '_CON.txt');
  assert.equal(paths.sanitizePart(' report.  '), 'report');
  assert.equal(paths.sanitizePart('\u0000'), 'item');
});

test('creates safe bounded folder paths', () => {
  assert.equal(paths.sanitizeFolderPath('../../Client\\Matter'), 'folder/folder/Client/Matter');
  assert.ok(paths.sanitizePart('x'.repeat(500), 'item', 90).length <= 90);
});
