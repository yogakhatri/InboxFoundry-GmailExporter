const test = require('node:test');
const assert = require('node:assert/strict');
const ocr = require('../lib/ocr-engine.js');

function imageFile(size = 100) {
  return { name:'scan.png', type:'image/png', size, arrayBuffer:async () => new ArrayBuffer(size) };
}

test('classifies only bounded raster and PDF OCR candidates', () => {
  assert.equal(ocr.candidateType({ name:'SCAN.PNG' }), 'image');
  assert.equal(ocr.candidateType({ name:'paper.bin', type:'application/pdf' }), 'pdf');
  assert.equal(ocr.candidateType({ name:'active.svg', type:'image/svg+xml' }), null);
  assert.equal(ocr.candidateType({ name:'video.mp4', type:'video/mp4' }), null);
});

test('calculates a page scale bounded by dimensions and pixels', () => {
  assert.equal(ocr.boundedScale(1000, 500, 2, 4096, 16_000_000), 2);
  assert.equal(ocr.boundedScale(5000, 1000, 2, 4096, 16_000_000), 4096 / 5000);
  assert.throws(() => ocr.boundedScale(0, 100, 2, 4096, 16_000_000), /ocr-invalid-page-size/);
});

test('uses pinned local Tesseract paths and terminates an image OCR worker', async () => {
  const calls = [];
  let terminated = 0;
  const worker = {
    recognize:async input => { calls.push(input); return { data:{ text:'Invoice 42\n', confidence:93.5 } }; },
    terminate:async () => { terminated++; }
  };
  const tesseract = {
    OEM:{ LSTM_ONLY:1 },
    createWorker:async (language, oem, options) => {
      assert.equal(language, 'eng'); assert.equal(oem, 1);
      assert.equal(options.workerPath, 'ext://vendor/tesseract/worker.min.js');
      assert.equal(options.corePath, 'ext://vendor/tesseract/tesseract-core-simd-lstm.wasm.js');
      assert.equal(options.langPath, 'ext://vendor/tesseract/lang');
      assert.equal(options.cacheMethod, 'none');
      assert.equal(options.workerBlobURL, false);
      return worker;
    }
  };
  const session = await ocr.createSession({ tesseract, getUrl:path => `ext://${path}`, createImageBitmap:async () => ({ width:800, height:600, close() {} }) });
  const result = await session.recognize(imageFile());
  assert.equal(result.text, 'Invoice 42');
  assert.equal(result.confidence, 93.5);
  assert.equal(result.engineVersion, '7.0.0');
  assert.equal(calls.length, 1);
  await session.terminate();
  await session.terminate();
  assert.equal(terminated, 1);
});

test('rejects oversized image dimensions before starting OCR', async () => {
  let workers = 0;
  const session = await ocr.createSession({
    tesseract:{ createWorker:async () => { workers++; throw new Error('should not start'); } },
    getUrl:path => path,
    maxPixels:100,
    createImageBitmap:async () => ({ width:20, height:20, close() {} })
  });
  await assert.rejects(session.recognize(imageFile()), /ocr-image-pixel-limit/);
  assert.equal(workers, 0);
  await session.terminate();
});

test('renders PDF pages sequentially with execution and memory safeguards', async () => {
  const documentOptions = [];
  let destroyed = 0;
  let cleaned = 0;
  const pages = [1, 2].map(pageNumber => ({
    getViewport:({ scale }) => ({ width:600 * scale, height:800 * scale }),
    render:options => { assert.equal(options.canvas.width, 1200); return { promise:Promise.resolve() }; },
    cleanup:() => { cleaned++; },
    pageNumber
  }));
  const pdfjs = {
    GlobalWorkerOptions:{},
    getDocument:options => {
      documentOptions.push(options);
      return { promise:Promise.resolve({ numPages:2, getPage:async value => pages[value - 1], destroy:async () => { destroyed++; } }), destroy:async () => {} };
    }
  };
  let recognized = 0;
  const tesseract = { createWorker:async () => ({ recognize:async () => ({ data:{ text:`Page ${++recognized}`, confidence:80 } }), terminate:async () => {} }) };
  const documentRef = { createElement:() => ({ width:0, height:0, getContext:() => ({}) }) };
  const file = { name:'scan.pdf', type:'application/pdf', size:50, arrayBuffer:async () => new ArrayBuffer(50) };
  const session = await ocr.createSession({ pdfjs, tesseract, documentRef, getUrl:path => `ext://${path}` });
  const result = await session.recognize(file);
  assert.equal(result.text, 'Page 1\n\nPage 2');
  assert.deepEqual(result.segments.map(item => item.source), ['PDF page 1','PDF page 2']);
  assert.equal(pdfjs.GlobalWorkerOptions.workerSrc, 'ext://vendor/pdfjs/pdf.worker.min.mjs');
  assert.equal(documentOptions[0].isEvalSupported, false);
  assert.equal(documentOptions[0].enableXfa, false);
  assert.equal(documentOptions[0].useWorkerFetch, false);
  assert.equal(documentOptions[0].useWasm, false);
  assert.equal(cleaned, 2);
  assert.equal(destroyed, 1);
  await session.terminate();
});

test('enforces PDF page limits before allocating page canvases', async () => {
  let canvases = 0;
  const pdfjs = { GlobalWorkerOptions:{}, getDocument:() => ({ promise:Promise.resolve({ numPages:11, destroy:async () => {} }), destroy:async () => {} }) };
  const session = await ocr.createSession({ pdfjs, tesseract:{}, getUrl:path => path, documentRef:{ createElement:() => { canvases++; return {}; } }, maxPagesPerPdf:10 });
  await assert.rejects(session.recognize({ name:'scan.pdf', size:10, arrayBuffer:async () => new ArrayBuffer(10) }), /ocr-pdf-page-limit/);
  assert.equal(canvases, 0);
  await session.terminate();
});
