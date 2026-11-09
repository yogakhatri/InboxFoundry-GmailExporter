const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve, fromMessageId } = require('../lib/gmail-date.js');

const day = iso => new Date(iso).toLocaleDateString('en-CA');

test('reads Gmail timestamps in many languages', () => {
  const cases = {
    'Sat, Aug 29, 2026, 10:32 AM': 'en',
    'Sat, Aug 29, 2026, 10:32 AM': 'en',
    'Sat, 29 Aug 2026, 10:32': 'en-GB',
    'Aug 29, 2026, 10:32 AM (3 days ago)': 'en',
    'Sa., 29. Aug. 2026, 10:32': 'de',
    'sam. 29 août 2026, 10:32': 'fr',
    'sáb, 29 ago 2026, 10:32': 'es',
    'sáb., 29 de ago. de 2026, 10:32': 'pt',
    'शनि, 29 अग॰ 2026, 10:32 am': 'hi',
    '2026年8月29日(土) 10:32': 'ja',
    '2026년 8월 29일 (토) 오전 10:32': 'ko',
    'сб, 29 авг. 2026 г., 10:32': 'ru',
    '٢٩ أغسطس ٢٠٢٦ ١٠:٣٢': 'ar'
  };
  for (const [text, locale] of Object.entries(cases)) {
    const result = resolve(text, null, [locale]);
    assert.equal(result.source, 'displayed', text);
    assert.equal(day(result.iso), '2026-08-29', text);
  }
});

test('12-hour markers adjust the hour', () => {
  assert.equal(new Date(resolve('2026年8月29日 午後3:05', null, ['ja']).iso).getHours(), 15);
});

test('falls back to the time inside the Gmail message ID', () => {
  const ms = Date.UTC(2020, 5, 15, 12, 0, 0);
  const hex = (BigInt(ms) << 20n).toString(16);
  assert.equal(fromMessageId(hex).getTime(), ms);
  assert.equal(fromMessageId(`#msg-f:${BigInt(ms) << 20n}`).getTime(), ms);
  assert.deepEqual(resolve('complete nonsense', hex), { iso: new Date(ms).toISOString(), source: 'message-id' });
});

test('unknown stays unknown instead of inventing a date', () => {
  assert.deepEqual(resolve('complete nonsense', null), { iso: null, source: 'unknown' });
  assert.deepEqual(resolve('', 'zz'), { iso: null, source: 'unknown' });
  assert.equal(fromMessageId('ffffffffffffffff'), null);
  assert.equal(resolve('Jan 1, 2099, 10:00 AM', null).source, 'unknown');
});
