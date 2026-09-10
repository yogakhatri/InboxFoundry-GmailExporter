# Changelog

## Unreleased

## 4.5.0 - 2026-08-30

- Added portable reconstructed EML ZIP and MBOX outputs with UTF-8 transfer encoding, header-injection protection, safe paths, explicit provenance, indexes, and checksums. Exact original-source messages remain reserved for a future consented Gmail API adapter.

## 4.4.0 - 2026-08-30

- Added fully local, opt-in English OCR for supported images and PDFs without searchable text, using pinned bundled Tesseract.js/PDF.js assets, strict file/page/pixel/text limits, sequential page processing, progress, cancellation, privacy-safe reports, asset integrity validation, and real-browser PNG/scanned-PDF coverage.

## 4.3.0 - 2026-08-30

- Expanded bounded local PDF extraction with embedded ToUnicode font maps, UTF-16/surrogate decoding, inherited and indirect font resources, ASCIIHex, ASCII85, RunLength, ordered filter chains, mapping/object limits, and adversarial font-name protection.

## 4.2.0 - 2026-08-30

- Added an account-free, loopback-only Chromium browser gate covering content-script injection, filtering, safe Stop, partial-export availability, resume, IndexedDB records, side-panel loading, service-worker restart, and reload recovery.
- Added a first-N current-list dry run that reports match/reject evidence without creating a job, retaining message content, or downloading attachments.

## 4.1.0 - 2026-08-30

- Added an indexed and checksummed individual-PDF ZIP while retaining the merged basic PDF output.

- Added a saved-batch attachment review workspace with classifications, match/exclusion reasons, sizes, and durable task states.
- Added selected-filename shortcuts for include/exclude rules and selective retry for interrupted Chrome downloads.
- Made click-download routing fail closed when the background coordinator cannot establish a tracked route, preventing unsafe blind retries.
- Added reusable download-state policy tests and corrected retained-batch started/failure counters.
- Replaced subject-derived attachment task IDs with opaque identifiers and removed task IDs from sanitized diagnostics.
- Added a deterministic, allowlisted Chrome release ZIP and SHA-256 packaging command.
- Added mocked background-worker tests for selective retry, failed checkpoints, click-download durability, and IndexedDB filename-route recovery after worker restart.
- Added a deterministic record-only evidence ZIP with canonical JSON, NDJSON, CSV, searchable HTML, attachment manifest, package notes, and SHA-256 checksums.
- Added local metadata duplicate candidates and draft/final/version filename-family analysis with explicit non-hash confidence labeling.
- Added an opt-in local file inspector with SHA-256 hashing, exact content-duplicate proof, bounded text-file search, memory clearing, and content-free analysis reports.
- Added local DOCX, XLSX, and PPTX text extraction with CRC validation, traversal protection, bounded streaming decompression, and ZIP-bomb limits.
- Added bounded local text extraction for ordinary unencrypted PDFs with literal/hex/TJ decoding, Flate support, encrypted-file rejection, and decompression-bomb limits.
- Added transparent on-device classification, business-field suggestions, likely PII detection with Luhn/IBAN validation, approval-gated insight reports, and best-effort redacted text ZIPs with original/redacted hashes, manifests, counts, and checksums.
- Added incremental SHA-256 hashing for files up to 2 GB with bounded chunks, progress reporting, cancellation, and no whole-file read for unsupported binary formats.
- Added source-level search evidence for PDF content streams, DOCX parts, XLSX sheets, and PPTX slides while keeping extracted snippets out of reports.

## 4.0.0 - 2026-08-29

- Rebranded the product as InboxFoundry and added a Chrome side-panel workspace.
- Added durable IndexedDB jobs, safe Stop/partial export, resume, cross-tab locking, retained batches, and presets.
- Added keyword, sender, recipient, domain, subject, date, thread/message, attachment-type, filename, and size filters with preview evidence.
- Added JSON v2, NDJSON, CSV, text, printable HTML, basic PDF, attachment manifests, and SHA-256 integrity data.
- Added accurate Chrome download-state persistence, batch folders, privacy disclosure, CSP, CSV-injection protection, and expanded tests/docs.
- Added formal job-state transitions, expiring tab leases, current-thread/page/selected-row scopes, incremental batches, item-level IndexedDB records, storage cleanup, Markdown, searchable HTML, safe templates, split JSON, and AES-256-GCM archives.

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [3.0.0] - 2026-08-29

### Added

- Public project identity: Gmail Thread Exporter.
- Optional attachment downloads for faster JSON-only exports.
- Versioned JSON format metadata and a documented export contract.
- Clear popup guidance, privacy notice, progress controls, and actionable connection errors.
- Open-source license, privacy policy, security policy, contribution guide, changelog, and validation command.

### Changed

- Attachment downloads now use the generic `Gmail_Thread_Exporter` root folder.
- Removed the unnecessary `activeTab` permission.
- Restricted direct attachment URLs to HTTPS on Google-owned hosts.
- Migrated existing v2.3 saved progress to the v3 storage key.

### Fixed

- Prevented saved export data from being reset while an active scan can still write it back.
- Prevented a completed click-download route from accidentally affecting a later Gmail download.
- Improved popup control state during active exports.

## [2.3.0] - 2026-08-28

- Captured all threads without keyword filtering.
- Preserved individual messages, raw text and HTML, and per-message attachment results.
