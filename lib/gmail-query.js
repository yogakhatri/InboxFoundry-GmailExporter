(function initGmailQuery(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), gmailQuery: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createGmailQuery() {
  'use strict';

  function quoted(value) {
    const text = String(value ?? '').trim().replace(/"/g, ' ').trim();
    if (!text) return '';
    return /\s/.test(text) ? `"${text}"` : text;
  }

  function dateValue(value) {
    return String(value ?? '').trim().replace(/-/g, '/');
  }

  /** The day after a yyyy-mm-dd date. Gmail's before: excludes its date, but "To date" should include it. */
  function nextDay(value) {
    const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return dateValue(value);
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
    return date.toISOString().slice(0, 10).replace(/-/g, '/');
  }

  function build(criteria = {}) {
    const terms = [String(criteria.raw ?? '').trim(), String(criteria.keywords ?? '').trim()];
    const add = (operator, value) => {
      const clean = quoted(value);
      if (clean) terms.push(`${operator}:${clean}`);
    };
    add('from', criteria.from);
    add('to', criteria.to);
    add('subject', criteria.subject);
    add('filename', criteria.filename);
    if (criteria.after) terms.push(`after:${dateValue(criteria.after)}`);
    if (criteria.before) terms.push(`before:${nextDay(criteria.before)}`);
    add('label', criteria.label);
    if (Number(criteria.largerMb) > 0) terms.push(`larger:${Number(criteria.largerMb)}M`);
    if (Number(criteria.smallerMb) > 0) terms.push(`smaller:${Number(criteria.smallerMb)}M`);
    if (criteria.hasAttachment) terms.push('has:attachment');
    if (criteria.inAnywhere) terms.push('in:anywhere');
    return terms.filter(Boolean).join(' ');
  }

  return { quoted, nextDay, build };
});
