const test = require('node:test');
const assert = require('node:assert/strict');
const analysis = require('../lib/attachment-analysis.js');

test('groups exact metadata duplicate candidates and reports confidence', () => {
  const result = analysis.analyze([
    { fileName:'Invoice.PDF', sizeBytes:1200, threadKey:'a' },
    { fileName:'invoice.pdf', sizeBytes:1200, threadKey:'b' },
    { fileName:'invoice.pdf', sizeBytes:1300, threadKey:'c' }
  ]);
  assert.equal(result.duplicateCandidateGroups.length, 1);
  assert.equal(result.duplicateCandidateGroups[0].confidence, 'name-and-size');
  assert.deepEqual(result.duplicateCandidateGroups[0].items.map(item => item.threadKey), ['a','b']);
  assert.equal(result.contentHashesAvailable, false);
});

test('groups common draft, final, version, revision, and copy filename families', () => {
  const result = analysis.analyze([
    { fileName:'Contract draft.docx' }, { fileName:'Contract final.docx' },
    { fileName:'Budget_v1.2.xlsx' }, { fileName:'Budget_version_2.xlsx' },
    { fileName:'Plan rev A.pdf' }, { fileName:'Plan revision-B.pdf' },
    { fileName:'Photo.jpg' }, { fileName:'Photo (1).jpg' }
  ]);
  assert.equal(result.versionCandidateGroups.length, 4);
});

test('does not label unrelated same-extension files as versions', () => {
  const result = analysis.analyze([{ fileName:'alpha.pdf' }, { fileName:'beta.pdf' }]);
  assert.equal(result.versionCandidateGroups.length, 0);
});
