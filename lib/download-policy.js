(function initDownloadPolicy(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), downloadPolicy: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createDownloadPolicy() {
  'use strict';

  const STARTED_STATES = new Set(['in_progress', 'complete', 'interrupted']);
  const FAILURE_STATES = new Set(['failed', 'interrupted']);

  function summarize(rows = []) {
    const values = Array.isArray(rows) ? rows : [];
    const count = state => values.filter(row => row?.state === state).length;
    return {
      total: values.length,
      queued: count('queued'),
      started: values.filter(row => STARTED_STATES.has(row?.state)).length,
      complete: count('complete'),
      interrupted: count('interrupted'),
      failed: count('failed'),
      erased: count('erased'),
      problems: values.filter(row => FAILURE_STATES.has(row?.state)).length
    };
  }

  function retryCandidates(rows = [], taskIds) {
    const selected = Array.isArray(taskIds) ? new Set(taskIds.map(String)) : null;
    return (Array.isArray(rows) ? rows : []).filter(row =>
      row?.state === 'interrupted' &&
      Number.isInteger(row.downloadId) &&
      (!selected || selected.has(String(row.id)))
    );
  }

  return { summarize, retryCandidates };
});
