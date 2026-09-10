(function initJobMachine(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), jobMachine: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createJobMachine() {
  'use strict';
  const STATES = Object.freeze(['draft','validating','running','pausing','paused','stopped','completed','failed','cancelled','interrupted']);
  const TRANSITIONS = Object.freeze({
    draft: ['validating','cancelled'], validating: ['running','failed','cancelled'],
    running: ['pausing','completed','failed','interrupted','cancelled'],
    pausing: ['paused','stopped','failed','interrupted'], paused: ['running','stopped','cancelled'],
    stopped: ['validating','running','cancelled'], failed: ['validating','running','cancelled'],
    interrupted: ['validating','running','cancelled'], completed: [], cancelled: []
  });
  function canTransition(from, to) { return STATES.includes(to) && (TRANSITIONS[from] || []).includes(to); }
  function transition(job, next, detail = {}) {
    const from = job?.status || 'draft';
    if (from === next) return { ...job, ...detail, updatedAt: new Date().toISOString() };
    if (!canTransition(from, next)) throw new Error(`Invalid job transition: ${from} -> ${next}`);
    const now = new Date().toISOString();
    const timestamps = {};
    if (next === 'running' && !job.startedAt) timestamps.startedAt = now;
    if (next === 'stopped') timestamps.stoppedAt = now;
    if (next === 'completed') timestamps.completedAt = now;
    if (next === 'cancelled') timestamps.cancelledAt = now;
    return { ...job, ...detail, ...timestamps, status: next, updatedAt: now };
  }
  return { STATES, TRANSITIONS, canTransition, transition };
});
