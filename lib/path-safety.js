(function initPathSafety(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), pathSafety: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createPathSafety() {
  'use strict';

  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  // Keeps the relative path well under Windows' 260-character limit once the Downloads prefix is added.
  const MAX_RELATIVE_PATH = 180;

  function clean(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|~%]/g, '-')
      // Control characters, plus bidi overrides that can disguise a file extension.
      .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[. ]+|[. ]+$/g, '');
  }

  function guardReserved(value, fallback) {
    if (!value) return fallback;
    return RESERVED.test(value) ? `_${value}` : value;
  }

  function sanitizePart(value, fallback = 'item', maxLength = 60) {
    const text = clean(value).slice(0, maxLength).replace(/[. ]+$/g, '');
    return guardReserved(text, fallback);
  }

  /** Like sanitizePart, but a long name is shortened in the middle so its extension survives. */
  function sanitizeFileName(value, fallback = 'attachment', maxLength = 100) {
    const text = clean(value);
    if (text.length <= maxLength) return guardReserved(text, fallback);
    const dot = text.lastIndexOf('.');
    const extension = dot > 0 && text.length - dot <= 12 ? text.slice(dot) : '';
    const stem = text.slice(0, maxLength - extension.length).replace(/[. ]+$/g, '');
    return guardReserved(`${stem}${extension}`, fallback);
  }

  function sanitizeFolderPath(folder, fallback = 'Export') {
    const parts = String(folder ?? '')
      .split(/[\\/]+/)
      .map(part => clean(part))
      .filter(Boolean)
      .map(part => sanitizePart(part, 'folder'));
    return parts.length ? parts.join('/') : fallback;
  }

  /** Builds a Downloads-relative path, trimming folder names first so the file name stays intact. */
  function relativeDownloadPath(rootFolder, folder, fileName) {
    const rootPart = sanitizePart(rootFolder, 'InboxFoundry', 40);
    const file = sanitizeFileName(fileName);
    let parts = sanitizeFolderPath(folder, '').split('/').filter(Boolean);
    const length = () => [rootPart, ...parts, file].join('/').length;
    let limit = 60;
    while (length() > MAX_RELATIVE_PATH && limit > 12) {
      limit -= 8;
      const shortened = limit;
      parts = parts.map(part => sanitizePart(part, 'folder', shortened));
    }
    return [rootPart, ...parts, file].join('/');
  }

  return { sanitizePart, sanitizeFileName, sanitizeFolderPath, relativeDownloadPath, MAX_RELATIVE_PATH };
});
