(function initAttachmentAnalysis(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), attachmentAnalysis: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createAttachmentAnalysis() {
  'use strict';

  function duplicateKey(item) {
    const size = Number.isFinite(Number(item?.sizeBytes)) && item?.sizeBytes != null ? Number(item.sizeBytes) : null;
    if (size === null) return null;
    return `${String(item?.fileName ?? '').normalize('NFKC').trim().toLocaleLowerCase()}|${size}`;
  }

  /** IDs of later files with the same name and known size as an earlier one, so the first copy is kept. */
  function likelyDuplicateIds(items = []) {
    const seen = new Set();
    const duplicates = [];
    for (const item of items) {
      const key = duplicateKey(item);
      if (key === null) continue;
      if (seen.has(key)) duplicates.push(item.id);
      else seen.add(key);
    }
    return duplicates;
  }

  return { likelyDuplicateIds };
});
