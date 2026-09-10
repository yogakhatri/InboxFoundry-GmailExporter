const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const parser = require('../lib/pdf-parser.js');
const exportEngine = require('../lib/export-engine.js');

function concat(parts) {
  const buffers = parts.map(part => typeof part === 'string' ? new TextEncoder().encode(part) : new Uint8Array(part));
  const output = new Uint8Array(buffers.reduce((sum, item) => sum + item.length, 0));
  let offset = 0; for (const item of buffers) { output.set(item, offset); offset += item.length; } return output;
}

function ascii85Encode(input) {
  const bytes = new Uint8Array(input);
  let output = '<~';
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const count = Math.min(4, bytes.length - offset);
    const block = new Uint8Array(4);
    block.set(bytes.subarray(offset, offset + count));
    const value = block[0] * 16777216 + block[1] * 65536 + block[2] * 256 + block[3];
    if (value === 0 && count === 4) { output += 'z'; continue; }
    const encoded = Array(5);
    let remaining = value;
    for (let index = 4; index >= 0; index--) { encoded[index] = String.fromCharCode(remaining % 85 + 33); remaining = Math.floor(remaining / 85); }
    output += encoded.slice(0, count + 1).join('');
  }
  return `${output}~>`;
}

test('extracts text from InboxFoundry basic PDFs', async () => {
  const pdf = exportEngine.basicPdf({ job:{ name:'Test' }, totals:{ matchedThreads:1, capturedMessages:1 }, threads:[{ subject:'Invoice', messages:[{ from:'a@example.com', date:'today', bodyTextRaw:'Amount (paid)' }] }] });
  const result = await parser.parsePdf(new TextEncoder().encode(pdf));
  assert.match(result.text, /InboxFoundry - Test/);
  assert.match(result.text, /Amount \(paid\)/);
  assert.ok(result.streamsParsed >= 1);
  assert.match(result.segments[0].source, /^Content stream /);
});

test('decodes PDF literal escapes, TJ arrays, octal, and UTF-16 hex strings', () => {
  const text = parser.contentText('BT [(Hello) 120 ( world)] TJ (Line\\nTwo\\040\\(ok\\)) Tj <FEFF0041> Tj ET');
  assert.match(text, /Hello world/);
  assert.match(text, /Line\nTwo \(ok\)/);
  assert.match(text, /A/);
});

test('treats prototype-like PDF font names as data, not decoder properties', () => {
  assert.equal(parser.contentText('BT /__proto__ 12 Tf (safe) Tj /constructor 12 Tf ( text) Tj ET'), 'safe\n text');
});

test('extracts Flate-compressed PDF content streams', async () => {
  const content = new TextEncoder().encode('BT (Compressed invoice) Tj ET');
  const compressed = new Uint8Array(deflateSync(content));
  const pdf = concat([`%PDF-1.4\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, compressed, '\nendstream\nendobj\n%%EOF']);
  const result = await parser.parsePdf(pdf);
  assert.equal(result.text, 'Compressed invoice');
});

test('extracts ASCIIHex and RunLength encoded content streams', async () => {
  const content = new TextEncoder().encode('BT (Legacy encoded invoice) Tj ET');
  const hex = `${Buffer.from(content).toString('hex')}>`;
  const hexPdf = concat([`%PDF-1.4\n<< /Length ${hex.length} /Filter /ASCIIHexDecode >>\nstream\n${hex}\nendstream\n%%EOF`]);
  assert.equal((await parser.parsePdf(hexPdf)).text, 'Legacy encoded invoice');

  const runLength = concat([Uint8Array.from([content.length - 1]), content, Uint8Array.from([128])]);
  const runPdf = concat([`%PDF-1.4\n<< /Length ${runLength.length} /Filter /RunLengthDecode >>\nstream\n`, runLength, '\nendstream\n%%EOF']);
  assert.equal((await parser.parsePdf(runPdf)).text, 'Legacy encoded invoice');
});

test('extracts an ASCII85 plus Flate filter chain in declared order', async () => {
  const content = new TextEncoder().encode('BT (Chained PDF filters) Tj ET');
  const encoded = ascii85Encode(deflateSync(content));
  const pdf = concat([`%PDF-1.5\n<< /Length ${encoded.length} /Filter [/ASCII85Decode /FlateDecode] >>\nstream\n${encoded}\nendstream\n%%EOF`]);
  const result = await parser.parsePdf(pdf);
  assert.equal(result.text, 'Chained PDF filters');
  assert.deepEqual(result.warnings, []);
});

test('bounds and rejects malformed legacy stream encodings', async () => {
  assert.throws(() => parser.asciiHexDecode(new TextEncoder().encode('gg>'), 10), /pdf-asciihex-invalid/);
  assert.throws(() => parser.ascii85Decode(new TextEncoder().encode('<~!~>'), 10), /pdf-ascii85-invalid/);
  assert.throws(() => parser.runLengthDecode(Uint8Array.from([5, 65]), 10), /pdf-runlength-invalid/);
  assert.throws(() => parser.runLengthDecode(Uint8Array.from([129, 65, 128]), 10), /pdf-stream-size-limit/);
});

test('rejects encrypted PDFs and bounded decompression overflow', async () => {
  await assert.rejects(parser.parsePdf(new TextEncoder().encode('%PDF-1.4\n<< /Encrypt 1 0 R >>\n%%EOF')), /pdf-encrypted-unsupported/);
  const expanded = new TextEncoder().encode(`BT (${'x'.repeat(100000)}) Tj ET`);
  const compressed = new Uint8Array(deflateSync(expanded));
  const pdf = concat([`%PDF-1.4\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, compressed, '\nendstream\n%%EOF']);
  await assert.rejects(parser.parsePdf(pdf, { maxStreamBytes:100 }), /pdf-stream-size-limit/);
});

test('labels unsupported PDF stream filters without treating binary as text', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.4\n<< /Length 4 /Filter /DCTDecode >>\nstream\nnope\nendstream\n%%EOF');
  const result = await parser.parsePdf(pdf);
  assert.equal(result.text, '');
  assert.deepEqual(result.warnings, ['unsupported-stream-filter']);
});

function type0Pdf(content, cmaps) {
  const fontEntries = cmaps.map((_, index) => `/F${index + 1} ${4 + index} 0 R`).join(' ');
  const fontObjects = cmaps.map((_, index) => `${4 + index} 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode ${10 + index} 0 R >>\nendobj\n`).join('');
  const cmapObjects = cmaps.map((cmap, index) => `${10 + index} 0 obj\n<< /Length ${new TextEncoder().encode(cmap).length} >>\nstream\n${cmap}\nendstream\nendobj\n`).join('');
  return new TextEncoder().encode(`%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << ${fontEntries} >> >> /Contents 8 0 R >> endobj
${fontObjects}8 0 obj
<< /Length ${new TextEncoder().encode(content).length} >>
stream
${content}
endstream
endobj
${cmapObjects}%%EOF`);
}

test('uses embedded ToUnicode bfchar maps for Type0 font text', async () => {
  const cmap = `begincmap
4 beginbfchar
<0001> <0048>
<0002> <00E9>
<0003> <D83DDE80>
<0004> <0021>
endbfchar
endcmap`;
  const result = await parser.parsePdf(type0Pdf('BT /F1 12 Tf <0001000200030004> Tj ET', [cmap]));
  assert.equal(result.text, 'Hé🚀!');
  assert.equal(result.cmapCount, 1);
  assert.equal(result.cmapEntries, 4);
});

test('supports sequential and explicit ToUnicode bfrange mappings and font switches', async () => {
  const latin = `begincmap
1 beginbfrange
<0010> <0012> <0061>
endbfrange
endcmap`;
  const multilingual = `begincmap
1 beginbfrange
<0020> <0021> [<03A9> <4E2D>]
endbfrange
endcmap`;
  const content = 'BT /F1 10 Tf <001000110012> Tj /F2 10 Tf <00200021> Tj ET';
  const result = await parser.parsePdf(type0Pdf(content, [latin, multilingual]));
  assert.equal(result.text, 'abc\nΩ中');
  assert.equal(result.cmapCount, 2);
  assert.equal(result.cmapEntries, 5);
});

test('resolves inherited resources and an indirect font dictionary', async () => {
  const content = 'BT /FInherited 12 Tf <01> Tj ET';
  const cmap = 'begincmap\n1 beginbfchar\n<01> <2713>\nendbfchar\nendcmap';
  const pdf = new TextEncoder().encode(`%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /Resources 7 0 R >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 8 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 10 0 R >> endobj
7 0 obj << /Font 9 0 R >> endobj
9 0 obj << /FInherited 4 0 R >> endobj
8 0 obj << /Length ${content.length} >>
stream
${content}
endstream
endobj
10 0 obj << /Length ${cmap.length} >>
stream
${cmap}
endstream
endobj
%%EOF`);
  const result = await parser.parsePdf(pdf);
  assert.equal(result.text, '✓');
  assert.equal(result.cmapCount, 1);
});

test('bounds malicious ToUnicode ranges without expanding them', () => {
  const parsed = parser.parseToUnicodeCMap('begincmap\n1 beginbfrange\n<0000> <ffff> <0000>\nendbfrange\nendcmap', 10);
  assert.equal(parsed.map.size, 0);
  assert.equal(parsed.truncated, true);
});
