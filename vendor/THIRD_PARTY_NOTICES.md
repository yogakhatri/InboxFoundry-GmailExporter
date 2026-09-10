# Third-party notices

InboxFoundry vendors the following files so optional OCR remains completely local and does not contact a CDN. Runtime assets are pinned by SHA-256 in `ASSET_MANIFEST.json`; release validation fails if they change.

## Tesseract.js 7.0.0

- Project: https://github.com/naptha/tesseract.js
- Files: `tesseract/tesseract.min.js`, `tesseract/worker.min.js`
- License: Apache License 2.0. See `tesseract/LICENSE-tesseract-js.md` and the adjacent minified-bundle notices.

## Tesseract.js Core 7.0.0

- Project: https://github.com/naptha/tesseract.js-core
- File: `tesseract/tesseract-core-simd-lstm.wasm.js`
- License: Apache License 2.0. See `tesseract/LICENSE-tesseract-core.txt`.

Only the SIMD LSTM core is included because InboxFoundry requires Chrome 114+, which supports WebAssembly SIMD. The legacy OCR engine and orientation detector are not included.

## English trained data 1.0.0

- Package: https://www.npmjs.com/package/@tesseract.js-data/eng/v/1.0.0
- Upstream trained data: https://github.com/tesseract-ocr/tessdata_best
- File: `tesseract/lang/eng.traineddata.gz` (`4.0.0_best_int`)
- Licensing: the npm package declares MIT; upstream Tesseract trained data is Apache License 2.0. Package metadata and its README are included beside the model.

## PDF.js 6.3.289

- Project: https://github.com/mozilla/pdf.js
- Files: `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` from the legacy browser build
- License: Apache License 2.0. See `pdfjs/LICENSE.txt`.

PDF.js is loaded only when the user explicitly OCRs a PDF that lacks searchable text. InboxFoundry supplies the selected file as local bytes, disables XFA, font evaluation, system fonts, worker fetching, and optional WASM image decoders, renders one bounded page at a time, and never opens PDF links or JavaScript actions.
