const test = require('node:test');
const assert = require('node:assert/strict');
const query = require('../lib/gmail-query.js');

test('builds a reproducible Gmail query from friendly criteria', () => {
  assert.equal(query.build({ from:'billing@example.com', subject:'quarterly statement', after:'2026-01-01', before:'2026-02-01', label:'finance', filename:'pdf', largerMb:2, hasAttachment:true, status:'unread', inAnywhere:true }),
    'from:billing@example.com subject:"quarterly statement" filename:pdf after:2026/01/01 before:2026/02/01 label:finance larger:2M has:attachment is:unread in:anywhere');
});

test('preserves an expert raw query and escapes quoted values', () => {
  assert.equal(query.build({ raw:'newer_than:1y -category:promotions', subject:'say "hello"' }), 'newer_than:1y -category:promotions subject:"say \\"hello\\""');
});
