(function initOcrEngine(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), ocrEngine: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createOcrEngine() {
  'use strict';

  const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','webp','bmp','gif']);
  const TESSERACT_VERSION = '7.0.0';
  const PDFJS_VERSION = '6.3.289';
  let tesseractLoadPromise = null;
  let pdfJsLoadPromise = null;

  function extensionOf(name) {
    return String(name || '').normalize('NFKC').toLocaleLowerCase().match(/\.([^\.\s]+)$/u)?.[1] || '';
  }

  function candidateType(file) {
    const extension = extensionOf(file?.name);
    const mime = String(file?.type || '').toLocaleLowerCase();
    if (extension === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (IMAGE_EXTENSIONS.has(extension) || /^image\/(?:png|jpeg|webp|bmp|gif)$/.test(mime)) return 'image';
    return null;
  }

  function checkAbort(signal) {
    if (signal?.aborted) throw new Error('analysis-cancelled');
  }

  function scriptOnce(url, documentRef = globalThis.document) {
    if (!documentRef?.head) return Promise.reject(new Error('ocr-script-loader-unavailable'));
    return new Promise((resolve, reject) => {
      const existing = [...documentRef.scripts].find(script => script.src === url);
      if (existing?.dataset.loaded === 'true') { resolve(); return; }
      const script = existing || documentRef.createElement('script');
      script.src = url;
      script.async = true;
      script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve(); }, { once:true });
      script.addEventListener('error', () => reject(new Error('ocr-script-load-failed')), { once:true });
      if (!existing) documentRef.head.append(script);
    });
  }

  async function loadTesseract(options) {
    if (options.tesseract) return options.tesseract;
    if (globalThis.Tesseract) return globalThis.Tesseract;
    const url = options.getUrl('vendor/tesseract/tesseract.min.js');
    tesseractLoadPromise ||= scriptOnce(url, options.documentRef);
    await tesseractLoadPromise;
    if (!globalThis.Tesseract) throw new Error('ocr-runtime-unavailable');
    return globalThis.Tesseract;
  }

  async function loadPdfJs(options) {
    if (options.pdfjs) return options.pdfjs;
    const url = options.getUrl('vendor/pdfjs/pdf.min.mjs');
    pdfJsLoadPromise ||= (options.importModule || (value => import(value)))(url);
    return pdfJsLoadPromise;
  }

  function boundedScale(width, height, requestedScale, maxDimension, maxPixels) {
    if (!(width > 0 && height > 0)) throw new Error('ocr-invalid-page-size');
    const scale = Math.min(
      requestedScale,
      maxDimension / width,
      maxDimension / height,
      Math.sqrt(maxPixels / (width * height))
    );
    if (!(scale > 0)) throw new Error('ocr-invalid-render-scale');
    return scale;
  }

  async function createSession(inputOptions = {}) {
    const options = {
      language:'eng',
      maxImageBytes:20 * 1024 * 1024,
      maxPdfBytes:50 * 1024 * 1024,
      maxPagesPerPdf:10,
      maxTotalPages:20,
      maxPixels:16_000_000,
      maxDimension:4096,
      renderScale:2,
      maxTextCharacters:2_000_000,
      getUrl:path => globalThis.chrome?.runtime?.getURL(path),
      createImageBitmap:globalThis.createImageBitmap?.bind(globalThis),
      documentRef:globalThis.document,
      onProgress:() => {},
      ...inputOptions
    };
    if (options.language !== 'eng') throw new Error('Only the bundled English OCR model is available.');
    if (typeof options.getUrl !== 'function') throw new Error('ocr-extension-url-unavailable');
    const signal = options.signal;
    let worker = null;
    let terminated = false;
    let consumedPages = 0;

    const terminate = async () => {
      if (terminated) return;
      terminated = true;
      if (worker) { try { await worker.terminate(); } catch (_) {} }
      worker = null;
    };
    const abortHandler = () => { terminate(); };
    signal?.addEventListener?.('abort', abortHandler, { once:true });

    const getWorker = async () => {
      checkAbort(signal);
      if (terminated) throw new Error('analysis-cancelled');
      if (worker) return worker;
      const tesseract = await loadTesseract(options);
      checkAbort(signal);
      const createdWorker = await tesseract.createWorker(options.language, tesseract.OEM?.LSTM_ONLY ?? 1, {
        workerPath:options.getUrl('vendor/tesseract/worker.min.js'),
        corePath:options.getUrl('vendor/tesseract/tesseract-core-simd-lstm.wasm.js'),
        langPath:options.getUrl('vendor/tesseract/lang'),
        gzip:true,
        cacheMethod:'none',
        workerBlobURL:false,
        logger:progress => options.onProgress({ phase:'ocr-engine', status:progress.status, progress:progress.progress })
      });
      if (signal?.aborted || terminated) {
        try { await createdWorker.terminate(); } catch (_) {}
        throw new Error('analysis-cancelled');
      }
      worker = createdWorker;
      return worker;
    };

    const recognizeCanvasOrFile = async (input, source) => {
      checkAbort(signal);
      if (consumedPages >= options.maxTotalPages) throw new Error('ocr-total-page-limit');
      consumedPages++;
      options.onProgress({ phase:'ocr-recognition', source, page:consumedPages, maxPages:options.maxTotalPages, progress:0 });
      const result = await (await getWorker()).recognize(input, {}, { text:true });
      checkAbort(signal);
      const text = String(result?.data?.text || '').trim();
      options.onProgress({ phase:'ocr-recognition', source, page:consumedPages, maxPages:options.maxTotalPages, progress:1 });
      return { source, text, confidence:Number.isFinite(result?.data?.confidence) ? result.data.confidence : null };
    };

    const recognizeImage = async file => {
      if (Number(file?.size) > options.maxImageBytes) throw new Error('ocr-image-size-limit');
      if (options.createImageBitmap) {
        const bitmap = await options.createImageBitmap(file);
        try {
          if (bitmap.width > options.maxDimension || bitmap.height > options.maxDimension || bitmap.width * bitmap.height > options.maxPixels) throw new Error('ocr-image-pixel-limit');
        } finally { bitmap.close?.(); }
      }
      return [await recognizeCanvasOrFile(file, 'Image')];
    };

    const recognizePdf = async file => {
      if (Number(file?.size) > options.maxPdfBytes) throw new Error('ocr-pdf-size-limit');
      const pdfjs = await loadPdfJs(options);
      pdfjs.GlobalWorkerOptions.workerSrc = options.getUrl('vendor/pdfjs/pdf.worker.min.mjs');
      const bytes = new Uint8Array(await file.arrayBuffer());
      checkAbort(signal);
      const loadingTask = pdfjs.getDocument({
        data:bytes,
        isEvalSupported:false,
        enableXfa:false,
        disableFontFace:true,
        useSystemFonts:false,
        useWorkerFetch:false,
        useWasm:false,
        stopAtErrors:true,
        maxImageSize:options.maxPixels,
        canvasMaxAreaInBytes:options.maxPixels * 4
      });
      let documentProxy;
      try {
        documentProxy = await loadingTask.promise;
        if (documentProxy.numPages > options.maxPagesPerPdf) throw new Error('ocr-pdf-page-limit');
        if (consumedPages + documentProxy.numPages > options.maxTotalPages) throw new Error('ocr-total-page-limit');
        const segments = [];
        for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber++) {
          checkAbort(signal);
          const page = await documentProxy.getPage(pageNumber);
          const base = page.getViewport({ scale:1 });
          const scale = boundedScale(base.width, base.height, options.renderScale, options.maxDimension, options.maxPixels);
          const viewport = page.getViewport({ scale });
          const canvas = options.documentRef.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          const context = canvas.getContext('2d', { alpha:false, willReadFrequently:true });
          if (!context) throw new Error('ocr-canvas-unavailable');
          try {
            await page.render({ canvas, canvasContext:context, viewport, background:'#ffffff' }).promise;
            segments.push(await recognizeCanvasOrFile(canvas, `PDF page ${pageNumber}`));
          } finally {
            canvas.width = 1; canvas.height = 1;
            page.cleanup?.();
          }
        }
        return segments;
      } finally {
        try { await documentProxy?.destroy?.(); } catch (_) {}
        try { await loadingTask.destroy?.(); } catch (_) {}
      }
    };

    return {
      async recognize(file) {
        checkAbort(signal);
        const type = candidateType(file);
        if (!type) throw new Error('ocr-file-type-unsupported');
        const segments = type === 'pdf' ? await recognizePdf(file) : await recognizeImage(file);
        const fullText = segments.map(segment => segment.text).filter(Boolean).join('\n\n');
        const text = fullText.slice(0, options.maxTextCharacters);
        const confidences = segments.map(segment => segment.confidence).filter(Number.isFinite);
        return {
          engine:'Tesseract.js', engineVersion:TESSERACT_VERSION,
          renderer:type === 'pdf' ? 'PDF.js' : 'browser image decoder', rendererVersion:type === 'pdf' ? PDFJS_VERSION : null,
          language:options.language, pages:segments.length,
          confidence:confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
          text, segments:segments.map(segment => ({ source:segment.source, text:segment.text })),
          truncated:fullText.length > options.maxTextCharacters
        };
      },
      terminate,
      get consumedPages() { return consumedPages; }
    };
  }

  return { IMAGE_EXTENSIONS, TESSERACT_VERSION, PDFJS_VERSION, extensionOf, candidateType, boundedScale, createSession };
});
