(function initFilterEngine(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), filterEngine: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createFilterEngine() {
  'use strict';

  const TYPE_GROUPS = Object.freeze({
    pdf: ['pdf'],
    spreadsheet: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'],
    document: ['doc', 'docx', 'rtf', 'odt', 'txt'],
    presentation: ['ppt', 'pptx', 'odp'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'heic'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
    data: ['json', 'xml', 'yaml', 'yml', 'sql'],
    emailCalendarContact: ['eml', 'msg', 'ics', 'vcf'],
    audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
    video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']
  });

  const ALL_KNOWN_EXTENSIONS = new Set(Object.values(TYPE_GROUPS).flat());

  function normalize(value, caseSensitive = false) {
    const text = String(value ?? '').normalize('NFKC');
    return caseSensitive ? text : text.toLocaleLowerCase();
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function safeRegex(pattern, flags = '') {
    const source = String(pattern || '');
    if (!source || source.length > 200) return null;
    if (/\(\?<[=!]/.test(source) || /\([^)]*[+*][^)]*\)[+*{]/.test(source)) return null;
    try {
      return new RegExp(source, flags);
    } catch (_) {
      return null;
    }
  }

  function matchesTerm(value, term, options = {}) {
    const caseSensitive = !!options.caseSensitive;
    const source = normalize(value, caseSensitive);
    const needle = normalize(term, caseSensitive);
    if (!needle) return false;

    if (options.matchType === 'regex') {
      const regex = safeRegex(String(term), caseSensitive ? '' : 'i');
      return !!regex?.test(String(value ?? ''));
    }

    if (options.matchType === 'wildcard') {
      const regex = new RegExp(`^${escapeRegex(needle).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`, caseSensitive ? '' : 'i');
      return regex.test(String(value ?? ''));
    }

    if (options.matchType === 'exact') return source === needle;
    if (options.matchType === 'startsWith') return source.startsWith(needle);
    if (options.matchType === 'endsWith') return source.endsWith(needle);
    if (options.wholeWord) {
      const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(needle)}([^\\p{L}\\p{N}_]|$)`, caseSensitive ? 'u' : 'iu');
      return regex.test(String(value ?? ''));
    }
    return source.includes(needle);
  }

  function listMatches(values, terms, mode, options) {
    const cleanTerms = (terms || []).filter(Boolean);
    if (!cleanTerms.length) return true;
    const haystacks = (values || []).map(value => String(value ?? ''));
    const result = term => haystacks.some(value => matchesTerm(value, term, options));
    return mode === 'all' ? cleanTerms.every(result) : cleanTerms.some(result);
  }

  function extensionFromName(fileName) {
    const clean = String(fileName || '').split(/[?#]/)[0];
    const index = clean.lastIndexOf('.');
    return index > -1 && index < clean.length - 1 ? clean.slice(index + 1).toLowerCase() : '';
  }

  function classifyAttachment(attachment = {}) {
    const extension = extensionFromName(attachment.fileName || attachment.name);
    const groups = Object.entries(TYPE_GROUPS)
      .filter(([, extensions]) => extensions.includes(extension))
      .map(([group]) => group);
    if (extension && !ALL_KNOWN_EXTENSIONS.has(extension)) groups.push('other');
    if (!extension) groups.push('unknown');
    return { extension, groups };
  }

  function attachmentMatches(attachment, rules = {}) {
    const classification = classifyAttachment(attachment);
    const selectedGroups = rules.typeGroups || ['all'];
    const custom = (rules.customExtensions || []).map(value => String(value).replace(/^\./, '').toLowerCase());
    const typeMatched = selectedGroups.includes('all') ||
      classification.groups.some(group => selectedGroups.includes(group)) ||
      custom.includes(classification.extension);

    if (!typeMatched) return { matched: false, classification, reasons: ['file-type'] };
    if (attachment.inline && rules.includeInline === false) return { matched: false, classification, reasons: ['inline-file'] };
    const name = attachment.fileName || attachment.name || '';
    const clutterName = /(^|[\s_.-])(logo|signature|sig|icon|avatar|spacer|pixel|tracking|facebook|instagram|linkedin|twitter|x-logo)([\s_.-]|$)/i.test(name);
    const clutterSize = attachment.sizeBytes != null && Number(attachment.sizeBytes) <= Number(rules.clutterMaxBytes || 4096);
    if (rules.excludeClutter !== false && classification.groups.includes('image') && (clutterName || clutterSize)) {
      return { matched: false, classification, reasons: [clutterName ? 'common-clutter-name' : 'tiny-image'] };
    }

    const options = {
      matchType: rules.matchType || 'contains',
      caseSensitive: !!rules.caseSensitive,
      wholeWord: false
    };
    if (!listMatches([name], rules.filenameInclude || [], rules.includeMode || 'any', options)) {
      return { matched: false, classification, reasons: ['filename-include'] };
    }
    if ((rules.filenameExclude || []).some(term => matchesTerm(name, term, options))) {
      return { matched: false, classification, reasons: ['filename-exclude'] };
    }

    const size = Number(attachment.sizeBytes);
    if (Number.isFinite(size)) {
      if (rules.minBytes != null && rules.minBytes !== '' && Number.isFinite(Number(rules.minBytes)) && size < Number(rules.minBytes)) return { matched: false, classification, reasons: ['minimum-size'] };
      if (rules.maxBytes != null && rules.maxBytes !== '' && Number.isFinite(Number(rules.maxBytes)) && size > Number(rules.maxBytes)) return { matched: false, classification, reasons: ['maximum-size'] };
    } else if (rules.unknownSize === 'exclude' && (rules.minBytes != null || rules.maxBytes != null)) {
      return { matched: false, classification, reasons: ['unknown-size'] };
    }

    return { matched: true, classification, reasons: ['attachment-rules'] };
  }

  function valuesForMessage(meta, message, fields) {
    const attachments = message.attachments || [];
    const map = {
      subject: [meta.subject],
      sender: [message.from],
      recipients: message.recipients || [],
      headers: [message.rawHeaderText],
      body: [message.bodyTextRaw, message.bodyTextNormalized],
      html: [message.bodyHtmlRaw],
      attachmentNames: attachments.map(item => item.fileName || item.name),
      thread: [meta.subject, message.from, ...(message.recipients || []), message.rawHeaderText, message.bodyTextRaw]
    };
    return [...new Set((fields || []).flatMap(field => map[field] || []).filter(Boolean))];
  }

  function addressDomain(value) {
    const match = String(value || '').match(/@([^>\s,;]+)/);
    return match ? match[1].toLowerCase() : '';
  }

  function messagePassesAddressRules(message, rules) {
    const senders = [message.from || ''];
    const recipients = message.recipients || [];
    const addresses = [...senders, ...recipients];
    const domains = addresses.map(addressDomain).filter(Boolean);
    const opts = { matchType: 'contains', caseSensitive: false };
    if (!listMatches(senders, rules.senderInclude || [], 'any', opts)) return false;
    if ((rules.senderExclude || []).some(term => senders.some(value => matchesTerm(value, term, opts)))) return false;
    if (!listMatches(recipients, rules.recipientInclude || [], 'any', opts)) return false;
    if ((rules.recipientExclude || []).some(term => recipients.some(value => matchesTerm(value, term, opts)))) return false;
    if (!listMatches(domains, rules.domainInclude || [], 'any', opts)) return false;
    if ((rules.domainExclude || []).some(term => domains.some(value => matchesTerm(value, term, opts)))) return false;
    return true;
  }

  function dateMatches(value, from, to) {
    if (!from && !to) return true;
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isFinite(timestamp)) return false;
    if (from && timestamp < Date.parse(`${from}T00:00:00`)) return false;
    if (to && timestamp > Date.parse(`${to}T23:59:59.999`)) return false;
    return true;
  }

  function evaluateThread(meta = {}, messages = [], config = {}) {
    const email = config.email || {};
    const attachmentRules = config.attachments || {};
    const options = {
      matchType: email.matchType || 'contains',
      caseSensitive: !!email.caseSensitive,
      wholeWord: !!email.wholeWord
    };

    const allAttachments = messages.flatMap((message, messageOffset) =>
      (message.attachments || []).map((attachment, attachmentOffset) => ({
        ...attachment,
        messageIndex: message.index || messageOffset + 1,
        attachmentIndex: attachmentOffset + 1
      }))
    );
    const attachmentEvaluations = allAttachments.map(attachment => ({ attachment, ...attachmentMatches(attachment, attachmentRules) }));
    const matchedAttachments = attachmentEvaluations.filter(item => item.matched).map(item => item.attachment);

    const messageEvaluations = messages.map((message, offset) => {
      const values = valuesForMessage(meta, message, email.fields || []);
      const includeMatched = listMatches(values, email.includeTerms || [], email.includeMode || 'any', options);
      const excluded = (email.excludeTerms || []).some(term => values.some(value => matchesTerm(value, term, options)));
      const addressMatched = messagePassesAddressRules(message, email);
      const subjectIncluded = listMatches([meta.subject], email.subjectInclude || [], 'any', options);
      const subjectExcluded = (email.subjectExclude || []).some(term => matchesTerm(meta.subject, term, options));
      const withinDate = dateMatches(message.date, email.dateFrom, email.dateTo);
      return {
        index: message.index || offset + 1,
        matched: includeMatched && !excluded && addressMatched && subjectIncluded && !subjectExcluded && withinDate,
        excluded,
        withinDate,
        fields: email.fields || []
      };
    });

    const anyExcluded = messageEvaluations.some(item => item.excluded);
    let contentMatched;
    if (email.ruleScope === 'thread') {
      const threadValues = messages.flatMap(message => valuesForMessage(meta, message, email.fields || []));
      const keywordMatched = listMatches(threadValues, email.includeTerms || [], email.includeMode || 'any', options);
      const addressMatched = messages.some(message => messagePassesAddressRules(message, email));
      const subjectMatched = listMatches([meta.subject], email.subjectInclude || [], 'any', options) &&
        !(email.subjectExclude || []).some(term => matchesTerm(meta.subject, term, options));
      const dateMatched = messages.some(message => dateMatches(message.date, email.dateFrom, email.dateTo));
      contentMatched = keywordMatched && addressMatched && subjectMatched && dateMatched;
    } else {
      contentMatched = messageEvaluations.some(item => item.matched);
    }

    let matched = contentMatched;
    const reasons = [];
    if (!contentMatched) reasons.push('email-rules');
    if (email.exclusionsOverride !== false && anyExcluded) {
      matched = false;
      reasons.push('excluded-term');
    }
    const attachmentPresence = email.attachmentPresence || (email.requireAttachment ? 'has' : 'any');
    if (attachmentPresence === 'has' && !allAttachments.length) {
      matched = false;
      reasons.push('attachment-required');
    }
    if (attachmentPresence === 'none' && allAttachments.length) {
      matched = false;
      reasons.push('attachment-not-allowed');
    }
    if (email.minMessages != null && email.minMessages !== '' && Number.isFinite(Number(email.minMessages)) && messages.length < Number(email.minMessages)) {
      matched = false;
      reasons.push('minimum-messages');
    }
    if (email.maxMessages != null && email.maxMessages !== '' && Number.isFinite(Number(email.maxMessages)) && messages.length > Number(email.maxMessages)) {
      matched = false;
      reasons.push('maximum-messages');
    }
    if (email.requireMatchingAttachment && !matchedAttachments.length) {
      matched = false;
      reasons.push('matching-attachment-required');
    }
    if (matched) reasons.push('matched');

    const matchedMessageIndexes = email.ruleScope === 'thread' && matched
      ? messages.map((message, offset) => message.index || offset + 1)
      : messageEvaluations.filter(item => item.matched).map(item => item.index);
    return {
      matched,
      reasons: [...new Set(reasons)],
      matchedMessageIndexes,
      matchedAttachments,
      attachmentEvaluations,
      messageEvaluations
    };
  }

  return {
    TYPE_GROUPS,
    normalize,
    safeRegex,
    matchesTerm,
    extensionFromName,
    classifyAttachment,
    attachmentMatches,
    evaluateThread
  };
});
