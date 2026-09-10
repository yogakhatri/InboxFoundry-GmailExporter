(function initTextIntelligence(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), textIntelligence: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createTextIntelligence() {
  'use strict';

  const CLASSIFIERS = Object.freeze({
    invoice:['invoice','amount due','bill to','payment terms','subtotal','tax','total due'],
    receipt:['receipt','paid','payment received','transaction id','change due'],
    quotation:['quotation','quote number','valid until','estimate','proposed price'],
    contract:['agreement','contract','whereas','terms and conditions','governing law','signature'],
    statement:['statement period','opening balance','closing balance','account statement','balance forward'],
    resume:['curriculum vitae','resume','résumé','work experience','education','skills'],
    travel:['itinerary','booking reference','departure','arrival','boarding','reservation'],
    insurance:['claim number','policy number','insured','coverage','deductible','premium']
  });

  function luhn(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
    let sum = 0; let alternate = false;
    for (let index = digits.length - 1; index >= 0; index--) {
      let digit = Number(digits[index]);
      if (alternate) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit; alternate = !alternate;
    }
    return sum % 10 === 0;
  }

  function validIban(value) {
    const compact = String(value || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
    const rearranged = compact.slice(4) + compact.slice(0, 4);
    let remainder = 0;
    for (const char of rearranged) {
      const expanded = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
      for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
    }
    return remainder === 1;
  }

  function masked(type, value) {
    const text = String(value || '');
    if (type === 'email') return 'e***@***';
    const compact = text.replace(/\s+/g, '');
    if (['payment-card','iban'].includes(type)) return `••••${compact.slice(-4)}`;
    if (type === 'phone') return `••••${compact.replace(/\D/g, '').slice(-2)}`;
    return '••••';
  }

  function candidates(text, type, regex, validate = () => true) {
    const values = [];
    for (const match of String(text || '').matchAll(regex)) {
      if (!validate(match[0])) continue;
      values.push({ type, start:match.index, end:match.index + match[0].length, preview:masked(type, match[0]), confidence:type === 'email' || type === 'payment-card' || type === 'iban' ? 'high' : 'possible' });
    }
    return values;
  }

  function detectSensitive(text) {
    const value = String(text || '');
    const ordered = [
      ...candidates(value, 'payment-card', /\b(?:\d[ -]*?){13,19}\b/g, luhn),
      ...candidates(value, 'iban', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi, validIban),
      ...candidates(value, 'email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi),
      ...candidates(value, 'government-id', /\b\d{3}-\d{2}-\d{4}\b/g),
      ...candidates(value, 'phone', /(?<![\w.])(?:\+?\d[\d ().-]{6,}\d)(?![\w.])/g, raw => {
        const digits = raw.replace(/\D/g, '');
        const trimmed = raw.trim();
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(trimmed) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(trimmed)) return false;
        const separators = (trimmed.match(/[ ().-]/g) || []).length;
        const formatted = trimmed.startsWith('+') || trimmed.includes('(') || separators >= 2;
        return digits.length >= 7 && digits.length <= 15 && formatted && !luhn(raw);
      })
    ].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const accepted = [];
    for (const item of ordered) if (!accepted.some(existing => item.start < existing.end && item.end > existing.start)) accepted.push(item);
    return accepted.sort((a, b) => a.start - b.start);
  }

  function sensitiveCounts(findings = []) {
    const counts = {};
    for (const item of findings) counts[item.type] = (counts[item.type] || 0) + 1;
    return counts;
  }

  function redact(text, types) {
    const selected = types ? new Set(types) : null;
    const findings = detectSensitive(text).filter(item => !selected || selected.has(item.type));
    let output = String(text || '');
    for (const item of findings.sort((a, b) => b.start - a.start)) output = `${output.slice(0, item.start)}[REDACTED ${item.type.toUpperCase()}]${output.slice(item.end)}`;
    return { text:output, redactionCount:findings.length, counts:sensitiveCounts(findings) };
  }

  function classify(text) {
    const normalized = String(text || '').toLocaleLowerCase();
    const categories = Object.entries(CLASSIFIERS).map(([category, terms]) => {
      const matches = terms.filter(term => normalized.includes(term));
      return { category, score:matches.length, matchedSignals:matches };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
    return { primary:categories[0]?.category || 'unclassified', confidence:categories[0] ? Math.min(1, categories[0].score / 4) : 0, categories };
  }

  function labeledValues(text, patterns, limit = 20) {
    const values = [];
    for (const { field, regex } of patterns) {
      for (const match of String(text || '').matchAll(regex)) {
        const value = String(match[1] || '').trim();
        if (value && !values.some(item => item.field === field && item.value === value)) values.push({ field, value, confidence:'suggested', sourceLabel:match[0].slice(0, Math.min(match[0].length, match[0].length - value.length)).trim() });
        if (values.length >= limit) return values;
      }
    }
    return values;
  }

  function extractStructured(text) {
    const value = String(text || '');
    const identifiers = labeledValues(value, [
      { field:'invoiceNumber', regex:/\b(?:invoice|inv)(?:\s+(?:number|no\.?))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,40})/gi },
      { field:'purchaseOrder', regex:/\b(?:purchase\s+order|p\.?o\.?)(?:\s+(?:number|no\.?))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,40})/gi },
      { field:'quoteNumber', regex:/\b(?:quotation|quote)(?:\s+(?:number|no\.?))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,40})/gi },
      { field:'contractNumber', regex:/\b(?:contract|agreement)(?:\s+(?:number|no\.?))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,40})/gi },
      { field:'accountNumber', regex:/\baccount(?:\s+(?:number|no\.?))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,40})/gi }
    ]);
    const amounts = [...value.matchAll(/(?:\b(?:USD|EUR|GBP|INR|CAD|AUD|JPY)\s*|[$€£₹]\s*)-?\d{1,3}(?:[ ,]\d{3})*(?:\.\d{1,2})?\b/gi)].slice(0, 30).map(match => match[0].trim());
    const dates = [...value.matchAll(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/gi)].slice(0, 30).map(match => match[0]);
    return { identifiers, amounts:[...new Set(amounts)], dates:[...new Set(dates)] };
  }

  function analyze(text) {
    const sensitive = detectSensitive(text);
    return { classification:classify(text), sensitive:{ counts:sensitiveCounts(sensitive), findings:sensitive }, structured:extractStructured(text) };
  }

  return { CLASSIFIERS, luhn, validIban, detectSensitive, sensitiveCounts, redact, classify, extractStructured, analyze };
});
