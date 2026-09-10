(function initPdfParser(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), pdfParser: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createPdfParser() {
  'use strict';

  function latin1(bytes) {
    let output = '';
    const size = 32768;
    for (let offset = 0; offset < bytes.length; offset += size) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + size));
      output += String.fromCharCode(...chunk);
    }
    return output;
  }

  async function inflate(bytes, maxOutputBytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('pdf-deflate-unavailable');
    let stream;
    try { stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')); }
    catch (_) { throw new Error('pdf-deflate-unavailable'); }
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxOutputBytes) { await reader.cancel('pdf-stream-size-limit'); throw new Error('pdf-stream-size-limit'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  function byteWriter(maxOutputBytes) {
    const limit = Math.max(0, Number(maxOutputBytes) || 0);
    let buffer = new Uint8Array(Math.min(limit, 4096));
    let length = 0;
    const ensure = count => {
      const required = length + count;
      if (required > limit) throw new Error('pdf-stream-size-limit');
      if (required <= buffer.length) return;
      const expanded = new Uint8Array(Math.min(limit, Math.max(required, buffer.length ? buffer.length * 2 : 64)));
      expanded.set(buffer.subarray(0, length));
      buffer = expanded;
    };
    return {
      byte(value) { ensure(1); buffer[length++] = value; },
      bytes(values) { ensure(values.length); buffer.set(values, length); length += values.length; },
      finish() { return buffer.slice(0, length); }
    };
  }

  function asciiHexDecode(bytes, maxOutputBytes) {
    const digits = [];
    for (const byte of bytes) {
      const char = String.fromCharCode(byte);
      if (/\s/.test(char)) continue;
      if (char === '>') break;
      if (!/[0-9a-f]/i.test(char)) throw new Error('pdf-asciihex-invalid');
      digits.push(char);
      if (Math.ceil(digits.length / 2) > maxOutputBytes) throw new Error('pdf-stream-size-limit');
    }
    if (digits.length % 2) digits.push('0');
    const output = new Uint8Array(digits.length / 2);
    for (let index = 0; index < digits.length; index += 2) output[index / 2] = Number.parseInt(`${digits[index]}${digits[index + 1]}`, 16);
    return output;
  }

  function ascii85Decode(bytes, maxOutputBytes) {
    let source = latin1(bytes).replace(/\s+/g, '');
    if (source.startsWith('<~')) source = source.slice(2);
    const end = source.indexOf('~>');
    if (end >= 0) source = source.slice(0, end);
    const output = byteWriter(maxOutputBytes);
    let group = [];
    const appendTuple = (values, count = 4) => {
      let tuple = 0;
      for (const value of values) tuple = tuple * 85 + value;
      const decoded = [
        Math.floor(tuple / 16777216) % 256,
        Math.floor(tuple / 65536) % 256,
        Math.floor(tuple / 256) % 256,
        tuple % 256
      ];
      output.bytes(decoded.slice(0, count));
    };
    for (const char of source) {
      if (char === 'z') {
        if (group.length) throw new Error('pdf-ascii85-invalid');
        output.bytes(Uint8Array.from([0, 0, 0, 0]));
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 33 || code > 117) throw new Error('pdf-ascii85-invalid');
      group.push(code - 33);
      if (group.length === 5) { appendTuple(group); group = []; }
    }
    if (group.length === 1) throw new Error('pdf-ascii85-invalid');
    if (group.length) {
      const originalLength = group.length;
      while (group.length < 5) group.push(84);
      appendTuple(group, originalLength - 1);
    }
    return output.finish();
  }

  function runLengthDecode(bytes, maxOutputBytes) {
    const output = byteWriter(maxOutputBytes);
    for (let index = 0; index < bytes.length;) {
      const length = bytes[index++];
      if (length === 128) break;
      if (length <= 127) {
        const count = length + 1;
        if (index + count > bytes.length) throw new Error('pdf-runlength-invalid');
        output.bytes(bytes.subarray(index, index + count));
        index += count;
      } else {
        if (index >= bytes.length) throw new Error('pdf-runlength-invalid');
        const count = 257 - length;
        const value = bytes[index++];
        for (let offset = 0; offset < count; offset++) output.byte(value);
      }
    }
    return output.finish();
  }

  function streamFilters(dictionary) {
    const token = dictionary.match(/\/Filter\s*(\[[^\]]{0,4096}\]|\/[A-Za-z0-9]+)/)?.[1];
    if (!token) return [];
    return [...token.matchAll(/\/([A-Za-z0-9]+)/g)].map(match => match[1]);
  }

  async function decodeStreamFilters(bytes, filters, maxOutputBytes, inflateFn = inflate) {
    let data = bytes;
    for (const filter of filters) {
      if (['FlateDecode','Fl'].includes(filter)) data = await inflateFn(data, maxOutputBytes);
      else if (['ASCIIHexDecode','AHx'].includes(filter)) data = asciiHexDecode(data, maxOutputBytes);
      else if (['ASCII85Decode','A85'].includes(filter)) data = ascii85Decode(data, maxOutputBytes);
      else if (['RunLengthDecode','RL'].includes(filter)) data = runLengthDecode(data, maxOutputBytes);
      else throw new Error('unsupported-stream-filter');
      if (data.length > maxOutputBytes) throw new Error('pdf-stream-size-limit');
    }
    return data;
  }

  function decodeTextBytes(bytes) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let value = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) value += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return value;
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      let value = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) value += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      return value;
    }
    return new TextDecoder('windows-1252', { fatal:false }).decode(Uint8Array.from(bytes));
  }

  function literalBytesAt(text, start) {
    if (text[start] !== '(') return null;
    const bytes = [];
    let depth = 1;
    let index = start + 1;
    while (index < text.length && depth > 0) {
      const code = text.charCodeAt(index) & 255;
      if (code === 0x5c) {
        index++;
        if (index >= text.length) break;
        const escaped = text[index];
        if (escaped === '\r' || escaped === '\n') { if (escaped === '\r' && text[index + 1] === '\n') index++; index++; continue; }
        const named = { n:10, r:13, t:9, b:8, f:12, '(':40, ')':41, '\\':92 }[escaped];
        if (named != null) { bytes.push(named); index++; continue; }
        if (/[0-7]/.test(escaped)) {
          const octal = text.slice(index).match(/^[0-7]{1,3}/)[0];
          bytes.push(Number.parseInt(octal, 8) & 255); index += octal.length; continue;
        }
        bytes.push(text.charCodeAt(index) & 255); index++; continue;
      }
      if (code === 0x28) { depth++; bytes.push(code); index++; continue; }
      if (code === 0x29) { depth--; if (depth) bytes.push(code); index++; continue; }
      bytes.push(code); index++;
    }
    if (depth !== 0) return null;
    return { bytes:Uint8Array.from(bytes), end:index };
  }

  function literalAt(text, start) {
    const parsed = literalBytesAt(text, start);
    return parsed ? { value:decodeTextBytes(parsed.bytes), end:parsed.end } : null;
  }

  function stringsInside(value, decode = decodeTextBytes) {
    const results = [];
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== '(') continue;
      const parsed = literalBytesAt(value, index);
      if (parsed) { results.push(decode(parsed.bytes)); index = parsed.end - 1; }
    }
    for (const match of value.matchAll(/<([0-9a-f\s]+)>/gi)) {
      const clean = match[1].replace(/\s+/g, '');
      const padded = clean.length % 2 ? `${clean}0` : clean;
      results.push(decode(Uint8Array.from(padded.match(/.{2}/g).map(pair => Number.parseInt(pair, 16)))));
    }
    return results;
  }

  function decoderAt(fontRuns, fontDecoders, index) {
    let name = null;
    for (const run of fontRuns) {
      if (run.index > index) break;
      name = run.name;
    }
    const decoder = name != null && fontDecoders && Object.prototype.hasOwnProperty.call(fontDecoders, name) ? fontDecoders[name] : null;
    return typeof decoder === 'function' ? decoder : decodeTextBytes;
  }

  function contentText(content, fontDecoders = {}) {
    const found = [];
    const arrayRanges = [];
    const fontRuns = [...content.matchAll(/\/([^\s<>\[\]()%/]+)\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s+Tf\b/g)]
      .map(match => ({ index:match.index, name:match[1] }));
    for (const match of content.matchAll(/\[([\s\S]*?)\]\s*TJ\b/g)) {
      arrayRanges.push([match.index, match.index + match[0].length]);
      const value = stringsInside(match[1], decoderAt(fontRuns, fontDecoders, match.index)).join('');
      if (value) found.push({ index:match.index, value });
    }
    let rangeIndex = 0;
    for (let index = 0; index < content.length; index++) {
      while (rangeIndex < arrayRanges.length && index >= arrayRanges[rangeIndex][1]) rangeIndex++;
      if (content[index] !== '(' || (arrayRanges[rangeIndex] && index >= arrayRanges[rangeIndex][0] && index < arrayRanges[rangeIndex][1])) continue;
      const parsed = literalBytesAt(content, index);
      if (!parsed) continue;
      const tail = content.slice(parsed.end).match(/^\s*(Tj\b|'|")/);
      const value = decoderAt(fontRuns, fontDecoders, index)(parsed.bytes);
      if (tail && value) found.push({ index, value });
      index = parsed.end - 1;
    }
    for (const match of content.matchAll(/<([0-9a-f\s]+)>\s*Tj\b/gi)) {
      const value = stringsInside(`<${match[1]}>`, decoderAt(fontRuns, fontDecoders, match.index))[0];
      if (value) found.push({ index:match.index, value });
    }
    return found.sort((a, b) => a.index - b.index).map(item => item.value).join('\n');
  }

  function unicodeHex(hex) {
    const clean = String(hex || '').replace(/\s+/g, '');
    if (!clean || clean.length % 2) return '';
    const bytes = Uint8Array.from(clean.match(/.{2}/g).map(pair => Number.parseInt(pair, 16)));
    if (bytes.length === 1) return String.fromCharCode(bytes[0]);
    let value = '';
    for (let index = 0; index + 1 < bytes.length; index += 2) value += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  }

  function incrementHex(hex, amount) {
    const width = hex.length;
    try { return (BigInt(`0x${hex}`) + BigInt(amount)).toString(16).padStart(width, '0').slice(-width); }
    catch (_) { return null; }
  }

  function parseToUnicodeCMap(value, maxEntries = 200000) {
    if (!/\bbegin(?:bfchar|bfrange)\b/.test(value)) return null;
    const map = new Map();
    let truncated = false;
    const add = (sourceHex, destinationHex) => {
      if (map.size >= maxEntries) { truncated = true; return false; }
      const decoded = unicodeHex(destinationHex);
      if (decoded) map.set(sourceHex.replace(/\s+/g, '').toUpperCase(), decoded);
      return true;
    };
    for (const block of value.matchAll(/\bbeginbfchar\b([\s\S]*?)\bendbfchar\b/g)) {
      for (const match of block[1].matchAll(/<([0-9a-f\s]+)>\s*<([0-9a-f\s]+)>/gi)) {
        if (!add(match[1], match[2])) break;
      }
    }
    for (const block of value.matchAll(/\bbeginbfrange\b([\s\S]*?)\bendbfrange\b/g)) {
      const lines = block[1].split(/[\r\n]+/);
      for (const line of lines) {
        const range = line.match(/<([0-9a-f\s]+)>\s*<([0-9a-f\s]+)>\s*(?:<([0-9a-f\s]+)>|\[([\s\S]*?)\])/i);
        if (!range) continue;
        const startHex = range[1].replace(/\s+/g, '');
        const endHex = range[2].replace(/\s+/g, '');
        let start;
        let end;
        try { start = BigInt(`0x${startHex}`); end = BigInt(`0x${endHex}`); }
        catch (_) { continue; }
        if (end < start || end - start > BigInt(maxEntries)) { truncated = true; continue; }
        const destinations = range[4] ? [...range[4].matchAll(/<([0-9a-f\s]+)>/gi)].map(match => match[1].replace(/\s+/g, '')) : null;
        for (let offset = 0n; start + offset <= end; offset++) {
          const source = (start + offset).toString(16).padStart(startHex.length, '0');
          const destination = destinations ? destinations[Number(offset)] : incrementHex(range[3].replace(/\s+/g, ''), offset);
          if (!destination || !add(source, destination)) break;
        }
      }
    }
    return { map, truncated };
  }

  function cmapDecoder(map) {
    const lengths = [...new Set([...map.keys()].map(key => key.length / 2))].sort((a, b) => b - a);
    return bytes => {
      let value = '';
      for (let index = 0; index < bytes.length;) {
        let matched = false;
        for (const length of lengths) {
          if (index + length > bytes.length) continue;
          let key = '';
          for (let offset = 0; offset < length; offset++) key += bytes[index + offset].toString(16).padStart(2, '0');
          const decoded = map.get(key.toUpperCase());
          if (decoded != null) { value += decoded; index += length; matched = true; break; }
        }
        if (!matched) { value += decodeTextBytes(bytes.subarray(index, index + 1)); index++; }
      }
      return value;
    };
  }

  function objectBodies(source, maxObjects) {
    const objects = new Map();
    const positions = [];
    const pattern = /(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
    let match;
    let count = 0;
    while (count < maxObjects && (match = pattern.exec(source))) {
      count++;
      const start = match.index + match[0].lastIndexOf(match[1]);
      const end = source.indexOf('endobj', pattern.lastIndex);
      if (end < 0) break;
      const key = `${match[1]} ${match[2]}`;
      objects.set(key, source.slice(pattern.lastIndex, end));
      positions.push({ key, start, end:end + 6 });
      pattern.lastIndex = end + 6;
    }
    return { objects, positions, truncated:count >= maxObjects && pattern.exec(source) != null };
  }

  function reference(value) {
    const match = String(value || '').match(/(\d+)\s+(\d+)\s+R/);
    return match ? `${match[1]} ${match[2]}` : null;
  }

  function genericReferences(body) {
    const refs = new Map();
    for (const match of String(body || '').matchAll(/\/([^\s<>\[\]()%/]+)\s+(\d+)\s+(\d+)\s+R/g)) refs.set(match[1], `${match[2]} ${match[3]}`);
    return refs;
  }

  function fontReferences(body, objects) {
    const refs = new Map();
    for (const section of String(body || '').matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const match of section[1].matchAll(/\/([^\s<>\[\]()%/]+)\s+(\d+)\s+(\d+)\s+R/g)) refs.set(match[1], `${match[2]} ${match[3]}`);
    }
    const indirectFontRef = reference(String(body || '').match(/\/Font\s+(\d+\s+\d+\s+R)/)?.[1]);
    if (indirectFontRef && objects?.has(indirectFontRef)) {
      for (const [alias, fontRef] of genericReferences(objects.get(indirectFontRef))) refs.set(alias, fontRef);
    }
    return refs;
  }

  function fontDecodersByContent(source, records, objects, cmapByObject) {
    const fontCmaps = new Map();
    for (const [key, body] of objects) {
      const cmapRef = reference(body.match(/\/ToUnicode\s+(\d+\s+\d+\s+R)/)?.[1]);
      if (cmapRef && cmapByObject.has(cmapRef)) fontCmaps.set(key, cmapByObject.get(cmapRef));
    }
    const resources = new Map();
    for (const [key, body] of objects) {
      const direct = fontReferences(body, objects);
      const resourceRef = reference(body.match(/\/Resources\s+(\d+\s+\d+\s+R)/)?.[1]);
      const referenced = resourceRef ? fontReferences(objects.get(resourceRef), objects) : new Map();
      const merged = new Map([...referenced, ...direct]);
      if (merged.size) resources.set(key, merged);
    }
    const globalAliases = new Map();
    const conflicts = new Set();
    for (const refs of resources.values()) for (const [alias, fontRef] of refs) {
      if (globalAliases.has(alias) && globalAliases.get(alias) !== fontRef) conflicts.add(alias);
      else globalAliases.set(alias, fontRef);
    }
    for (const alias of conflicts) globalAliases.delete(alias);

    const byContent = new Map();
    for (const [pageKey, body] of objects) {
      if (!/\/Type\s*\/Page\b/.test(body)) continue;
      let refs = resources.get(pageKey);
      let ancestor = reference(body.match(/\/Parent\s+(\d+\s+\d+\s+R)/)?.[1]);
      const seenAncestors = new Set();
      for (let depth = 0; !refs?.size && ancestor && depth < 32 && !seenAncestors.has(ancestor); depth++) {
        seenAncestors.add(ancestor);
        refs = resources.get(ancestor);
        ancestor = reference(objects.get(ancestor)?.match(/\/Parent\s+(\d+\s+\d+\s+R)/)?.[1]);
      }
      refs ||= new Map();
      const contents = [];
      const direct = body.match(/\/Contents\s+(\d+)\s+(\d+)\s+R/);
      if (direct) contents.push(`${direct[1]} ${direct[2]}`);
      const array = body.match(/\/Contents\s*\[([\s\S]*?)\]/)?.[1] || '';
      for (const match of array.matchAll(/(\d+)\s+(\d+)\s+R/g)) contents.push(`${match[1]} ${match[2]}`);
      for (const contentRef of contents) byContent.set(contentRef, refs);
    }

    const result = new Map();
    for (const record of records) {
      const aliases = byContent.get(record.objectKey) || globalAliases;
      const decoders = Object.create(null);
      for (const [alias, fontRef] of aliases) {
        const cmap = fontCmaps.get(fontRef);
        if (cmap) decoders[alias] = cmapDecoder(cmap);
      }
      result.set(record.objectKey, decoders);
    }
    return result;
  }

  async function parsePdf(input, options = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const maxFileBytes = options.maxFileBytes || 64 * 1024 * 1024;
    const maxStreamBytes = options.maxStreamBytes || 16 * 1024 * 1024;
    const maxTotalStreamBytes = options.maxTotalStreamBytes || 48 * 1024 * 1024;
    const maxStreams = options.maxStreams || 5000;
    const maxTextCharacters = options.maxTextCharacters || 5_000_000;
    const maxObjects = options.maxObjects || 20000;
    const maxCMapEntries = options.maxCMapEntries || 200000;
    if (bytes.length > maxFileBytes) throw new Error('pdf-file-size-limit');
    const source = latin1(bytes);
    if (!source.startsWith('%PDF-')) throw new Error('pdf-signature-missing');
    if (/\/Encrypt\b/.test(source)) throw new Error('pdf-encrypted-unsupported');
    const warnings = new Set();
    const parsedObjects = objectBodies(source, maxObjects);
    if (parsedObjects.truncated) warnings.add('pdf-object-count-limit');
    const texts = [];
    const segments = [];
    const decodedRecords = [];
    let streamsSeen = 0;
    let streamsParsed = 0;
    let totalExpanded = 0;
    let cursor = 0;
    let objectPositionIndex = 0;
    while (streamsSeen < maxStreams) {
      const marker = source.indexOf('stream', cursor);
      if (marker < 0) break;
      const afterKeyword = marker + 6;
      if (!['\r','\n'].includes(source[afterKeyword])) { cursor = afterKeyword; continue; }
      streamsSeen++;
      while (objectPositionIndex < parsedObjects.positions.length && marker > parsedObjects.positions[objectPositionIndex].end) objectPositionIndex++;
      const objectPosition = parsedObjects.positions[objectPositionIndex];
      const objectKey = objectPosition && marker >= objectPosition.start && marker <= objectPosition.end ? objectPosition.key : null;
      const dataStart = source[afterKeyword] === '\r' && source[afterKeyword + 1] === '\n' ? afterKeyword + 2 : afterKeyword + 1;
      const dictionaryStart = source.lastIndexOf('<<', marker);
      const dictionary = dictionaryStart >= Math.max(0, marker - 8192) ? source.slice(dictionaryStart, marker) : '';
      const declaredLength = Number(dictionary.match(/\/Length\s+(\d+)\b/)?.[1]);
      let end = -1;
      let dataEnd = -1;
      if (Number.isFinite(declaredLength) && dataStart + declaredLength <= bytes.length) {
        dataEnd = dataStart + declaredLength;
        const suffix = source.slice(dataEnd, dataEnd + 20);
        const markerOffset = suffix.search(/^\s*endstream\b/);
        if (markerOffset >= 0) end = dataEnd + suffix.indexOf('endstream');
      }
      if (end < 0) end = source.indexOf('endstream', dataStart);
      if (end < 0) { warnings.add('stream-end-missing'); break; }
      if (dataEnd < 0) {
        dataEnd = end;
        while (dataEnd > dataStart && ['\r','\n'].includes(source[dataEnd - 1])) dataEnd--;
      }
      let data = bytes.subarray(dataStart, dataEnd);
      try {
        if (/\/Filter\b/.test(dictionary)) {
          const filters = streamFilters(dictionary);
          if (!filters.length) { warnings.add('unsupported-stream-filter'); cursor = end + 9; continue; }
          data = await decodeStreamFilters(data, filters, Math.min(maxStreamBytes, maxTotalStreamBytes - totalExpanded), options.inflate || inflate);
        } else if (data.length > maxStreamBytes) throw new Error('pdf-stream-size-limit');
        totalExpanded += data.length;
        if (totalExpanded > maxTotalStreamBytes) throw new Error('pdf-total-stream-size-limit');
        decodedRecords.push({ objectKey, streamOrdinal:streamsSeen, content:latin1(data) });
        streamsParsed++;
      } catch (error) {
        if (['pdf-stream-size-limit','pdf-total-stream-size-limit'].includes(error?.message)) throw error;
        warnings.add(error?.message || 'stream-parse-failed');
      }
      cursor = end + 9;
    }
    if (streamsSeen >= maxStreams && source.indexOf('stream', cursor) >= 0) throw new Error('pdf-stream-count-limit');
    const cmapByObject = new Map();
    let cmapEntries = 0;
    for (const record of decodedRecords) {
      if (!record.objectKey || cmapEntries >= maxCMapEntries) continue;
      const parsed = parseToUnicodeCMap(record.content, maxCMapEntries - cmapEntries);
      if (!parsed) continue;
      if (parsed.truncated) warnings.add('pdf-cmap-entry-limit');
      cmapEntries += parsed.map.size;
      if (parsed.map.size) cmapByObject.set(record.objectKey, parsed.map);
    }
    const decodersByContent = fontDecodersByContent(source, decodedRecords, parsedObjects.objects, cmapByObject);
    for (const record of decodedRecords) {
      const text = contentText(record.content, decodersByContent.get(record.objectKey));
      if (text) { texts.push(text); segments.push({ source:`Content stream ${record.streamOrdinal}`, text }); }
    }
    const extracted = texts.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    let remaining = maxTextCharacters;
    const boundedSegments = segments.map(segment => { const bounded = { source:segment.source, text:segment.text.slice(0, Math.max(0, remaining)) }; remaining -= bounded.text.length; return bounded; }).filter(segment => segment.text);
    return { format:'pdf', text:extracted.slice(0, maxTextCharacters), segments:boundedSegments, truncated:extracted.length > maxTextCharacters, streamsSeen, streamsParsed, expandedBytes:totalExpanded, cmapCount:cmapByObject.size, cmapEntries, warnings:[...warnings] };
  }

  return { latin1, inflate, asciiHexDecode, ascii85Decode, runLengthDecode, streamFilters, decodeStreamFilters, decodeTextBytes, literalBytesAt, literalAt, stringsInside, contentText, unicodeHex, parseToUnicodeCMap, parsePdf };
});
