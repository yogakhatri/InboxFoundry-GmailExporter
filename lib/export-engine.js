(function initExportEngine(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), exportEngine: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createExportEngine() {
  'use strict';

  function htmlEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  }

  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function printableHtml(envelope) {
    const threads = (envelope.threads || []).map(thread => `<article><h2>${htmlEscape(thread.subject || '(No subject)')}</h2><p class="meta">Thread ${htmlEscape(thread.threadKey || thread.recordId)}</p>${(thread.messages || []).map(message => `<section><h3>${htmlEscape(message.from || 'Unknown sender')}</h3><p class="meta">${htmlEscape(message.date || '')} · To: ${htmlEscape((message.recipients || []).join(', '))}</p><pre>${htmlEscape(message.bodyTextRaw || '')}</pre></section>`).join('')}</article>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>InboxFoundry export</title><style>body{font:14px/1.55 system-ui,sans-serif;max-width:900px;margin:30px auto;padding:0 20px;color:#17251c}header,article{border-bottom:1px solid #ccd6ce;padding:16px 0}h1,h2,h3{line-height:1.2}.meta{color:#657269;font-size:12px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}input{width:100%;padding:10px;border:1px solid #aebbb1;border-radius:7px}article[hidden]{display:none}@media print{body{margin:0;max-width:none}#search{display:none}article{break-before:page}}</style></head><body><header><h1>InboxFoundry export</h1><p>${htmlEscape(envelope.job?.name || '')} · ${htmlEscape(envelope.exportedAt || '')}</p><p>${envelope.totals?.matchedThreads || 0} threads · ${envelope.totals?.capturedMessages || 0} messages${envelope.job?.isPartial ? ' · Partial export' : ''}</p><input id="search" type="search" placeholder="Search this local archive" aria-label="Search this local archive"></header>${threads}<script>document.getElementById('search').addEventListener('input',function(){var q=this.value.toLocaleLowerCase();document.querySelectorAll('article').forEach(function(a){a.hidden=q&&!a.textContent.toLocaleLowerCase().includes(q)})})</script></body></html>`;
  }

  function toBase64(bytes) {
    if (typeof btoa === 'function') { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
    return Buffer.from(bytes).toString('base64');
  }

  function fromBase64(value) {
    if (typeof atob === 'function') { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  async function encryptText(text, passphrase, cryptoApi = globalThis.crypto) {
    if (!passphrase || String(passphrase).length < 10) throw new Error('Passphrase must contain at least 10 characters.');
    if (!cryptoApi?.subtle) throw new Error('Web Crypto is unavailable.');
    const encoder = new TextEncoder();
    const salt = cryptoApi.getRandomValues(new Uint8Array(16));
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const material = await cryptoApi.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await cryptoApi.subtle.deriveKey({ name:'PBKDF2', salt, iterations:250000, hash:'SHA-256' }, material, { name:'AES-GCM', length:256 }, false, ['encrypt']);
    const encrypted = await cryptoApi.subtle.encrypt({ name:'AES-GCM', iv }, key, encoder.encode(text));
    return JSON.stringify({ format:'InboxFoundryEncrypted', version:1, cipher:'AES-256-GCM', kdf:{ name:'PBKDF2-HMAC-SHA-256', iterations:250000, salt:toBase64(salt) }, iv:toBase64(iv), ciphertext:toBase64(new Uint8Array(encrypted)) });
  }

  async function decryptText(packageText, passphrase, cryptoApi = globalThis.crypto) {
    const value = JSON.parse(packageText);
    if (value.format !== 'InboxFoundryEncrypted' || value.version !== 1) throw new Error('Unsupported encrypted archive format.');
    const encoder = new TextEncoder();
    const material = await cryptoApi.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await cryptoApi.subtle.deriveKey({ name:'PBKDF2', salt:fromBase64(value.kdf.salt), iterations:value.kdf.iterations, hash:'SHA-256' }, material, { name:'AES-GCM', length:256 }, false, ['decrypt']);
    const decrypted = await cryptoApi.subtle.decrypt({ name:'AES-GCM', iv:fromBase64(value.iv) }, key, fromBase64(value.ciphertext));
    return new TextDecoder().decode(decrypted);
  }

  function splitEnvelope(envelope, recordsPerPart) {
    const size = Number(recordsPerPart);
    if (!Number.isFinite(size) || size < 1 || (envelope.threads || []).length <= size) return [{ ...envelope, part: null }];
    const count = Math.ceil(envelope.threads.length / size);
    return Array.from({ length: count }, (_, index) => {
      const threads = envelope.threads.slice(index * size, (index + 1) * size);
      const keys = new Set(threads.map(thread => thread.threadKey || thread.recordId));
      return { ...envelope, part: { index:index + 1, count }, threads, integrity: envelope.integrity ? { ...envelope.integrity, threads:(envelope.integrity.threads || []).filter(item => keys.has(item.threadKey)), exportSha256:null } : undefined };
    });
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipName(value) {
    const parts = String(value || 'file').normalize('NFC').replace(/\\/g, '/').split('/')
      .filter(part => part && part !== '.' && part !== '..')
      .map(part => part.replace(/[\u0000-\u001f\u007f]/g, '_'));
    return parts.join('/') || 'file';
  }

  function archiveComponent(value, fallback = 'record') {
    const text = String(value || fallback).normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/g, '_').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 100);
  }

  function concatBytes(parts) {
    const size = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
  }

  function zipArchive(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('A ZIP package needs at least one file.');
    if (entries.length > 65535) throw new Error('Too many ZIP package entries.');
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
      const name = zipName(entry?.name);
      const nameBytes = encoder.encode(name);
      const data = entry?.data instanceof Uint8Array ? entry.data : encoder.encode(String(entry?.data ?? ''));
      if (nameBytes.length > 65535 || data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP package exceeds classic ZIP limits.');
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true); local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      central.set(nameBytes, 46); centralParts.push(central);
      offset += local.length + data.length;
    }

    const central = concatBytes(centralParts);
    if (offset + central.length > 0xffffffff) throw new Error('ZIP package exceeds classic ZIP limits.');
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, central.length, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    return concatBytes([...localParts, central, end]);
  }

  function wrapText(text, width = 92) {
    const lines = [];
    for (const paragraph of String(text || '').replace(/\r/g, '').split('\n')) {
      let remaining = paragraph;
      while (remaining.length > width) {
        let cut = remaining.lastIndexOf(' ', width);
        if (cut < width / 2) cut = width;
        lines.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).trimStart();
      }
      lines.push(remaining);
    }
    return lines;
  }

  function pdfEscape(value) {
    return String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');
  }

  function basicPdf(envelope) {
    const lines = [`InboxFoundry - ${envelope.job?.name || 'Export'}`, `${envelope.totals?.matchedThreads || 0} threads / ${envelope.totals?.capturedMessages || 0} messages`, ''];
    for (const thread of envelope.threads || []) {
      lines.push(`# ${thread.subject || '(No subject)'}`);
      for (const message of thread.messages || []) {
        lines.push(`From: ${message.from || ''}`, `Date: ${message.date || ''}`);
        lines.push(...wrapText(message.bodyTextRaw || ''));
        lines.push('', '---', '');
      }
    }
    const pages = [];
    for (let i = 0; i < lines.length; i += 58) pages.push(lines.slice(i, i + 58));
    if (!pages.length) pages.push(['InboxFoundry export', 'No matching messages.']);

    const objects = new Map();
    const pageIds = pages.map((_, index) => 4 + index * 2);
    objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    objects.set(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
    objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    pages.forEach((pageLines, index) => {
      const pageId = pageIds[index]; const contentId = pageId + 1;
      const stream = `BT /F1 9 Tf 42 800 Td 12 TL ${pageLines.map(line => `(${pdfEscape(line)}) Tj T*`).join(' ')} ET`;
      objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
      objects.set(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });
    const maxId = Math.max(...objects.keys());
    let output = '%PDF-1.4\n'; const offsets = [0];
    for (let id = 1; id <= maxId; id++) { offsets[id] = output.length; output += `${id} 0 obj\n${objects.get(id)}\nendobj\n`; }
    const xref = output.length;
    output += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= maxId; id++) output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    output += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return output;
  }

  function individualPdfEntries(envelope) {
    return (envelope.threads || []).map((thread, index) => {
      const name = `${String(index + 1).padStart(5, '0')} - ${archiveComponent(thread.subject, 'No subject')}.pdf`;
      const messages = thread.messages?.length || 0;
      const single = { ...envelope, totals:{ ...(envelope.totals || {}), matchedThreads:1, capturedMessages:messages }, threads:[thread] };
      return { name, data:basicPdf(single), threadKey:thread.threadKey || thread.recordId || null, subject:thread.subject || '(No subject)', messageCount:messages };
    });
  }

  function cleanHeader(value, fallback = '') {
    return String(value ?? fallback).replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000) || fallback;
  }

  function headerWord(value, fallback = '') {
    const text = cleanHeader(value, fallback).slice(0, 500);
    if (!text || (/^[\x20-\x7e]*$/.test(text) && !text.includes('=?'))) return text;
    const words = [];
    let chunk = '';
    let bytes = 0;
    for (const char of text) {
      const size = new TextEncoder().encode(char).length;
      if (chunk && bytes + size > 40) { words.push(`=?UTF-8?B?${toBase64(new TextEncoder().encode(chunk))}?=`); chunk = ''; bytes = 0; }
      chunk += char; bytes += size;
    }
    if (chunk) words.push(`=?UTF-8?B?${toBase64(new TextEncoder().encode(chunk))}?=`);
    return words.join('\r\n ');
  }

  function base64Lines(value) {
    const encoded = toBase64(new TextEncoder().encode(String(value ?? '').replace(/\r?\n/g, '\r\n')));
    return encoded.match(/.{1,76}/g)?.join('\r\n') || '';
  }

  function resolvedDate(value, fallback) {
    const primary = new Date(value || 0);
    if (!Number.isNaN(primary.getTime()) && value) return primary;
    const secondary = new Date(fallback || 0);
    return Number.isNaN(secondary.getTime()) ? new Date(0) : secondary;
  }

  function portableDate(value, fallback) {
    return resolvedDate(value, fallback).toUTCString();
  }

  function mboxDate(value, fallback) {
    const date = resolvedDate(value, fallback);
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')} ${date.getUTCFullYear()}`;
  }

  function reconstructedEml(thread, message, context = {}) {
    const threadOrdinal = Number(context.threadOrdinal) || 1;
    const messageOrdinal = Number(context.messageOrdinal) || Number(message?.index) || 1;
    const subject = thread?.subject || '(No subject)';
    const recipients = Array.isArray(message?.recipients) ? message.recipients : [];
    const attachmentNames = (message?.attachments || []).map(item => item?.fileName || item?.name).filter(Boolean);
    const headers = [
      `Date: ${portableDate(message?.date, context.exportedAt)}`,
      `From: ${cleanHeader(message?.from, 'Unknown sender')}`,
      `To: ${cleanHeader(recipients.join(', '), 'undisclosed-recipients:;')}`,
      `Subject: ${headerWord(subject, '(No subject)')}`,
      `Message-ID: <inboxfoundry-${threadOrdinal}-${messageOrdinal}@local.invalid>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      'X-InboxFoundry-Reconstructed: true',
      'X-InboxFoundry-Source: Gmail DOM export; not original raw RFC 5322 source'
    ];
    if (attachmentNames.length) headers.push(`X-InboxFoundry-Attachment-Names: ${headerWord(attachmentNames.join(', '))}`);
    return `${headers.join('\r\n')}\r\n\r\n${base64Lines(message?.bodyTextRaw || '')}\r\n`;
  }

  function emlEntries(envelope) {
    const entries = [];
    for (const [threadIndex, thread] of (envelope.threads || []).entries()) {
      for (const [messageIndex, message] of (thread.messages || []).entries()) {
        entries.push({
          name:`${String(threadIndex + 1).padStart(5, '0')} - ${archiveComponent(thread.subject, 'No subject')}/message-${String(messageIndex + 1).padStart(3, '0')}.eml`,
          data:reconstructedEml(thread, message, { threadOrdinal:threadIndex + 1, messageOrdinal:messageIndex + 1, exportedAt:envelope.exportedAt }),
          threadKey:thread.threadKey || thread.recordId || null,
          subject:thread.subject || '(No subject)',
          messageIndex:message.index ?? messageIndex + 1
        });
      }
    }
    return entries;
  }

  function reconstructedMbox(envelope) {
    const records = [];
    for (const [threadIndex, thread] of (envelope.threads || []).entries()) {
      for (const [messageIndex, message] of (thread.messages || []).entries()) {
        const sender = cleanHeader(message?.from).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/i)?.[0] || 'MAILER-DAEMON';
        const date = mboxDate(message?.date, envelope.exportedAt);
        const eml = reconstructedEml(thread, message, { threadOrdinal:threadIndex + 1, messageOrdinal:messageIndex + 1, exportedAt:envelope.exportedAt });
        records.push(`From ${sender} ${date}\r\n${eml}`);
      }
    }
    return records.join('\r\n');
  }

  return { htmlEscape, csvCell, printableHtml, wrapText, basicPdf, encryptText, decryptText, splitEnvelope, zipArchive, zipName, archiveComponent, individualPdfEntries, cleanHeader, headerWord, portableDate, mboxDate, reconstructedEml, emlEntries, reconstructedMbox };
});
