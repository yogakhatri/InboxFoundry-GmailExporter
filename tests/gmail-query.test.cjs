const test = require('node:test');
const assert = require('node:assert/strict');
const query = require('../lib/gmail-query.js');

test('builds Gmail searches from the form', () => {
  assert.equal(query.build({ from: 'a@b.c', subject: 'two words', hasAttachment: true }), 'from:a@b.c subject:"two words" has:attachment');
  assert.equal(query.build({ raw: 'label:x', keywords: 'invoice OR receipt' }), 'label:x invoice OR receipt');
  assert.equal(query.build({ largerMb: '5', smallerMb: '0', inAnywhere: true }), 'larger:5M in:anywhere');
  assert.equal(query.build({}), '');
});

test('the To date includes that whole day', () => {
  assert.equal(query.build({ after: '2026-01-01', before: '2026-01-31' }), 'after:2026/01/01 before:2026/02/01');
  assert.equal(query.nextDay('2026-12-31'), '2027/01/01');
  assert.equal(query.nextDay('2028-02-28'), '2028/02/29');
});

test('quotes cannot break out of an operator', () => {
  assert.equal(query.quoted('a "b" c'), '"a  b  c"');
  assert.equal(query.quoted('  '), '');
});
