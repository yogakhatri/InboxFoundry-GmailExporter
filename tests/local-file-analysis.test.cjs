const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const analysis = require('../lib/local-file-analysis.js');
const officeParser = require('../lib/office-parser.js');
const pdfParser = require('../lib/pdf-parser.js');
const textIntelligence = require('../lib/text-intelligence.js');
const sha256 = require('../lib/sha256.js');
const exportEngine = require('../lib/export-engine.js');

function mockFile(name, content, type = '') {
  const bytes = new TextEncoder().encode(content);
  return { name, type, size:bytes.length, lastModified:1, arrayBuffer:async () => bytes.buffer.slice(0) };
}

function mockBytesFile(name, bytes, type = '') {
  return { name, type, size:bytes.length, lastModified:1, arrayBuffer:async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

test('hashes selected files and extracts only supported local text', async () => {
  const [text, binary] = await analysis.analyzeFiles([
    mockFile('notes.txt', 'Invoice total 42', 'text/plain'),
    mockFile('scan.pdf', '%PDF binary', 'application/pdf')
  ], { cryptoApi:webcrypto });
  assert.match(text.sha256, /^[a-f0-9]{64}$/);
  assert.equal(text.textStatus, 'extracted');
  assert.equal(text.text, 'Invoice total 42');
  assert.match(binary.sha256, /^[a-f0-9]{64}$/);
  assert.equal(binary.textStatus, 'pdf-parse-failed');
});

test('proves content duplicates by SHA-256 regardless of filename', async () => {
  const results = await analysis.analyzeFiles([
    mockFile('one.csv', 'a,b\n1,2'), mockFile('renamed.csv', 'a,b\n1,2'), mockFile('other.csv', 'different')
  ], { cryptoApi:webcrypto });
  const groups = analysis.duplicateGroups(results);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map(item => item.name), ['one.csv','renamed.csv']);
});

test('searches extracted text with bounded snippets and excludes content from reports', async () => {
  const results = await analysis.analyzeFiles([mockFile('mail.eml', 'Invoice A\nNothing\ninvoice B')], { cryptoApi:webcrypto });
  assert.equal(analysis.search(results, 'invoice')[0].count, 2);
  const report = analysis.report(results, 'invoice');
  assert.equal(report.files[0].text, undefined);
  assert.equal(report.search.matches[0].snippets, undefined);
  assert.equal(report.search.matches[0].count, 2);
});

test('labels configured hash and text size limits without reading the file', async () => {
  let reads = 0;
  const file = { name:'large.txt', type:'text/plain', size:1000, arrayBuffer:async () => { reads++; return new ArrayBuffer(1000); } };
  const result = await analysis.analyzeFile(file, { cryptoApi:webcrypto, maxHashBytes:10, maxTextBytes:10 });
  assert.equal(result.hashStatus, 'skipped-size-limit');
  assert.equal(result.textStatus, 'skipped-size-limit');
  assert.equal(reads, 0);
});

test('integrates local DOCX parsing with hashing and text search', async () => {
  const zip = exportEngine.zipArchive([{ name:'word/document.xml', data:'<w:document><w:p><w:t>Signed agreement</w:t></w:p></w:document>' }]);
  const result = await analysis.analyzeFile(mockBytesFile('agreement.docx', zip), { cryptoApi:webcrypto, officeParser });
  assert.equal(result.textStatus, 'extracted-office');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(analysis.search([result], 'signed')[0].count, 1);
});

test('integrates searchable PDF parsing and labels scanned PDFs honestly', async () => {
  const searchable = new TextEncoder().encode(exportEngine.basicPdf({ job:{ name:'PDF' }, totals:{}, threads:[{ subject:'Statement', messages:[{ bodyTextRaw:'Balance due' }] }] }));
  const parsed = await analysis.analyzeFile(mockBytesFile('statement.pdf', searchable, 'application/pdf'), { cryptoApi:webcrypto, pdfParser });
  assert.equal(parsed.textStatus, 'extracted-pdf');
  assert.equal(analysis.search([parsed], 'balance')[0].count, 1);
  const scanned = new TextEncoder().encode('%PDF-1.4\n%%EOF');
  const noText = await analysis.analyzeFile(mockBytesFile('scan.pdf', scanned, 'application/pdf'), { cryptoApi:webcrypto, pdfParser });
  assert.equal(noText.textStatus, 'pdf-no-searchable-text');
});

test('keeps structured intelligence opt-in when exporting analysis reports', async () => {
  const result = await analysis.analyzeFile(mockFile('invoice.txt', 'Invoice No: INV-9\nTotal USD 42.00\nEmail billing@example.com'), { cryptoApi:webcrypto, textIntelligence });
  assert.equal(result.insights.classification.primary, 'invoice');
  assert.equal(result.insights.sensitive.counts.email, 1);
  assert.equal(analysis.report([result]).files[0].insights, undefined);
  const approved = analysis.report([result], '', { includeInsights:true });
  assert.equal(approved.files[0].insights.structured.identifiers[0].value, 'INV-9');
  assert.doesNotMatch(JSON.stringify(analysis.report([result])), /billing@example|INV-9/);
});

test('returns source-level match evidence but removes source snippets from reports', async () => {
  const zip = exportEngine.zipArchive([
    { name:'ppt/slides/slide1.xml', data:'<p:sld><a:t>alpha</a:t></p:sld>' },
    { name:'ppt/slides/slide2.xml', data:'<p:sld><a:t>alpha alpha</a:t></p:sld>' }
  ]);
  const result = await analysis.analyzeFile(mockBytesFile('deck.pptx', zip), { cryptoApi:webcrypto, officeParser });
  const match = analysis.search([result], 'alpha')[0];
  assert.equal(match.count, 3);
  assert.deepEqual(match.sources.map(source => [source.source, source.count]), [['Slide 1',1],['Slide 2',2]]);
  const reported = analysis.report([result], 'alpha').search.matches[0];
  assert.equal(reported.snippets, undefined);
  assert.ok(reported.sources.every(source => source.snippets === undefined));
  assert.doesNotMatch(JSON.stringify(analysis.report([result], 'alpha')), /alpha alpha/);
});

test('builds redacted copies with a manifest and checksums without changing originals', async () => {
  const original = 'Contact alex@example.com or +1 212 555 0100.';
  const analyzed = await analysis.analyzeFile(mockFile('../contact.txt', original), { cryptoApi:webcrypto, textIntelligence });
  const { entries, manifest } = await analysis.buildRedactionEntries([analyzed], ['email','phone'], { cryptoApi:webcrypto, textIntelligence });
  assert.equal(analyzed.text, original);
  assert.equal(manifest.files[0].redactionCount, 2);
  assert.match(manifest.files[0].redactedSha256, /^[a-f0-9]{64}$/);
  assert.equal(entries[0].name, '001-__contact.txt.redacted.txt');
  assert.doesNotMatch(entries[0].data, /alex@example|555 0100/);
  assert.deepEqual(entries.slice(-3).map(entry => entry.name), ['REDACTION-MANIFEST.json','README.txt','CHECKSUMS.sha256']);
  assert.match(entries.at(-1).data, /REDACTION-MANIFEST\.json/);
});

test('hashes large binary selections through slices without whole-file reads', async () => {
  const bytes = new Uint8Array(300000).map((_, index) => index % 251);
  let wholeReads = 0; let slices = 0;
  const file = { name:'archive.bin', type:'application/octet-stream', size:bytes.length, arrayBuffer:async () => { wholeReads++; throw new Error('whole read'); }, slice:(start, end) => { slices++; return { arrayBuffer:async () => bytes.slice(start, end).buffer }; } };
  const result = await analysis.analyzeFile(file, { cryptoApi:webcrypto, hashEngine:sha256, hashChunkSize:65536 });
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(wholeReads, 0);
  assert.equal(slices, 5);
});

test('runs OCR only after explicit opt-in and excludes recognized text from reports', async () => {
  let sessions = 0;
  let recognitions = 0;
  let terminations = 0;
  const ocrEngine = {
    candidateType:file => file.name.endsWith('.png') ? 'image' : null,
    createSession:async () => {
      sessions++;
      return {
        recognize:async () => { recognitions++; return { engine:'Mock OCR', engineVersion:'1', language:'eng', pages:1, confidence:90, text:'Invoice No: OCR-42', segments:[{ source:'Image', text:'Invoice No: OCR-42' }], truncated:false }; },
        terminate:async () => { terminations++; }
      };
    }
  };
  const file = mockFile('scan.png', 'binary', 'image/png');
  const [withoutOcr] = await analysis.analyzeFiles([file], { cryptoApi:webcrypto, ocrEngine, ocr:false });
  assert.equal(withoutOcr.ocrStatus, 'not-requested');
  assert.equal(sessions, 0);
  const [withOcr] = await analysis.analyzeFiles([file], { cryptoApi:webcrypto, ocrEngine, ocr:true, textIntelligence });
  assert.equal(withOcr.textStatus, 'extracted-ocr');
  assert.equal(withOcr.ocrStatus, 'extracted');
  assert.equal(withOcr.ocr.confidence, 90);
  assert.equal(recognitions, 1);
  assert.equal(terminations, 1);
  assert.equal(analysis.search([withOcr], 'OCR-42')[0].count, 1);
  const report = analysis.report([withOcr]);
  assert.equal(report.files[0].text, undefined);
  assert.equal(report.files[0].segments, undefined);
  assert.doesNotMatch(JSON.stringify(report), /OCR-42/);
});

test('does not OCR a PDF that already has searchable text', async () => {
  let sessions = 0;
  const searchable = new TextEncoder().encode(exportEngine.basicPdf({ job:{ name:'PDF' }, totals:{}, threads:[{ subject:'Text', messages:[{ bodyTextRaw:'Already searchable' }] }] }));
  const ocrEngine = { candidateType:() => 'pdf', createSession:async () => { sessions++; throw new Error('should not start'); } };
  const [result] = await analysis.analyzeFiles([mockBytesFile('text.pdf', searchable, 'application/pdf')], { cryptoApi:webcrypto, pdfParser, ocrEngine, ocr:true });
  assert.equal(result.textStatus, 'extracted-pdf');
  assert.equal(result.ocrStatus, 'not-needed-searchable-text');
  assert.equal(sessions, 0);
});
