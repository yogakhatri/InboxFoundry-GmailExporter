const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/download-policy.js');

const rows = [
  { id:'queued', state:'queued' },
  { id:'active', state:'in_progress', downloadId:1 },
  { id:'done', state:'complete', downloadId:2 },
  { id:'resume-a', state:'interrupted', downloadId:3 },
  { id:'resume-b', state:'interrupted', downloadId:4 },
  { id:'failed', state:'failed' },
  { id:'erased', state:'erased', downloadId:5 }
];

test('summarizes durable download states without calling queued files started', () => {
  assert.deepEqual(policy.summarize(rows), {
    total:7, queued:1, started:4, complete:1, interrupted:2, failed:1, erased:1, problems:3
  });
});

test('selects only resumable-state tasks and honors an explicit task selection', () => {
  assert.deepEqual(policy.retryCandidates(rows).map(row => row.id), ['resume-a','resume-b']);
  assert.deepEqual(policy.retryCandidates(rows, ['resume-b','done']).map(row => row.id), ['resume-b']);
  assert.deepEqual(policy.retryCandidates(rows, []).map(row => row.id), []);
});
