const test = require('node:test');
const assert = require('node:assert/strict');
const intelligence = require('../lib/text-intelligence.js');

test('validates payment cards and IBANs before flagging them', () => {
  assert.equal(intelligence.luhn('4111 1111 1111 1111'), true);
  assert.equal(intelligence.luhn('4111 1111 1111 1112'), false);
  assert.equal(intelligence.validIban('GB82 WEST 1234 5698 7654 32'), true);
  assert.equal(intelligence.validIban('GB82 WEST 1234 5698 7654 33'), false);
  const findings = intelligence.detectSensitive('Pay 4111 1111 1111 1111 to GB82 WEST 1234 5698 7654 32.');
  assert.deepEqual(findings.map(item => item.type), ['payment-card','iban']);
  assert.ok(findings.every(item => !item.preview.includes('4111') && !item.preview.includes('WEST')));
});

test('detects and redacts likely PII without returning raw values in findings', () => {
  const source = 'Email alex@example.com, phone +1 (212) 555-0100, SSN 123-45-6789.';
  const findings = intelligence.detectSensitive(source);
  assert.deepEqual(findings.map(item => item.type), ['email','phone','government-id']);
  assert.ok(findings.every(item => !('value' in item)));
  const redacted = intelligence.redact(source);
  assert.equal(redacted.redactionCount, 3);
  assert.doesNotMatch(redacted.text, /alex@example|555-0100|123-45-6789/);
});

test('does not confuse common dates or unformatted invoice numbers with phones', () => {
  assert.deepEqual(intelligence.detectSensitive('Date 2026-08-30; invoice 12345678.'), []);
  assert.equal(intelligence.detectSensitive('Call +1 212 555 0100.')[0].type, 'phone');
});

test('classifies business documents from transparent matched signals', () => {
  const result = intelligence.classify('INVOICE\nBill to Acme\nSubtotal 10\nTax 1\nTotal due 11');
  assert.equal(result.primary, 'invoice');
  assert.ok(result.confidence >= 0.75);
  assert.ok(result.categories[0].matchedSignals.includes('total due'));
});

test('suggests structured identifiers, amounts, and dates for approval', () => {
  const result = intelligence.extractStructured('Invoice No: INV-2048\nP.O. # PO-77\nDate 2026-08-30\nTotal USD 1,234.50');
  assert.deepEqual(result.identifiers.map(item => [item.field, item.value]), [['invoiceNumber','INV-2048'],['purchaseOrder','PO-77']]);
  assert.deepEqual(result.amounts, ['USD 1,234.50']);
  assert.deepEqual(result.dates, ['2026-08-30']);
});
