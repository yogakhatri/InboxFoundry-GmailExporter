(function initProductSchema(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), schema: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createProductSchema() {
  'use strict';

  const SCHEMA_VERSION = 1;
  const FREE_LIMITS = Object.freeze({
    matchedThreadsPerJob: 250,
    attachmentDownloadsPerJob: 500,
    retainedJobs: 3,
    savedPresets: 5
  });

  const DEFAULT_CONFIG = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: {
      mode: 'current-view',
      gmailQuery: '',
      selectedThreadKeys: [],
      excludeThreadKeys: [],
      incremental: false,
      pacingMs: 300,
      maxMatchedThreads: FREE_LIMITS.matchedThreadsPerJob
    },
    email: {
      includeTerms: [],
      excludeTerms: [],
      includeMode: 'any',
      matchType: 'contains',
      caseSensitive: false,
      wholeWord: false,
      fields: ['subject', 'body', 'sender', 'recipients', 'headers', 'attachmentNames'],
      threadMode: 'whole-thread',
      ruleScope: 'single-message',
      exclusionsOverride: true,
      senderInclude: [],
      senderExclude: [],
      recipientInclude: [],
      recipientExclude: [],
      domainInclude: [],
      domainExclude: [],
      subjectInclude: [],
      subjectExclude: [],
      dateFrom: '',
      dateTo: '',
      attachmentPresence: 'any',
      requireMatchingAttachment: false,
      minMessages: null,
      maxMessages: null
    },
    attachments: {
      action: 'all',
      typeGroups: ['all'],
      customExtensions: [],
      filenameInclude: [],
      filenameExclude: [],
      includeMode: 'any',
      matchType: 'contains',
      caseSensitive: false,
      includeInline: false,
      excludeClutter: true,
      clutterMaxBytes: 4096,
      unknownSize: 'include',
      minBytes: null,
      maxBytes: null,
      maxDownloads: FREE_LIMITS.attachmentDownloadsPerJob
    },
    destination: {
      type: 'downloads',
      rootFolder: 'InboxFoundry'
    },
    output: {
      formats: ['json'],
      contentMode: 'full',
      includeRawHtml: true,
      includeGmailUrls: true,
      includeInternalIds: true,
      redactAddresses: false,
      prettyJson: true,
      autoExportOnComplete: true,
      autoExportOnStop: false,
      folderTemplate: '{batch}/{index} - {subject}',
      splitRecords: null
    }
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function mergeObject(base, supplied) {
    const result = clone(base);
    for (const [key, value] of Object.entries(supplied || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = mergeObject(result[key], value);
      } else if (value !== undefined) {
        result[key] = clone(value);
      }
    }
    return result;
  }

  function normalizeStringList(input) {
    const values = Array.isArray(input) ? input : String(input || '').split(/[\n,]+/);
    return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  }

  function normalizeConfig(input = {}) {
    const config = mergeObject(DEFAULT_CONFIG, input);
    const emailLists = [
      'includeTerms', 'excludeTerms', 'senderInclude', 'senderExclude', 'recipientInclude', 'recipientExclude', 'domainInclude',
      'domainExclude', 'subjectInclude', 'subjectExclude'
    ];
    for (const key of emailLists) config.email[key] = normalizeStringList(config.email[key]);
    config.email.fields = normalizeStringList(config.email.fields);
    config.source.selectedThreadKeys = normalizeStringList(config.source.selectedThreadKeys);
    config.source.excludeThreadKeys = normalizeStringList(config.source.excludeThreadKeys);
    config.attachments.typeGroups = normalizeStringList(config.attachments.typeGroups);
    config.attachments.customExtensions = normalizeStringList(config.attachments.customExtensions)
      .map(value => value.replace(/^\./, '').toLowerCase());
    config.attachments.filenameInclude = normalizeStringList(config.attachments.filenameInclude);
    config.attachments.filenameExclude = normalizeStringList(config.attachments.filenameExclude);
    config.output.formats = normalizeStringList(config.output.formats);
    return config;
  }

  function createJob(config, context = {}) {
    const now = new Date().toISOString();
    const random = Math.random().toString(36).slice(2, 10);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: `job-${Date.now()}-${random}`,
      name: context.name || `Export ${now.slice(0, 10)}`,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      stoppedAt: null,
      completedAt: null,
      sourceUrl: context.sourceUrl || '',
      accountSlot: context.accountSlot || '',
      config: normalizeConfig(config),
      counters: {
        candidates: 0,
        inspected: 0,
        matched: 0,
        rejected: 0,
        messages: 0,
        attachmentMatches: 0,
        downloadsQueued: 0,
        downloadsStarted: 0,
        downloadsComplete: 0,
        downloadsInterrupted: 0,
        downloadsFailed: 0,
        errors: 0
      }
    };
  }

  return { SCHEMA_VERSION, FREE_LIMITS, DEFAULT_CONFIG, normalizeStringList, normalizeConfig, createJob };
});
