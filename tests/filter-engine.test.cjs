const assert = require('node:assert/strict');
const test = require('node:test');
const schema = require('../lib/product-schema.js');
const filters = require('../lib/filter-engine.js');

function fixture() {
  return {
    meta: { subject: 'Invoice 2026 for Project Atlas' },
    messages: [{
      index: 1,
      from: 'Vendor <billing@example.com>',
      recipients: ['owner@company.test'],
      date: 'January 20, 2026, 10:30 AM',
      rawHeaderText: 'billing@example.com to owner@company.test',
      bodyTextRaw: 'Please find the final quotation and invoice attached.',
      bodyTextNormalized: 'Please find the final quotation and invoice attached.',
      bodyHtmlRaw: '<p>Please find the invoice.</p>',
      attachments: [
        { fileName: 'Final-Invoice.PDF' },
        { fileName: 'rates.xlsx' },
        { fileName: 'logo.png', inline: true }
      ]
    }]
  };
}

test('normalizes user configuration and free limits', () => {
  const config = schema.normalizeConfig({ email: { includeTerms: 'invoice, quotation' }, attachments: { customExtensions: '.foo, BAR' } });
  assert.deepEqual(config.email.includeTerms, ['invoice', 'quotation']);
  assert.deepEqual(config.attachments.customExtensions, ['foo', 'bar']);
  assert.equal(config.source.maxMatchedThreads, 250);
});

test('supports ANY, ALL, exact, whole word, wildcard, and guarded regex matching', () => {
  assert.equal(filters.matchesTerm('Final invoice ready', 'invoice'), true);
  assert.equal(filters.matchesTerm('Final invoice ready', 'Final invoice ready', { matchType: 'exact' }), true);
  assert.equal(filters.matchesTerm('invoices', 'invoice', { wholeWord: true }), false);
  assert.equal(filters.matchesTerm('invoice-2026.pdf', 'invoice-*.pdf', { matchType: 'wildcard' }), true);
  assert.equal(filters.matchesTerm('INV-2048', '^INV-\\d+$', { matchType: 'regex' }), true);
  assert.equal(filters.safeRegex('(a+)+$'), null);
});

test('classifies common attachment groups case-insensitively', () => {
  assert.deepEqual(filters.classifyAttachment({ fileName: 'file.PDF' }).groups, ['pdf']);
  assert.deepEqual(filters.classifyAttachment({ fileName: 'data.XLSM' }).groups, ['spreadsheet']);
  assert.deepEqual(filters.classifyAttachment({ fileName: 'unknown.xyz' }).groups, ['other']);
});

test('filters attachments by group, filename, exclusion, inline status, and custom extension', () => {
  const rules = { typeGroups: ['pdf', 'spreadsheet'], filenameInclude: ['invoice', 'rates'], filenameExclude: ['draft'], includeMode: 'any' };
  assert.equal(filters.attachmentMatches({ fileName: 'Final-Invoice.PDF' }, rules).matched, true);
  assert.equal(filters.attachmentMatches({ fileName: 'draft-invoice.pdf' }, rules).matched, false);
  assert.equal(filters.attachmentMatches({ fileName: 'logo.png', inline: true }, { typeGroups: ['image'], includeInline: false }).matched, false);
  assert.equal(filters.attachmentMatches({ fileName: 'source.foo' }, { typeGroups: [], customExtensions: ['foo'] }).matched, true);
  assert.equal(filters.attachmentMatches({ fileName: 'normal.pdf', sizeBytes: 1024 }, schema.DEFAULT_CONFIG.attachments).matched, true);
  assert.equal(filters.attachmentMatches({ fileName: 'large.pdf', sizeBytes: 2048 }, { typeGroups: ['pdf'], maxBytes: 1024 }).matched, false);
  assert.deepEqual(filters.attachmentMatches({ fileName: 'company-logo.png' }, { typeGroups: ['image'], excludeClutter: true }).reasons, ['common-clutter-name']);
  assert.deepEqual(filters.attachmentMatches({ fileName: 'photo.png', sizeBytes: 1000 }, { typeGroups: ['image'], excludeClutter: true, clutterMaxBytes: 4096 }).reasons, ['tiny-image']);
});

test('matches a thread and returns message and attachment evidence', () => {
  const { meta, messages } = fixture();
  const config = schema.normalizeConfig({
    email: { includeTerms: ['invoice', 'quotation'], includeMode: 'all', fields: ['subject', 'body'], requireMatchingAttachment: true },
    attachments: { typeGroups: ['pdf'], filenameInclude: ['invoice'], action: 'matching' }
  });
  const result = filters.evaluateThread(meta, messages, config);
  assert.equal(result.matched, true);
  assert.deepEqual(result.matchedMessageIndexes, [1]);
  assert.deepEqual(result.matchedAttachments.map(item => item.fileName), ['Final-Invoice.PDF']);
});

test('excluded terms override included terms by default', () => {
  const { meta, messages } = fixture();
  messages[0].bodyTextRaw += ' This is a draft.';
  const config = schema.normalizeConfig({ email: { includeTerms: ['invoice'], excludeTerms: ['draft'], fields: ['subject', 'body'] } });
  const result = filters.evaluateThread(meta, messages, config);
  assert.equal(result.matched, false);
  assert.ok(result.reasons.includes('excluded-term'));
});

test('keeps email inclusion independent from attachment download action', () => {
  const { meta, messages } = fixture();
  const config = schema.normalizeConfig({
    email: { includeTerms: ['invoice'], fields: ['subject'] },
    attachments: { action: 'none', typeGroups: ['archive'] }
  });
  assert.equal(filters.evaluateThread(meta, messages, config).matched, true);
});

test('filters by recipient and inclusive date range', () => {
  const { meta, messages } = fixture();
  const matching = schema.normalizeConfig({ email: { recipientInclude: ['owner@company.test'], dateFrom: '2026-01-01', dateTo: '2026-01-31' } });
  assert.equal(filters.evaluateThread(meta, messages, matching).matched, true);
  const outside = schema.normalizeConfig({ email: { recipientInclude: ['owner@company.test'], dateFrom: '2026-02-01' } });
  assert.equal(filters.evaluateThread(meta, messages, outside).matched, false);
});

test('supports attachment presence and thread message-count rules', () => {
  const { meta, messages } = fixture();
  assert.equal(filters.evaluateThread(meta, messages, schema.normalizeConfig({ email: { attachmentPresence: 'has', minMessages: 1, maxMessages: 1 } })).matched, true);
  assert.equal(filters.evaluateThread(meta, messages, schema.normalizeConfig({ email: { attachmentPresence: 'none' } })).matched, false);
  assert.equal(filters.evaluateThread(meta, messages, schema.normalizeConfig({ email: { minMessages: 2 } })).matched, false);
});

test('distinguishes one-message ALL rules from cross-message thread rules', () => {
  const { meta, messages } = fixture();
  const second = { ...messages[0], index: 2, bodyTextRaw: 'beta only', bodyTextNormalized: 'beta only', attachments: [] };
  messages[0].bodyTextRaw = 'alpha only'; messages[0].bodyTextNormalized = 'alpha only';
  const base = { email: { includeTerms: ['alpha','beta'], includeMode: 'all', fields: ['body'] } };
  assert.equal(filters.evaluateThread(meta, [messages[0], second], schema.normalizeConfig(base)).matched, false);
  const across = schema.normalizeConfig({ email: { ...base.email, ruleScope: 'thread' } });
  const result = filters.evaluateThread(meta, [messages[0], second], across);
  assert.equal(result.matched, true);
  assert.deepEqual(result.matchedMessageIndexes, [1, 2]);
});
