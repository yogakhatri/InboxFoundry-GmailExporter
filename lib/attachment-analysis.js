(function initAttachmentAnalysis(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), attachmentAnalysis: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createAttachmentAnalysis() {
  'use strict';

  function nameParts(fileName) {
    const normalized = String(fileName || 'attachment').normalize('NFKC').trim();
    const dot = normalized.lastIndexOf('.');
    return dot > 0 ? { stem:normalized.slice(0, dot), extension:normalized.slice(dot + 1).toLowerCase() } : { stem:normalized, extension:'' };
  }

  function comparisonName(fileName) {
    return String(fileName || 'attachment').normalize('NFKC').trim().toLocaleLowerCase();
  }

  function versionFamily(fileName) {
    const { stem, extension } = nameParts(fileName);
    const family = stem.toLocaleLowerCase()
      .replace(/\s*\(\d+\)\s*$/u, '')
      .replace(/[\s._-]+(?:copy|draft|final)(?:[\s._-]*\d+)?\s*$/iu, '')
      .replace(/[\s._-]+(?:v(?:ersion)?|rev(?:ision)?)[\s._-]*[a-z0-9]+(?:\.[0-9]+)*\s*$/iu, '')
      .replace(/[\s._-]+$/u, '')
      .trim();
    return `${family || stem.toLocaleLowerCase()}|${extension}`;
  }

  function compactItem(item, index) {
    return {
      ordinal:index + 1,
      fileName:String(item?.fileName || item?.name || 'attachment'),
      sizeBytes:Number.isFinite(Number(item?.sizeBytes)) ? Number(item.sizeBytes) : null,
      threadKey:item?.threadKey || null,
      messageIndex:item?.messageIndex ?? null
    };
  }

  function grouped(items, keyFor) {
    const map = new Map();
    items.forEach((item, index) => {
      const key = keyFor(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(compactItem(item, index));
    });
    return [...map.entries()].filter(([, values]) => values.length > 1);
  }

  function analyze(input = []) {
    const items = Array.isArray(input) ? input : [];
    const duplicates = grouped(items, item => {
      const size = Number.isFinite(Number(item?.sizeBytes)) ? Number(item.sizeBytes) : 'unknown';
      return `${comparisonName(item?.fileName || item?.name)}|${size}`;
    }).map(([key, values], index) => ({
      id:`duplicate-${index + 1}`,
      confidence:values[0].sizeBytes == null ? 'name-only' : 'name-and-size',
      key,
      items:values
    }));

    const versions = grouped(items, item => versionFamily(item?.fileName || item?.name))
      .filter(([, values]) => new Set(values.map(value => comparisonName(value.fileName))).size > 1)
      .map(([family, values], index) => ({ id:`version-${index + 1}`, family, items:values }));

    return {
      method:'filename-and-known-size-metadata',
      contentHashesAvailable:false,
      totalFiles:items.length,
      duplicateCandidateGroups:duplicates,
      versionCandidateGroups:versions
    };
  }

  return { nameParts, comparisonName, versionFamily, analyze };
});
