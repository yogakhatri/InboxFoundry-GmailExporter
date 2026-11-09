(function initGmailDate(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), gmailDate: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createGmailDate() {
  'use strict';

  // Tried after the page's own language so a mismatch between Gmail and browser language still parses.
  const COMMON_LOCALES = [
    'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'nb', 'fi', 'pl', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl',
    'el', 'bg', 'uk', 'ru', 'tr', 'id', 'ms', 'vi', 'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'th', 'he', 'ar', 'fa'
  ];
  const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0xff10];
  const monthTables = new Map();

  function asciiDigits(text) {
    let output = '';
    for (const char of text) {
      const code = char.codePointAt(0);
      const zero = DIGIT_ZEROS.find(start => code >= start && code <= start + 9);
      output += zero === undefined ? char : String(code - zero);
    }
    return output;
  }

  function normalizeToken(value) {
    return String(value).normalize('NFKC').toLocaleLowerCase().replace(/[.,॰]/g, '').trim();
  }

  function monthTable(locale) {
    if (monthTables.has(locale)) return monthTables.get(locale);
    const table = new Map();
    try {
      for (const width of ['long', 'short']) {
        const format = new Intl.DateTimeFormat(locale, { month: width, timeZone: 'UTC' });
        for (let month = 0; month < 12; month++) {
          const token = normalizeToken(format.format(new Date(Date.UTC(2021, month, 15))));
          if (token && !/^\d/.test(token)) table.set(token, month);
        }
        // Many languages inflect a month after a day number, so read it in that context too.
        const dayFormat = new Intl.DateTimeFormat(locale, { month: width, day: 'numeric', timeZone: 'UTC' });
        for (let month = 0; month < 12; month++) {
          for (const part of dayFormat.formatToParts(new Date(Date.UTC(2021, month, 15)))) {
            if (part.type === 'month') {
              const token = normalizeToken(part.value);
              if (token && !/^\d/.test(token)) table.set(token, month);
            }
          }
        }
      }
    } catch {
      // An unknown locale simply contributes no month names.
    }
    monthTables.set(locale, table);
    return table;
  }

  function findMonth(text, locales) {
    const tokens = normalizeToken(text).split(/[\s/\-()]+/).filter(token => token && !/^\d+$/.test(token));
    for (const locale of locales) {
      const table = monthTable(locale);
      for (const token of tokens) if (table.has(token)) return table.get(token);
    }
    return null;
  }

  function plausible(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
    const year = date.getUTCFullYear();
    return year >= 1990 && date.getTime() <= Date.now() + 2 * 86400000;
  }

  function readTime(text) {
    const match = text.match(/(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?/);
    if (!match) return { hours: 0, minutes: 0, seconds: 0 };
    let hours = Number(match[1]);
    const lowered = text.toLocaleLowerCase();
    const afternoon = /\bp\.?\s?m\b|午後|下午|오후/.test(lowered);
    const morning = /\ba\.?\s?m\b|午前|上午|오전/.test(lowered);
    if (afternoon && hours < 12) hours += 12;
    if (morning && hours === 12) hours = 0;
    return { hours, minutes: Number(match[2]), seconds: Number(match[3] || 0) };
  }

  function parseLocalized(text, locales) {
    const cleaned = asciiDigits(text);
    const withoutTime = cleaned.replace(/\d{1,2}[:.]\d{2}(?:[:.]\d{2})?/g, ' ');
    const cjk = withoutTime.match(/(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})/);
    let year;
    let month;
    let day;
    if (cjk) {
      [year, month, day] = [Number(cjk[1]), Number(cjk[2]) - 1, Number(cjk[3])];
    } else {
      const yearMatch = withoutTime.match(/\b(\d{4})\b/);
      month = findMonth(withoutTime, locales);
      if (!yearMatch || month === null) return null;
      year = Number(yearMatch[1]);
      const dayMatch = withoutTime.replace(yearMatch[0], ' ').match(/(?:^|\D)(\d{1,2})(?:\D|$)/);
      if (!dayMatch) return null;
      day = Number(dayMatch[1]);
    }
    if (day < 1 || day > 31 || month < 0 || month > 11) return null;
    const { hours, minutes, seconds } = readTime(cleaned);
    return new Date(year, month, day, hours, minutes, seconds);
  }

  /** Gmail's internal message IDs carry the receive time in milliseconds above their low 20 bits. */
  function fromMessageId(messageId) {
    const text = String(messageId ?? '').trim();
    try {
      let id = null;
      const decimal = text.match(/msg-[a-z]:(\d{10,})/i);
      if (decimal) id = BigInt(decimal[1]);
      else if (/^[0-9a-f]{12,16}$/i.test(text)) id = BigInt(`0x${text}`);
      if (id === null) return null;
      const date = new Date(Number(id >> 20n));
      return plausible(date) ? date : null;
    } catch {
      return null;
    }
  }

  /** Returns { iso, source }, where source is 'displayed', 'message-id', or 'unknown'. */
  function resolve(displayed, messageId, pageLocales = []) {
    const text = String(displayed ?? '').replace(/[  ]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) {
      const native = new Date(text);
      if (plausible(native)) return { iso: native.toISOString(), source: 'displayed' };
      const locales = [...new Set([...pageLocales.filter(Boolean), ...COMMON_LOCALES])];
      const localized = parseLocalized(text, locales);
      if (plausible(localized)) return { iso: localized.toISOString(), source: 'displayed' };
    }
    const fromId = fromMessageId(messageId);
    if (fromId) return { iso: fromId.toISOString(), source: 'message-id' };
    return { iso: null, source: 'unknown' };
  }

  return { resolve, fromMessageId };
});
