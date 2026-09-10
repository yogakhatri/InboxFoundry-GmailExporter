(function initGmailQuery(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), gmailQuery: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createGmailQuery() {
  'use strict';
  function quoted(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
  }
  function dateValue(value) { return String(value || '').trim().replace(/-/g, '/'); }
  function build(criteria = {}) {
    const terms = [String(criteria.raw || '').trim()];
    const add = (operator, value) => { const clean = quoted(value); if (clean) terms.push(`${operator}:${clean}`); };
    add('from', criteria.from); add('to', criteria.to); add('cc', criteria.cc); add('bcc', criteria.bcc);
    add('subject', criteria.subject); add('filename', criteria.filename);
    if (criteria.after) terms.push(`after:${dateValue(criteria.after)}`);
    if (criteria.before) terms.push(`before:${dateValue(criteria.before)}`);
    add('label', criteria.label); add('category', criteria.category); add('list', criteria.mailingList);
    if (Number(criteria.largerMb) > 0) terms.push(`larger:${Number(criteria.largerMb)}M`);
    if (Number(criteria.smallerMb) > 0) terms.push(`smaller:${Number(criteria.smallerMb)}M`);
    if (criteria.hasAttachment) terms.push('has:attachment');
    if (criteria.status) terms.push(`is:${criteria.status}`);
    if (criteria.inAnywhere) terms.push('in:anywhere');
    return terms.filter(Boolean).join(' ');
  }
  return { quoted, dateValue, build };
});
