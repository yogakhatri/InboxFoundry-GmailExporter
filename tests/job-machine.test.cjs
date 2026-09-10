const test = require('node:test');
const assert = require('node:assert/strict');
const machine = require('../lib/job-machine.js');

test('enforces the durable job lifecycle', () => {
  let job = { id: 'job-1', status: 'draft', startedAt: null };
  job = machine.transition(job, 'validating');
  job = machine.transition(job, 'running');
  assert.ok(job.startedAt);
  job = machine.transition(job, 'pausing');
  job = machine.transition(job, 'stopped');
  assert.ok(job.stoppedAt);
  job = machine.transition(job, 'running');
  job = machine.transition(job, 'completed');
  assert.ok(job.completedAt);
});

test('rejects impossible transitions', () => {
  assert.throws(() => machine.transition({ status: 'completed' }, 'running'), /Invalid job transition/);
  assert.equal(machine.canTransition('running', 'failed'), true);
  assert.equal(machine.canTransition('completed', 'running'), false);
});
