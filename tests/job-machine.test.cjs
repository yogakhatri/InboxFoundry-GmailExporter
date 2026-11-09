const test = require('node:test');
const assert = require('node:assert/strict');
const machine = require('../lib/job-machine.js');

test('allows the real lifecycle and refuses shortcuts', () => {
  let job = { status: 'draft' };
  job = machine.transition(job, 'running');
  assert.ok(job.startedAt);
  job = machine.transition(job, 'ready');
  assert.ok(job.scanFinishedAt);
  job = machine.transition(job, 'downloading');
  assert.equal(machine.isActive(job), true);
  const finished = job.scanFinishedAt;
  job = machine.transition(job, 'ready');
  assert.equal(job.scanFinishedAt, finished);
  assert.throws(() => machine.transition({ status: 'ready' }, 'pausing'), /Invalid job transition/);
  assert.throws(() => machine.transition({ status: 'draft' }, 'ready'), /Invalid job transition/);
});

test('a job stopped with Stop, a limit, or a failure can resume', () => {
  for (const status of ['stopped', 'interrupted', 'failed']) assert.equal(machine.isResumable({ status }), true);
  assert.equal(machine.isResumable({ status: 'ready' }), false);
  assert.equal(machine.canTransition('running', 'stopped'), true);
  assert.equal(machine.canTransition('pausing', 'stopped'), true);
});
