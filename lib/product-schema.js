(function initProductSchema(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), schema: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createProductSchema() {
  'use strict';

  const SCHEMA_VERSION = 2;

  const DEFAULT_CONFIG = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: {
      mode: 'current-view',
      gmailQuery: '',
      selectedThreadKeys: [],
      incremental: false,
      pacingMs: 300,
      // Safety stops, not product tiers. Reaching one leaves the job resumable and marked partial.
      maxMatchedThreads: 1000,
      maxInspectedThreads: 5000
    },
    email: {
      includeTerms: [],
      excludeTerms: [],
      includeMode: 'any',
      matchType: 'contains',
      caseSensitive: false,
      wholeWord: false,
      fields: ['subject', 'body', 'sender', 'recipients', 'attachmentNames'],
      threadMode: 'whole-thread',
      ruleScope: 'single-message',
      dateFrom: '',
      dateTo: '',
      attachmentPresence: 'any',
      requireMatchingAttachment: false
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
      excludeClutter: true,
      clutterMaxBytes: 4096,
      clutterNameMaxBytes: 65536,
      minBytes: null,
      maxBytes: null
    },
    destination: {
      rootFolder: 'InboxFoundry'
    },
    output: {
      formats: ['archive'],
      contentMode: 'full',
      includeRawHtml: true,
      includeGmailUrls: true,
      includeInternalIds: true,
      redactAddresses: false,
      folderTemplate: '{index} - {subject}'
    }
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function mergeObject(base, supplied) {
    const result = clone(base);
    for (const [key, value] of Object.entries(supplied || {})) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const nested = value && typeof value === 'object' && !Array.isArray(value);
      if (nested && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = mergeObject(result[key], value);
      } else if (value !== undefined) {
        result[key] = clone(value);
      }
    }
    return result;
  }

  /**
   * Splits free text into terms. New lines and commas separate, except inside "double quotes".
   */
  function parseTerms(input) {
    if (Array.isArray(input)) return dedupe(input);
    const text = String(input ?? '');
    const terms = [];
    let current = '';
    let quoted = false;
    for (const char of text) {
      if (char === '"') quoted = !quoted;
      else if (!quoted && (char === ',' || char === '\n')) {
        terms.push(current);
        current = '';
      } else current += char;
    }
    terms.push(current);
    return dedupe(terms);
  }

  function dedupe(values) {
    return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  }

  function positiveInteger(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeConfig(input = {}) {
    const config = mergeObject(DEFAULT_CONFIG, input);
    const { email, attachments, source, output } = config;
    email.includeTerms = parseTerms(email.includeTerms);
    email.excludeTerms = parseTerms(email.excludeTerms);
    email.fields = parseTerms(email.fields);
    source.selectedThreadKeys = parseTerms(source.selectedThreadKeys);
    source.maxMatchedThreads = positiveInteger(source.maxMatchedThreads, DEFAULT_CONFIG.source.maxMatchedThreads);
    source.maxInspectedThreads = positiveInteger(source.maxInspectedThreads, DEFAULT_CONFIG.source.maxInspectedThreads);
    source.pacingMs = Math.min(5000, Math.max(0, Number(source.pacingMs) || 0));
    attachments.typeGroups = parseTerms(attachments.typeGroups);
    if (!attachments.typeGroups.length) attachments.typeGroups = ['all'];
    attachments.customExtensions = parseTerms(attachments.customExtensions)
      .map(value => value.replace(/^\./, '').toLowerCase());
    attachments.filenameInclude = parseTerms(attachments.filenameInclude);
    attachments.filenameExclude = parseTerms(attachments.filenameExclude);
    output.formats = parseTerms(output.formats);
    return config;
  }

  function randomId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function createJob(config, context = {}) {
    const now = new Date().toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      id: `job-${randomId()}`,
      name: context.name || `Export ${now.slice(0, 10)}`,
      batchNumber: context.batchNumber || 0,
      status: 'draft',
      phase: 'scan',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      stoppedAt: null,
      scanFinishedAt: null,
      savedAt: null,
      sourceUrl: context.sourceUrl || '',
      sourceBase: context.sourceBase || '',
      accountSlot: context.accountSlot || '0',
      accountEmail: context.accountEmail || '',
      ownerTabId: context.ownerTabId ?? null,
      leaseExpiresAt: null,
      lastError: null,
      partialReasons: [],
      config: normalizeConfig(config),
      counters: { inspected: 0, matched: 0, rejected: 0, unchanged: 0, failed: 0, incomplete: 0, repeatedViews: 0, messages: 0, unread: 0 }
    };
  }

  /** The ledger is what makes repeat exports skip mail already saved, across any number of batches. */
  function ledgerScope(job) {
    return `${job.accountEmail || `slot-${job.accountSlot}`}|${job.sourceBase}`;
  }

  return { DEFAULT_CONFIG, parseTerms, normalizeConfig, createJob, ledgerScope };
});
