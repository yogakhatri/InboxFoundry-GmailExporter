const test = require('node:test');
const assert = require('node:assert/strict');
const { likelyDuplicateIds } = require('../lib/attachment-analysis.js');

test('keeps the first copy and needs a known size', () => {
  assert.deepEqual(likelyDuplicateIds([
    { id: 1, fileName: 'Report.pdf', sizeBytes: 10 },
    { id: 2, fileName: 'report.pdf', sizeBytes: 10 },
    { id: 3, fileName: 'report.pdf', sizeBytes: 11 },
    { id: 4, fileName: 'x.pdf' },
    { id: 5, fileName: 'x.pdf' }
  ]), [2]);
});
