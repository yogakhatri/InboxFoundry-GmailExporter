const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../lib/path-safety.js');

test('removes traversal, reserved names, and disguised extensions', () => {
  assert.equal(paths.sanitizeFolderPath('../../Client\\Matter'), 'Client/Matter');
  assert.equal(paths.sanitizePart('CON.txt'), '_CON.txt');
  assert.equal(paths.sanitizeFileName('a<>:"|?*.pdf'), 'a-------.pdf');
  assert.equal(paths.sanitizeFileName('invoice‮fdp.exe'), 'invoicefdp.exe');
  assert.equal(paths.sanitizeFileName('...'), 'attachment');
  assert.equal(paths.sanitizeFileName(''), 'attachment');
});

test('long names keep their extension and whole paths stay short', () => {
  const name = paths.sanitizeFileName(`${'x'.repeat(300)}.pdf`);
  assert.ok(name.endsWith('.pdf') && name.length <= 100);
  const full = paths.relativeDownloadPath('InboxFoundry', `Batch 001/${'s'.repeat(200)}/Message-001`, `${'y'.repeat(300)}.xlsx`);
  assert.ok(full.length <= paths.MAX_RELATIVE_PATH, `${full.length}`);
  assert.ok(full.endsWith('.xlsx'));
  assert.ok(full.startsWith('InboxFoundry/'));
});
