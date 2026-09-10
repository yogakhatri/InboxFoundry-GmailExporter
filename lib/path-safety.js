(function initPathSafety(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), pathSafety: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createPathSafety() {
  'use strict';
  function sanitizePart(value, fallback = 'item', maxLength = 150) {
    let cleaned = String(value || '').normalize('NFKC')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, maxLength)
      .replace(/[. ]+$/g, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
    return cleaned || fallback;
  }
  function sanitizeFolderPath(folder, fallback = 'Email Thread') {
    const parts = String(folder || fallback).split(/[\\/]+/).map(part => sanitizePart(part, 'folder', 90)).filter(Boolean);
    return parts.length ? parts.join('/') : fallback;
  }
  return { sanitizePart, sanitizeFolderPath };
});
