# Security policy

## Supported version

Security fixes are made against the latest version on the default branch. Older source snapshots are not supported.

## Reporting a vulnerability

Please do not publish an unpatched vulnerability or include real email content, authentication data, Gmail URLs, downloaded attachments, or exported JSON in a public issue.

If the repository has GitHub private vulnerability reporting enabled, use **Security → Report a vulnerability**. Otherwise, contact the maintainer privately through the repository owner's published contact method and provide:

- the affected version or commit;
- concise reproduction steps using synthetic data;
- the expected and actual security impact; and
- a suggested mitigation, if available.

Remove account identifiers, message IDs, tokens, and personal content before sharing diagnostics. The maintainer should acknowledge a complete report within 7 days and coordinate disclosure after a fix is available.

## Security model

The extension is intentionally limited to `https://mail.google.com/*`, local IndexedDB/settings storage, the side panel, and Chrome downloads. It has no remote code or default network destination. The optional file inspector can read only files explicitly selected in Chrome's picker; extracted and OCR-recognized text stays in side-panel memory and is cleared when the panel closes. OOXML parsing never executes macros, scripts, relationships, or external entities and enforces entry-count, per-entry expansion, total expansion, CRC, path, and total-text limits. Direct PDF parsing never executes PDF actions or JavaScript, rejects encrypted files, and bounds file, object, map, stream, aggregate-expansion, and extracted-text work.

Opt-in OCR loads pinned Tesseract.js, its English model, and PDF.js only from the extension package. Runtime file hashes and upstream package integrity metadata are recorded in `vendor/ASSET_MANIFEST.json`; licenses are collected in `vendor/THIRD_PARTY_NOTICES.md`. The extension CSP keeps scripts and workers on `self`; `wasm-unsafe-eval` is present only so the bundled Tesseract WebAssembly engine can compile and does not permit ordinary string evaluation. PDF.js is configured without XFA, browser font loading, JavaScript evaluation, remote worker fetching, or external WebAssembly, and enforces file, page, pixel, dimension, and recognized-text limits. OCR remains a parser for untrusted files, so users should inspect unknown documents cautiously and keep Chrome updated.

Anyone who can access the user's Chrome profile or unencrypted downloaded files may be able to read exported mail. Optional `.ifenc` archives use local AES-256-GCM encryption, but security still depends on a strong passphrase and safe handling of decrypted files.

PII detection and redaction use transparent local patterns and checksum validation where applicable; they are not a guarantee of de-identification. Users must review redacted copies before disclosure. Original selected files are never modified.
