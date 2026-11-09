(function initFilterEngine(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), filterEngine: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createFilterEngine() {
  'use strict';

  const TYPE_GROUPS = Object.freeze({
    pdf: ['pdf'],
    spreadsheet: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods', 'numbers'],
    document: ['doc', 'docx', 'rtf', 'odt', 'txt', 'pages', 'md'],
    presentation: ['ppt', 'pptx', 'odp', 'key'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'heic'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
    data: ['json', 'xml', 'yaml', 'yml', 'sql'],
    emailCalendarContact: ['eml', 'msg', 'ics', 'vcf'],
    audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
    video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']
  });
  const ALL_KNOWN_EXTENSIONS = new Set(Object.values(TYPE_GROUPS).flat());
  const CLUTTER_NAME = /(^|[\s_.-])(logo|signature|sig|icon|avatar|spacer|pixel|tracking|facebook|instagram|linkedin|twitter|x-logo)([\s_.-]|$)/i;

  function normalize(value, caseSensitive = false) {
    const text = String(value ?? '').normalize('NFKC');
    return caseSensitive ? text : text.toLocaleLowerCase();
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function matchSegmentAt(text, offset, segment) {
    if (offset + segment.length > text.length) return false;
    for (let index = 0; index < segment.length; index++) {
      if (segment[index] !== '?' && segment[index] !== text[offset + index]) return false;
    }
    return true;
  }

  function findSegment(text, from, segment) {
    for (let offset = from; offset + segment.length <= text.length; offset++) {
      if (matchSegmentAt(text, offset, segment)) return offset;
    }
    return -1;
  }

  /**
   * Linear-time wildcard match: * is any text including new lines, ? is one character.
   * Anchored compares the whole value (file names); otherwise the pattern may appear anywhere (email text).
   */
  function matchWildcard(text, pattern, anchored) {
    const segments = pattern.split('*');
    let position = 0;
    let first = 0;
    let last = segments.length - 1;
    if (anchored) {
      if (segments.length === 1) return text.length === pattern.length && matchSegmentAt(text, 0, pattern);
      if (!matchSegmentAt(text, 0, segments[0])) return false;
      const tail = segments[last];
      if (text.length - tail.length < segments[0].length || !matchSegmentAt(text, text.length - tail.length, tail)) return false;
      position = segments[0].length;
      first = 1;
      last -= 1;
    }
    const limit = anchored ? text.length - segments[segments.length - 1].length : text.length;
    for (let index = first; index <= last; index++) {
      const segment = segments[index];
      if (!segment) continue;
      const found = findSegment(text.slice(0, limit), position, segment);
      if (found < 0) return false;
      position = found + segment.length;
    }
    return true;
  }

  function matchesTerm(value, term, options = {}) {
    const caseSensitive = !!options.caseSensitive;
    const source = normalize(value, caseSensitive);
    const needle = normalize(term, caseSensitive);
    if (!needle) return false;
    if (options.matchType === 'wildcard') return matchWildcard(source, needle, !!options.anchored);
    if (options.matchType === 'exact') return source === needle;
    if (options.matchType === 'startsWith') return source.startsWith(needle);
    if (options.matchType === 'endsWith') return source.endsWith(needle);
    if (options.wholeWord) {
      const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(needle)}([^\\p{L}\\p{N}_]|$)`, 'u');
      return regex.test(source);
    }
    return source.includes(needle);
  }

  function listMatches(values, terms, mode, options) {
    if (!terms?.length) return true;
    const found = term => values.some(value => matchesTerm(value, term, options));
    return mode === 'all' ? terms.every(found) : terms.some(found);
  }

  function extensionFromName(fileName) {
    const clean = String(fileName ?? '').split(/[?#]/)[0];
    const index = clean.lastIndexOf('.');
    return index > -1 && index < clean.length - 1 ? clean.slice(index + 1).toLowerCase() : '';
  }

  function classifyAttachment(attachment = {}) {
    const extension = extensionFromName(attachment.fileName);
    const groups = Object.entries(TYPE_GROUPS).filter(([, values]) => values.includes(extension)).map(([group]) => group);
    if (extension && !ALL_KNOWN_EXTENSIONS.has(extension)) groups.push('other');
    if (!extension) groups.push('other');
    return { extension, groups };
  }

  function clutterReason(attachment, classification, rules) {
    if (rules.excludeClutter === false || !classification.groups.includes('image') || attachment.sizeBytes == null) return null;
    const size = Number(attachment.sizeBytes);
    if (size <= Number(rules.clutterMaxBytes ?? 4096)) return 'tiny-image';
    // A name alone is not enough: "signature page.jpg" at 900 KB is a real document.
    if (size <= Number(rules.clutterNameMaxBytes ?? 65536) && CLUTTER_NAME.test(attachment.fileName || '')) return 'common-clutter-name';
    return null;
  }

  function attachmentMatches(attachment, rules = {}) {
    const classification = classifyAttachment(attachment);
    const selected = rules.typeGroups || ['all'];
    const custom = rules.customExtensions || [];
    const typeMatched = selected.includes('all') || classification.groups.some(group => selected.includes(group)) ||
      custom.includes(classification.extension);
    if (!typeMatched) return { matched: false, classification, reasons: ['file-type'] };

    const clutter = clutterReason(attachment, classification, rules);
    if (clutter) return { matched: false, classification, reasons: [clutter] };

    const options = { matchType: rules.matchType || 'contains', caseSensitive: !!rules.caseSensitive, anchored: true };
    const name = attachment.fileName || '';
    if (!listMatches([name], rules.filenameInclude, rules.includeMode || 'any', options)) {
      return { matched: false, classification, reasons: ['filename-include'] };
    }
    if ((rules.filenameExclude || []).some(term => matchesTerm(name, term, options))) {
      return { matched: false, classification, reasons: ['filename-exclude'] };
    }
    if (attachment.sizeBytes != null) {
      const size = Number(attachment.sizeBytes);
      if (rules.minBytes != null && size < Number(rules.minBytes)) return { matched: false, classification, reasons: ['minimum-size'] };
      if (rules.maxBytes != null && size > Number(rules.maxBytes)) return { matched: false, classification, reasons: ['maximum-size'] };
    }
    return { matched: true, classification, reasons: ['attachment-rules'] };
  }

  function valuesForMessage(meta, message, fields) {
    const map = {
      subject: [meta.subject],
      sender: [message.from, message.fromName],
      recipients: message.recipients || [],
      headers: [message.rawHeaderText],
      body: [message.bodyTextRaw],
      html: [message.bodyHtmlRaw],
      attachmentNames: (message.attachments || []).map(item => item.fileName)
    };
    return (fields || []).flatMap(field => map[field] || []).filter(Boolean);
  }

  /** Returns true, false, or null when the message date could not be determined. */
  function dateMatches(message, from, to) {
    if (!from && !to) return true;
    const timestamp = Date.parse(message.dateIso || '');
    if (!Number.isFinite(timestamp)) return null;
    if (from && timestamp < Date.parse(`${from}T00:00:00`)) return false;
    if (to && timestamp > Date.parse(`${to}T23:59:59.999`)) return false;
    return true;
  }

  function evaluateThread(meta = {}, messages = [], config = {}) {
    const email = config.email || {};
    const rules = config.attachments || {};
    const options = { matchType: email.matchType || 'contains', caseSensitive: !!email.caseSensitive, wholeWord: !!email.wholeWord };

    const allAttachments = messages.flatMap(message => (message.attachments || []).map(attachment => ({ ...attachment, messageIndex: message.index })));
    const attachmentEvaluations = allAttachments.map(attachment => ({ attachment, ...attachmentMatches(attachment, rules) }));
    const matchedAttachments = attachmentEvaluations.filter(item => item.matched).map(item => item.attachment);

    const evaluations = messages.map(message => {
      const values = valuesForMessage(meta, message, email.fields);
      const dateResult = dateMatches(message, email.dateFrom, email.dateTo);
      return {
        index: message.index,
        included: listMatches(values, email.includeTerms, email.includeMode || 'any', options),
        excluded: (email.excludeTerms || []).some(term => values.some(value => matchesTerm(value, term, options))),
        dateResult
      };
    });
    const withinDate = item => item.dateResult !== false;

    const reasons = [];
    let contentMatched;
    if (email.ruleScope === 'thread') {
      const allValues = messages.flatMap(message => valuesForMessage(meta, message, email.fields));
      contentMatched = listMatches(allValues, email.includeTerms, email.includeMode || 'any', options) && evaluations.some(withinDate);
    } else {
      contentMatched = evaluations.some(item => item.included && !item.excluded && withinDate(item));
    }
    let matched = contentMatched;
    if (!contentMatched) reasons.push('email-rules');
    if (evaluations.some(item => item.excluded)) {
      matched = false;
      reasons.push('excluded-term');
    }
    const presence = email.attachmentPresence || 'any';
    if (presence === 'has' && !allAttachments.length) {
      matched = false;
      reasons.push('attachment-required');
    }
    if (presence === 'none' && allAttachments.length) {
      matched = false;
      reasons.push('attachment-not-allowed');
    }
    if (email.requireMatchingAttachment && !matchedAttachments.length) {
      matched = false;
      reasons.push('matching-attachment-required');
    }
    // An unreadable date is kept and flagged. Dropping real mail because of a display format would be silent loss.
    const dateUnverified = evaluations.some(item => item.dateResult === null);
    if (matched && dateUnverified) reasons.push('date-unverified');
    if (matched) reasons.push('matched');

    const matchedMessageIndexes = email.ruleScope === 'thread'
      ? (matched ? messages.map(message => message.index) : [])
      : evaluations.filter(item => item.included && !item.excluded && withinDate(item)).map(item => item.index);
    return { matched, reasons: [...new Set(reasons)], matchedMessageIndexes, matchedAttachments, attachmentEvaluations };
  }

  return { matchesTerm, classifyAttachment, attachmentMatches, evaluateThread };
});
