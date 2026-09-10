const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateRawSync } = require('node:zlib');
const parser = require('../lib/office-parser.js');
const exportEngine = require('../lib/export-engine.js');

function storedZip(entries) {
  return exportEngine.zipArchive(entries.map(([name, data]) => ({ name, data })));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

test('extracts searchable DOCX paragraph text without executing markup', async () => {
  const zip = storedZip([['word/document.xml', '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Invoice 42</w:t></w:r></w:p></w:body></w:document>']]);
  const result = await parser.parseOffice(zip, 'sample.docx');
  assert.equal(result.format, 'docx');
  assert.match(result.text, /Hello & welcome\s+Invoice 42/);
  assert.doesNotMatch(result.text, /<w:/);
});

test('resolves XLSX shared strings and preserves sheet rows', async () => {
  const zip = storedZip([
    ['xl/sharedStrings.xml', '<sst><si><t>Vendor</t></si><si><t>Amount</t></si></sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>Acme</v></c><c><v>42</v></c></row></sheetData></worksheet>']
  ]);
  const result = await parser.parseOffice(zip, 'book.xlsx');
  assert.match(result.text, /Vendor\tAmount/);
  assert.match(result.text, /Acme\t42/);
  assert.equal(result.segments[0].source, 'Sheet 1');
});

test('extracts PPTX text in numeric slide order', async () => {
  const zip = storedZip([
    ['ppt/slides/slide2.xml', '<p:sld><a:t>Second</a:t></p:sld>'],
    ['ppt/slides/slide1.xml', '<p:sld><a:t>First</a:t></p:sld>']
  ]);
  const result = await parser.parseOffice(zip, 'deck.pptx');
  assert.ok(result.text.indexOf('First') < result.text.indexOf('Second'));
  assert.deepEqual(result.segments.map(segment => segment.source), ['Slide 1','Slide 2']);
});

test('inflates standard deflate-raw ZIP entries and validates CRC', async () => {
  const original = new TextEncoder().encode('compressed office XML');
  const compressed = new Uint8Array(deflateRawSync(original));
  const result = await parser.entryBytes({ bytes:compressed }, { method:8, dataOffset:0, compressedSize:compressed.length, uncompressedSize:original.length, crc32:crc32(original) });
  assert.equal(new TextDecoder().decode(result), 'compressed office XML');
});

test('stops a deflate stream that expands beyond its declared size', async () => {
  const original = new TextEncoder().encode('x'.repeat(1024 * 1024));
  const compressed = new Uint8Array(deflateRawSync(original));
  await assert.rejects(parser.entryBytes({ bytes:compressed }, { method:8, dataOffset:0, compressedSize:compressed.length, uncompressedSize:10, crc32:0 }), /office-zip-inflate-limit/);
});

test('joins rich shared strings and preserves empty XLSX columns', async () => {
  const zip = storedZip([
    ['xl/sharedStrings.xml', '<sst><si><r><t>North</t></r><r><t>wind</t></r></si></sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>']
  ]);
  const result = await parser.parseOffice(zip, 'book.xlsx');
  assert.match(result.text, /Northwind\t\t42/);
});

test('rejects oversized decompressed Office entries before extraction', async () => {
  const zip = storedZip([['word/document.xml', `<w:document><w:t>${'x'.repeat(100)}</w:t></w:document>`]]);
  await assert.rejects(parser.parseOffice(zip, 'large.docx', { maxEntryBytes:20 }), /office-zip-entry-size-limit/);
});

test('rejects corrupt entry content by CRC', async () => {
  const value = new TextEncoder().encode('tampered');
  await assert.rejects(parser.entryBytes({ bytes:value }, { method:0, dataOffset:0, compressedSize:value.length, uncompressedSize:value.length, crc32:0 }), /office-zip-crc-mismatch/);
});

test('rejects traversal paths in the ZIP central directory', () => {
  const zip = storedZip([['safeevilxml', 'value']]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let central = -1;
  for (let offset = 0; offset <= zip.length - 4; offset++) if (view.getUint32(offset, true) === 0x02014b50) { central = offset; break; }
  assert.ok(central >= 0);
  zip.set(new TextEncoder().encode('../evil.xml'), central + 46);
  assert.throws(() => parser.readDirectory(zip), /office-zip-unsafe-path/);
});
