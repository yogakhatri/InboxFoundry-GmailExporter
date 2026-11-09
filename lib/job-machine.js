(function initJobMachine(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), jobMachine: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createJobMachine() {
  'use strict';

  // draft: created. running/pausing: scanning. ready: scan finished, can be reviewed and saved.
  // stopped/interrupted/failed: can be resumed, and whatever was captured can still be saved.
  // downloading: saving selected attachments.
  const TRANSITIONS = Object.freeze({
    draft: ['running', 'failed'],
    running: ['pausing', 'stopped', 'ready', 'failed', 'interrupted'],
    pausing: ['stopped', 'ready', 'failed', 'interrupted'],
    ready: ['downloading', 'running'],
    stopped: ['running', 'downloading'],
    interrupted: ['running', 'downloading'],
    failed: ['running', 'downloading'],
    downloading: ['ready', 'stopped', 'failed', 'interrupted']
  });
  const ACTIVE = Object.freeze(['running', 'pausing', 'downloading']);
  const RESUMABLE = Object.freeze(['stopped', 'interrupted', 'failed']);

  function canTransition(from, to) {
    return (TRANSITIONS[from] || []).includes(to);
  }

  function transition(job, next, detail = {}) {
    const from = job?.status || 'draft';
    if (from === next) return { ...job, ...detail };
    if (!canTransition(from, next)) throw new Error(`Invalid job transition: ${from} -> ${next}`);
    const now = new Date().toISOString();
    const stamps = {};
    if (next === 'running' && !job.startedAt) stamps.startedAt = now;
    if (next === 'stopped') stamps.stoppedAt = now;
    if (next === 'ready' && from !== 'downloading') stamps.scanFinishedAt = now;
    return { ...job, ...detail, ...stamps, status: next, updatedAt: now };
  }

  function isActive(job) {
    return ACTIVE.includes(job?.status);
  }

  function isResumable(job) {
    return RESUMABLE.includes(job?.status);
  }

  return { canTransition, transition, isActive, isResumable };
});
