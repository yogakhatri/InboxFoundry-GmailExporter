(function initExportEngine(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), exportEngine: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createExportEngine() {
  'use strict';

  // Writers take async iterables and yield text pieces, so an export never has to fit in one string.
  const sha256 = globalThis.InboxFoundry?.sha256 || (typeof require === 'function' ? require('./sha256.js') : null);
  const encoder = new TextEncoder();

  function htmlEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function csvCell(value) {
    let text = String(value ?? '');
    if (/^\s*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  const csvRow = values => `${values.map(csvCell).join(',')}\r\n`;

  // ---- JSON ----

  async function* jsonChunks(envelope, records) {
    const head = JSON.stringify(envelope, null, 2).replace(/\n}$/, '');
    yield `${head},\n  "threads": [\n`;
    const threads = [];
    const whole = new sha256.Hasher();
    let first = true;
    for await (const record of records) {
      const json = JSON.stringify(record);
      const bytes = encoder.encode(json);
      whole.update(bytes);
      threads.push({ recordId: record.recordId, sha256: sha256.hashBytes(bytes) });
      yield `${first ? '' : ',\n'}${json}`;
      first = false;
    }
    const integrity = { algorithm: 'SHA-256', purpose: 'Detects accidental corruption of this file. It is not proof of authenticity.', threads, allThreadsSha256: whole.digestHex() };
    yield `\n  ],\n  "integrity": ${JSON.stringify(integrity)}\n}\n`;
  }

  // ---- CSV ----

  async function* messagesCsvChunks(records) {
    yield `﻿${csvRow(['recordId', 'subject', 'messageIndex', 'from', 'fromName', 'recipients', 'date', 'dateIso', 'bodyText', 'attachmentNames'])}`;
    for await (const record of records) {
      for (const message of record.messages || []) {
        yield csvRow([
          record.recordId, record.subject, message.index, message.from, message.fromName, (message.recipients || []).join('; '),
          message.date, message.dateIso, message.bodyTextRaw, (message.attachments || []).map(item => item.fileName).join('; ')
        ]);
      }
    }
  }

  async function* attachmentsCsvChunks(attachments) {
    yield `﻿${csvRow(['subject', 'messageIndex', 'fileName', 'sizeBytes', 'selected', 'state', 'savedAs', 'reasons', 'error'])}`;
    for await (const item of attachments) {
      yield csvRow([
        item.subject, item.messageIndex, item.fileName, item.sizeBytes, item.selected ? 'yes' : 'no', item.driveLink ? 'google-drive-link' : item.state,
        item.finalPath, (item.reasons || []).join('; '), item.error
      ]);
    }
  }

  // ---- HTML: readable, searchable, and printable to PDF with any language's characters ----

  const HTML_STYLE = 'body{font:14px/1.55 system-ui,sans-serif;max-width:900px;margin:30px auto;padding:0 20px;color:#17251c}header,article{border-bottom:1px solid #ccd6ce;padding:16px 0}h1,h2,h3{line-height:1.2}.meta{color:#657269;font-size:12px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #aebbb1;border-radius:7px}button{margin-top:8px;padding:8px 12px}article[hidden]{display:none}@media print{body{margin:0;max-width:none}#tools{display:none}article{break-before:page}}';
  const HTML_SCRIPT = "document.getElementById('search').addEventListener('input',function(){var q=this.value.toLocaleLowerCase();document.querySelectorAll('article').forEach(function(a){a.hidden=q&&!a.textContent.toLocaleLowerCase().includes(q)})});document.getElementById('print').addEventListener('click',function(){window.print()})";

  async function* htmlChunks(envelope, records) {
    const partial = envelope.job?.isPartial ? ' · Partial export' : '';
    yield `<!doctype html><html><head><meta charset="utf-8"><title>InboxFoundry export</title><style>${HTML_STYLE}</style></head><body><header><h1>InboxFoundry export</h1><p>${htmlEscape(envelope.job?.name)} · ${htmlEscape(envelope.exportedAt)}</p><p>${envelope.totals?.matchedThreads || 0} conversations · ${envelope.totals?.messages || 0} messages${partial}</p><div id="tools"><input id="search" type="search" placeholder="Search this archive" aria-label="Search this archive"><button id="print" type="button">Print or save as PDF</button></div></header>`;
    for await (const record of records) {
      const messages = (record.messages || []).map(message => {
        const sender = message.fromName ? `${message.fromName} <${message.from}>` : message.from;
        return `<section><h3>${htmlEscape(sender || 'Unknown sender')}</h3><p class="meta">${htmlEscape(message.date)} · To: ${htmlEscape((message.recipients || []).join(', '))}</p><pre>${htmlEscape(message.bodyTextRaw)}</pre></section>`;
      }).join('');
      yield `<article><h2>${htmlEscape(record.subject || '(No subject)')}</h2>${messages}</article>`;
    }
    yield `<script>${HTML_SCRIPT}</script></body></html>`;
  }

  // ---- EML / MBOX ----

  function toBase64(bytes) {
    const size = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += size) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
    }
    return btoa(binary);
  }

  function cleanHeader(value, fallback = '') {
    return String(value ?? fallback).replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000) || fallback;
  }

  function headerWord(value, fallback = '') {
    const text = cleanHeader(value, fallback);
    if (!text || (/^[\x20-\x7e]*$/.test(text) && !text.includes('=?'))) return text;
    const words = [];
    let chunk = '';
    let bytes = 0;
    for (const char of text) {
      const size = encoder.encode(char).length;
      if (chunk && bytes + size > 40) {
        words.push(`=?UTF-8?B?${toBase64(encoder.encode(chunk))}?=`);
        chunk = '';
        bytes = 0;
      }
      chunk += char;
      bytes += size;
    }
    if (chunk) words.push(`=?UTF-8?B?${toBase64(encoder.encode(chunk))}?=`);
    return words.join('\r\n ');
  }

  function base64Body(value) {
    const encoded = toBase64(encoder.encode(String(value ?? '').replace(/\r?\n/g, '\r\n')));
    return encoded.match(/.{1,76}/g)?.join('\r\n') || '';
  }

  function resolvedDate(message, fallback) {
    const date = new Date(message?.dateIso || '');
    if (!Number.isNaN(date.getTime())) return { date, estimated: false };
    const backup = new Date(fallback || 0);
    return { date: Number.isNaN(backup.getTime()) ? new Date(0) : backup, estimated: true };
  }

  function mboxDate(date) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = value => String(value).padStart(2, '0');
    return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
  }

  /** Unique across batches, so mail clients that de-duplicate on Message-ID don't merge different messages. */
  function messageIdFor(record, message, context) {
    const raw = message.messageId || `${context.jobId || 'job'}-${record.recordId || 'thread'}-${message.index}`;
    return `<inboxfoundry-${String(raw).replace(/[^A-Za-z0-9._-]/g, '-')}@local.invalid>`;
  }

  function addressHeader(message) {
    const address = cleanHeader(message.from, 'unknown-sender@local.invalid');
    if (!message.fromName || !address.includes('@')) return address;
    return `${headerWord(message.fromName)} <${address}>`;
  }

  function reconstructedEml(record, message, context = {}) {
    const { date, estimated } = resolvedDate(message, context.exportedAt);
    const messages = record.messages || [];
    const position = messages.indexOf(message);
    const earlier = position > 0 ? messages.slice(0, position).map(item => messageIdFor(record, item, context)) : [];
    const headers = [
      `Date: ${date.toUTCString()}`,
      `From: ${addressHeader(message)}`,
      `To: ${cleanHeader((message.recipients || []).join(', '), 'undisclosed-recipients:;')}`,
      `Subject: ${headerWord(record.subject, '(No subject)')}`,
      `Message-ID: ${messageIdFor(record, message, context)}`,
      'MIME-Version: 1.0',
      'X-InboxFoundry-Reconstructed: true',
      'X-InboxFoundry-Source: Gmail page capture; not the original message source. To and Cc are merged in To.'
    ];
    if (earlier.length) headers.push(`In-Reply-To: ${earlier.at(-1)}`, `References: ${earlier.join('\r\n ')}`);
    if (estimated) headers.push('X-InboxFoundry-Date-Estimated: true');
    const names = (message.attachments || []).map(item => item.fileName).filter(Boolean);
    if (names.length) headers.push(`X-InboxFoundry-Attachment-Names: ${headerWord(names.join(', '))}`);

    const plain = `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Body(message.bodyTextRaw)}\r\n`;
    if (!message.bodyHtmlRaw) return `${headers.join('\r\n')}\r\n${plain}`;
    const boundary = `inboxfoundry-${(position + 1) || 1}-alt`;
    const html = `Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Body(message.bodyHtmlRaw)}\r\n`;
    return `${headers.join('\r\n')}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${plain}--${boundary}\r\n${html}--${boundary}--\r\n`;
  }

  async function* mboxChunks(records, context = {}) {
    for await (const record of records) {
      for (const message of record.messages || []) {
        const sender = cleanHeader(message.from).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/i)?.[0] || 'MAILER-DAEMON';
        // Bodies are base64, so no line can begin with "From " and need escaping.
        yield `From ${sender} ${mboxDate(resolvedDate(message, context.exportedAt).date)}\r\n${reconstructedEml(record, message, context)}\r\n`;
      }
    }
  }

  // ---- ZIP (stored, deterministic, built from Blobs so large files don't need one big array) ----

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32Update(crc, bytes) {
    let value = crc;
    for (let index = 0; index < bytes.length; index++) value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
    return value >>> 0;
  }

  function zipName(value) {
    const parts = String(value ?? 'file').normalize('NFC').replace(/\\/g, '/').split('/')
      .filter(part => part && part !== '.' && part !== '..')
      .map(part => part.replace(/[\u0000-\u001f\u007f]/g, '_'));
    return parts.join('/') || 'file';
  }

  function archiveComponent(value, fallback = 'record') {
    const text = String(value || fallback).normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/g, '_').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 100);
  }

  class ZipBuilder {
    constructor() {
      this.parts = [];
      this.central = [];
      this.offset = 0;
      this.names = new Set();
      this.checksums = [];
    }

    uniqueName(name) {
      const safe = zipName(name);
      if (!this.names.has(safe)) {
        this.names.add(safe);
        return safe;
      }
      const dot = safe.lastIndexOf('.');
      for (let copy = 2; ; copy++) {
        const candidate = dot > 0 ? `${safe.slice(0, dot)} (${copy})${safe.slice(dot)}` : `${safe} (${copy})`;
        if (!this.names.has(candidate)) {
          this.names.add(candidate);
          return candidate;
        }
      }
    }

    /** Adds an existing file in bounded slices, so large files don't load into memory at once. */
    async addBlob(name, blob) {
      const size = 4 * 1024 * 1024;
      const pieces = async function* pieces() {
        for (let offset = 0; offset < blob.size; offset += size) {
          yield new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
        }
      };
      await this.add(name, pieces());
    }

    /** Adds an entry from a string, or from an async iterable of text or byte pieces. */
    async add(name, source) {
      if (this.central.length >= 65535) throw new Error('This export has too many files for one ZIP. Choose MBOX instead of EML, or narrow the search.');
      const entryName = this.uniqueName(name);
      const nameBytes = encoder.encode(entryName);
      const hasher = new sha256.Hasher();
      const chunks = [];
      let crc = 0xffffffff;
      let size = 0;
      const push = piece => {
        const bytes = typeof piece === 'string' ? encoder.encode(piece) : piece;
        crc = crc32Update(crc, bytes);
        hasher.update(bytes);
        size += bytes.length;
        chunks.push(bytes);
      };
      if (typeof source === 'string') push(source);
      else for await (const piece of source) push(piece);
      crc = (crc ^ 0xffffffff) >>> 0;
      if (size > 0xfffffffe || this.offset > 0xfffffffe) throw new Error('This export is larger than a ZIP file can hold (4 GB). Narrow the search or choose fewer formats.');

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, this.offset, true);
      central.set(nameBytes, 46);

      this.parts.push(local, new Blob(chunks));
      this.central.push(central);
      this.offset += local.length + size;
      this.checksums.push(`${hasher.digestHex()}  ${entryName}`);
    }

    async addChecksums() {
      await this.add('CHECKSUMS.sha256', `${this.checksums.join('\n')}\n`);
    }

    finish() {
      if (!this.central.length) throw new Error('A ZIP file needs at least one entry.');
      const centralSize = this.central.reduce((total, part) => total + part.length, 0);
      const end = new Uint8Array(22);
      const view = new DataView(end.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, this.central.length, true);
      view.setUint16(10, this.central.length, true);
      view.setUint32(12, centralSize, true);
      view.setUint32(16, this.offset, true);
      return new Blob([...this.parts, ...this.central, end], { type: 'application/zip' });
    }
  }

  // ---- Encryption: chunked AES-256-GCM, so any size works and truncation or reordering is detected ----

  const ENCRYPTION_MAGIC = 'INBOXFOUNDRY-ENC2\n';
  const PBKDF2_ITERATIONS = 600000;
  const ENCRYPTION_CHUNK = 16 * 1024 * 1024;

  function toHex(bytes) {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function fromHex(text) {
    return Uint8Array.from(String(text).match(/.{2}/g) || [], pair => parseInt(pair, 16));
  }

  async function deriveKey(passphrase, salt, iterations, usage, cryptoApi) {
    const material = await cryptoApi.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return cryptoApi.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }

  function chunkParameters(prefix, index, isLast) {
    const iv = new Uint8Array(12);
    iv.set(prefix, 0);
    new DataView(iv.buffer).setUint32(8, index, false);
    return { name: 'AES-GCM', iv, additionalData: Uint8Array.of(isLast ? 1 : 0) };
  }

  async function encryptBlob(blob, passphrase, options = {}) {
    if (String(passphrase ?? '').length < 10) throw new Error('Use a passphrase of at least 10 characters.');
    const cryptoApi = options.cryptoApi || globalThis.crypto;
    const chunkSize = options.chunkSize || ENCRYPTION_CHUNK;
    const salt = cryptoApi.getRandomValues(new Uint8Array(16));
    const prefix = cryptoApi.getRandomValues(new Uint8Array(8));
    const iterations = options.iterations || PBKDF2_ITERATIONS;
    const key = await deriveKey(passphrase, salt, iterations, 'encrypt', cryptoApi);
    const header = JSON.stringify({ cipher: 'AES-256-GCM', kdf: 'PBKDF2-HMAC-SHA-256', iterations, salt: toHex(salt), noncePrefix: toHex(prefix), chunkSize, contentName: options.contentName || 'export.zip' });
    const parts = [ENCRYPTION_MAGIC, `${header}\n`];
    const chunks = Math.max(1, Math.ceil(blob.size / chunkSize));
    for (let index = 0; index < chunks; index++) {
      const plain = await blob.slice(index * chunkSize, (index + 1) * chunkSize).arrayBuffer();
      parts.push(new Uint8Array(await cryptoApi.subtle.encrypt(chunkParameters(prefix, index, index === chunks - 1), key, plain)));
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  }

  async function decryptBlob(blob, passphrase, options = {}) {
    const cryptoApi = options.cryptoApi || globalThis.crypto;
    const headRegion = new TextDecoder().decode(await blob.slice(0, 2048).arrayBuffer());
    if (!headRegion.startsWith(ENCRYPTION_MAGIC)) throw new Error('This is not an InboxFoundry encrypted file.');
    const headerEnd = headRegion.indexOf('\n', ENCRYPTION_MAGIC.length);
    const header = JSON.parse(headRegion.slice(ENCRYPTION_MAGIC.length, headerEnd));
    const key = await deriveKey(passphrase, fromHex(header.salt), header.iterations, 'decrypt', cryptoApi);
    const prefix = fromHex(header.noncePrefix);
    const cipherChunk = header.chunkSize + 16;
    const start = headerEnd + 1;
    const chunks = Math.ceil((blob.size - start) / cipherChunk);
    const parts = [];
    for (let index = 0; index < chunks; index++) {
      const from = start + index * cipherChunk;
      const encrypted = await blob.slice(from, from + cipherChunk).arrayBuffer();
      parts.push(new Uint8Array(await cryptoApi.subtle.decrypt(chunkParameters(prefix, index, index === chunks - 1), key, encrypted)));
    }
    return { blob: new Blob(parts), contentName: header.contentName };
  }

  return {
    csvCell, jsonChunks, messagesCsvChunks, attachmentsCsvChunks, htmlChunks, reconstructedEml, mboxChunks, archiveComponent,
    ZipBuilder, encryptBlob, decryptBlob, PBKDF2_ITERATIONS
  };
});
