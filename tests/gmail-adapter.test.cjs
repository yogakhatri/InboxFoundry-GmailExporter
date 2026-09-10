const test = require('node:test');
const assert = require('node:assert/strict');
const adapterModule = require('../lib/gmail-adapter.js');

function documentStub() {
  return { title:'Gmail', querySelector:() => null, querySelectorAll:() => [] };
}

test('centralizes Gmail DOM selectors behind a stable adapter surface', () => {
  const required = ['listRows','threadView','messageListItems','body','attachmentCandidates','attachmentCards','subject'];
  for (const key of required) assert.equal(typeof adapterModule.SELECTORS[key], 'string');
  const adapter = adapterModule.create({ documentRef:documentStub(), locationRef:{ href:'https://mail.google.com/mail/u/0/#inbox', hash:'' }, historyRef:{} });
  for (const method of ['searchMessages','getVisibleThreads','openThread','expandThread','extractMessageMetadata','extractAttachments','downloadAttachment','getNextResultsPage','returnToSearchResults']) {
    assert.equal(typeof adapter[method], 'function', method);
  }
});

test('derives stable row keys and selected state without leaking selectors to orchestration', () => {
  const selected = { getAttribute:name => name === 'data-legacy-thread-id' ? 'thread-123' : null, querySelector:() => ({}) };
  const adapter = adapterModule.create({ documentRef:documentStub(), locationRef:{ href:'', hash:'' }, historyRef:{} });
  assert.equal(adapter.threadKey(selected), 'thread-123');
  assert.equal(adapter.isThreadSelected(selected), true);
});

test('opens an encoded Gmail search through the adapter', () => {
  const locationRef = { href:'https://mail.google.com/mail/u/0/#inbox', hash:'' };
  const adapter = adapterModule.create({ documentRef:documentStub(), locationRef, historyRef:{} });
  adapter.searchMessages('from:vendor@example.com has:attachment');
  assert.equal(locationRef.hash, '#search/from%3Avendor%40example.com%20has%3Aattachment');
  assert.throws(() => adapter.searchMessages(''), /at least one Gmail search filter/i);
});
