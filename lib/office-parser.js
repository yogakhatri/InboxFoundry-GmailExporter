(function initOfficeParser(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), officeParser: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createOfficeParser() {
  'use strict';

  const OFFICE_EXTENSIONS = new Set(['docx','xlsx','pptx']);

  function extensionOf(name) {
    return String(name || '').toLocaleLowerCase().match(/\.([^.\s]+)$/u)?.[1] || '';
  }

  function findEnd(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) return offset;
    }
    throw new Error('office-zip-end-missing');
  }

  function safeEntryName(value) {
    const name = String(value || '').replace(/\\/g, '/');
    if (name.startsWith('/') || name.split('/').some(part => part === '..')) throw new Error('office-zip-unsafe-path');
    return name;
  }

  function readDirectory(input, limits = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = findEnd(bytes);
    const count = view.getUint16(end + 10, true);
    const directorySize = view.getUint32(end + 12, true);
    const directoryOffset = view.getUint32(end + 16, true);
    const maxEntries = limits.maxEntries || 5000;
    const maxUncompressedBytes = limits.maxUncompressedBytes || 64 * 1024 * 1024;
    const maxEntryBytes = limits.maxEntryBytes || 16 * 1024 * 1024;
    if (count > maxEntries) throw new Error('office-zip-entry-limit');
    if (directoryOffset + directorySize > bytes.length) throw new Error('office-zip-directory-bounds');
    const decoder = new TextDecoder('utf-8', { fatal:false });
    const entries = [];
    let offset = directoryOffset;
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('office-zip-directory-corrupt');
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const crc32 = view.getUint32(offset + 16, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      if (flags & 1) throw new Error('office-zip-encrypted');
      if (![0, 8].includes(method)) throw new Error('office-zip-compression-unsupported');
      if (uncompressedSize > maxEntryBytes) throw new Error('office-zip-entry-size-limit');
      total += uncompressedSize;
      if (total > maxUncompressedBytes) throw new Error('office-zip-total-size-limit');
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > bytes.length) throw new Error('office-zip-name-bounds');
      const name = safeEntryName(decoder.decode(bytes.subarray(nameStart, nameEnd)));
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('office-zip-local-header-corrupt');
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedSize > bytes.length) throw new Error('office-zip-data-bounds');
      entries.push({ name, method, crc32, compressedSize, uncompressedSize, dataOffset });
      offset = nameEnd + extraLength + commentLength;
    }
    return { bytes, entries, totalUncompressedBytes:total };
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function defaultInflateRaw(bytes, maxOutputBytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('office-deflate-unavailable');
    let stream;
    try { stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
    catch (_) { throw new Error('office-deflate-unavailable'); }
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (Number.isFinite(maxOutputBytes) && total > maxOutputBytes) {
          await reader.cancel('office-zip-inflate-limit');
          throw new Error('office-zip-inflate-limit');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  }

  async function entryBytes(directory, entry, options = {}) {
    const compressed = directory.bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    const value = entry.method === 0 ? new Uint8Array(compressed) : await (options.inflateRaw || defaultInflateRaw)(compressed, entry.uncompressedSize);
    if (value.length !== entry.uncompressedSize) throw new Error('office-zip-size-mismatch');
    if (crc32(value) !== entry.crc32) throw new Error('office-zip-crc-mismatch');
    return value;
  }

  function decodeXml(value) {
    return String(value || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  function taggedText(xml, tagPattern) {
    const values = [];
    const regex = new RegExp(`<${tagPattern}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern}>`, 'gi');
    for (const match of String(xml || '').matchAll(regex)) values.push(decodeXml(match[1].replace(/<[^>]+>/g, '')));
    return values;
  }

  function docxSegments(files) {
    return [...files.entries()].filter(([name]) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, xml]) => ({ source:name === 'word/document.xml' ? 'Document' : name.replace(/^word\//, '').replace(/\.xml$/i, ''), text:decodeXml(xml.replace(/<w:tab\b[^>]*\/>/gi, '\t').replace(/<w:(?:br|cr)\b[^>]*\/>/gi, '\n').replace(/<\/w:tc>/gi, '\t').replace(/<\/w:tr>/gi, '\n').replace(/<\/w:p>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() }))
      .filter(segment => segment.text);
  }

  function pptxSegments(files) {
    return [...files.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort(([a], [b]) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]))
      .map(([name, xml]) => ({ source:`Slide ${name.match(/slide(\d+)/i)?.[1]}`, text:taggedText(xml, 'a:t').join('\n').trim() }))
      .filter(segment => segment.text);
  }

  function xlsxSegments(files) {
    const sharedXml = files.get('xl/sharedStrings.xml') || '';
    const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(match => taggedText(match[1], 't').join(''));
    const sheets = [...files.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort(([a], [b]) => Number(a.match(/sheet(\d+)/i)?.[1]) - Number(b.match(/sheet(\d+)/i)?.[1]));
    return sheets.map(([name, xml]) => {
      const rows = [];
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
        const cells = [];
        for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
          const reference = cell[1].match(/\br=["']([A-Z]+)\d+["']/i)?.[1] || '';
          if (reference) {
            let column = 0;
            for (const letter of reference.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
            while (cells.length < column - 1) cells.push('');
          }
          const type = cell[1].match(/\bt=["']([^"']+)["']/i)?.[1] || '';
          let value = taggedText(cell[2], 'v')[0] ?? taggedText(cell[2], 't').join('');
          if (type === 's' && /^\d+$/.test(value)) value = shared[Number(value)] ?? value;
          if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
          cells.push(value);
        }
        rows.push(cells.join('\t'));
      }
      return { source:`Sheet ${name.match(/sheet(\d+)/i)?.[1]}`, text:rows.join('\n').trim() };
    }).filter(segment => segment.text);
  }

  async function parseOffice(input, fileName, options = {}) {
    const format = extensionOf(fileName);
    if (!OFFICE_EXTENSIONS.has(format)) throw new Error('office-format-unsupported');
    const directory = readDirectory(input, options);
    const decoder = new TextDecoder('utf-8', { fatal:false });
    const files = new Map();
    const wanted = directory.entries.filter(entry => {
      if (format === 'docx') return /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(entry.name);
      if (format === 'pptx') return /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name);
      return entry.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name);
    });
    for (const entry of wanted) files.set(entry.name, decoder.decode(await entryBytes(directory, entry, options)));
    const segments = format === 'docx' ? docxSegments(files) : format === 'pptx' ? pptxSegments(files) : xlsxSegments(files);
    const extracted = segments.map(segment => `${segment.source}\n${segment.text}`).join('\n\n').trim();
    const maxTextCharacters = options.maxTextCharacters || 5_000_000;
    const text = extracted.slice(0, maxTextCharacters);
    let remaining = maxTextCharacters;
    const boundedSegments = segments.map(segment => { const bounded = { source:segment.source, text:segment.text.slice(0, Math.max(0, remaining)) }; remaining -= bounded.text.length; return bounded; }).filter(segment => segment.text);
    return { format, text, segments:boundedSegments, truncated:extracted.length > maxTextCharacters, entryCount:directory.entries.length, parsedEntryCount:wanted.length, totalUncompressedBytes:directory.totalUncompressedBytes };
  }

  return { OFFICE_EXTENSIONS, extensionOf, readDirectory, entryBytes, decodeXml, taggedText, docxSegments, xlsxSegments, pptxSegments, parseOffice };
});
