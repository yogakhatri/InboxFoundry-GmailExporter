const assert = require('node:assert/strict');
const test = require('node:test');
const schema = require('../lib/product-schema.js');
const filters = require('../lib/filter-engine.js');

function fixture() {
  return {
    meta: { subject: 'Invoice 2026 for Project Atlas' },
    messages: [{
      index: 1,
      from: 'billing@example.com',
      fromName: 'Vendor Billing',
      recipients: ['owner@company.test'],
      dateIso: '2026-01-20T10:30:00.000Z',
      bodyTextRaw: 'Please find the final quotation and invoice attached.',
      attachments: [{ fileName: 'Final-Invoice.PDF', sizeBytes: 50000 }, { fileName: 'rates.xlsx', sizeBytes: 9000 }]
    }]
  };
}
const evaluate = email => {
  const { meta, messages } = fixture();
  return filters.evaluateThread(meta, messages, schema.normalizeConfig({ email }));
};

test('term matching styles', () => {
  assert.equal(filters.matchesTerm('Final invoice ready', 'invoice'), true);
  assert.equal(filters.matchesTerm('Final invoice ready', 'FINAL INVOICE READY', { matchType: 'exact' }), true);
  assert.equal(filters.matchesTerm('invoices', 'invoice', { wholeWord: true }), false);
  assert.equal(filters.matchesTerm('(invoice)', 'invoice', { wholeWord: true }), true);
  assert.equal(filters.matchesTerm('Über', 'über'), true);
});

test('wildcards find text anywhere in email, across lines, and anchor for file names', () => {
  const wild = { matchType: 'wildcard' };
  assert.equal(filters.matchesTerm('Hello, invoice for 2026 attached', 'invoice*2026', wild), true);
  assert.equal(filters.matchesTerm('invoice for\n2026', 'invoice*2026', wild), true);
  assert.equal(filters.matchesTerm('nothing here', 'invoice*2026', wild), false);
  assert.equal(filters.matchesTerm('a1c', 'a?c', wild), true);
  const anchored = { matchType: 'wildcard', anchored: true };
  assert.equal(filters.matchesTerm('invoice-2026.pdf', 'invoice-*.pdf', anchored), true);
  assert.equal(filters.matchesTerm('invoice-2026.pdf.exe', '*.pdf', anchored), false);
  assert.equal(filters.matchesTerm('report.pdf', 'report.pdf', anchored), true);
  assert.equal(filters.matchesTerm('aa', 'a*a', anchored), true);
  assert.equal(filters.matchesTerm('a', 'a*a', anchored), false);
});

test('a hostile wildcard cannot hang the page', () => {
  const started = Date.now();
  filters.matchesTerm('a'.repeat(200000), '*a*a*a*a*a*a*a*b', { matchType: 'wildcard' });
  assert.ok(Date.now() - started < 1000);
});

test('commas split terms, except in quotes', () => {
  assert.deepEqual(schema.parseTerms('invoice, quotation\nreceipt'), ['invoice', 'quotation', 'receipt']);
  assert.deepEqual(schema.parseTerms('"Smith, John", other'), ['Smith, John', 'other']);
});

test('an old rule asking for regex is treated as plain text, never compiled', () => {
  assert.equal(filters.matchesTerm('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', '(a|a)*$', { matchType: 'regex' }), false);
});

test('classifies attachments and applies file rules', () => {
  assert.deepEqual(filters.classifyAttachment({ fileName: 'file.PDF' }).groups, ['pdf']);
  assert.deepEqual(filters.classifyAttachment({ fileName: 'unknown.xyz' }).groups, ['other']);
  assert.deepEqual(filters.classifyAttachment({ fileName: 'noextension' }).groups, ['other']);
  const rules = { typeGroups: ['pdf'], filenameInclude: ['invoice'], filenameExclude: ['draft'] };
  assert.equal(filters.attachmentMatches({ fileName: 'Final-Invoice.PDF' }, rules).matched, true);
  assert.equal(filters.attachmentMatches({ fileName: 'draft-invoice.pdf' }, rules).matched, false);
  assert.equal(filters.attachmentMatches({ fileName: 'source.foo' }, { typeGroups: [], customExtensions: ['foo'] }).matched, true);
  assert.equal(filters.attachmentMatches({ fileName: 'large.pdf', sizeBytes: 2048 }, { typeGroups: ['pdf'], maxBytes: 1024 }).matched, false);
  assert.equal(filters.attachmentMatches({ fileName: 'small.pdf', sizeBytes: 10 }, { typeGroups: ['pdf'], minBytes: 1024 }).matched, false);
  assert.equal(filters.attachmentMatches({ fileName: 'unknown-size.pdf' }, { typeGroups: ['pdf'], minBytes: 1024 }).matched, true);
});

test('the clutter rule needs a small file, so real documents survive', () => {
  const rules = schema.DEFAULT_CONFIG.attachments;
  assert.equal(filters.attachmentMatches({ fileName: 'signature page.jpg', sizeBytes: 900000 }, rules).matched, true);
  assert.equal(filters.attachmentMatches({ fileName: 'logo-design-final.png', sizeBytes: 900000 }, rules).matched, true);
  assert.equal(filters.attachmentMatches({ fileName: 'signature.jpg' }, rules).matched, true);
  assert.deepEqual(filters.attachmentMatches({ fileName: 'company-logo.png', sizeBytes: 20000 }, rules).reasons, ['common-clutter-name']);
  assert.deepEqual(filters.attachmentMatches({ fileName: 'photo.png', sizeBytes: 1000 }, rules).reasons, ['tiny-image']);
  assert.equal(filters.attachmentMatches({ fileName: 'a.pdf', sizeBytes: 10 }, rules).matched, true);
});

test('thread evaluation with evidence', () => {
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

test('exclusions win, and sender terms also see display names', () => {
  const excluded = evaluate({ includeTerms: ['invoice'], excludeTerms: ['quotation'], fields: ['body'] });
  assert.equal(excluded.matched, false);
  assert.ok(excluded.reasons.includes('excluded-term'));
  assert.equal(evaluate({ includeTerms: ['Vendor Billing'], fields: ['sender'] }).matched, true);
});

test('date ranges: inside, outside, and unreadable', () => {
  assert.equal(evaluate({ dateFrom: '2026-01-01', dateTo: '2026-01-31' }).matched, true);
  assert.equal(evaluate({ dateFrom: '2026-02-01' }).matched, false);
  const { meta, messages } = fixture();
  messages[0].dateIso = null;
  const result = filters.evaluateThread(meta, messages, schema.normalizeConfig({ email: { dateFrom: '2026-02-01' } }));
  assert.equal(result.matched, true);
  assert.ok(result.reasons.includes('date-unverified'));
});

test('attachment presence rules', () => {
  assert.equal(evaluate({ attachmentPresence: 'has' }).matched, true);
  assert.equal(evaluate({ attachmentPresence: 'none' }).matched, false);
});

test('one-message versus across-the-conversation matching', () => {
  const { meta, messages } = fixture();
  const second = { ...messages[0], index: 2, bodyTextRaw: 'beta only', attachments: [] };
  messages[0].bodyTextRaw = 'alpha only';
  const base = { includeTerms: ['alpha', 'beta'], includeMode: 'all', fields: ['body'] };
  assert.equal(filters.evaluateThread(meta, [messages[0], second], schema.normalizeConfig({ email: base })).matched, false);
  const across = filters.evaluateThread(meta, [messages[0], second], schema.normalizeConfig({ email: { ...base, ruleScope: 'thread' } }));
  assert.equal(across.matched, true);
  assert.deepEqual(across.matchedMessageIndexes, [1, 2]);
});

test('normalizing config survives junk and prototype pollution', () => {
  const config = schema.normalizeConfig(JSON.parse('{"__proto__":{"polluted":1},"source":{"maxMatchedThreads":"abc","pacingMs":99999}}'));
  assert.equal({}.polluted, undefined);
  assert.equal(config.source.maxMatchedThreads, 1000);
  assert.equal(config.source.pacingMs, 5000);
});
