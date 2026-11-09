# Changelog

This project follows [Semantic Versioning](https://semver.org/). Earlier private versions (2.x to 4.x) were never publicly released, so numbering restarts here.

## 0.1.0 - Unreleased

First public pre-release: a focused rebuild around Search, Review, Save.

### Fixed

- New users can now start: the consent notice, filters, and all controls are reachable, and the search form really drives the search.
- The Gmail tab no longer freezes at the end of a page of results.
- Links inside emails are never clicked or treated as attachments.
- One unreadable conversation no longer blocks a job forever. It's skipped, reported, and retried on resume.
- Silent data loss: translated Gmail no longer ends after one page, threads with the same sender, subject, and date stay separate, safety limits no longer report completion, older batches are never deleted automatically, repeat exports remember every earlier save, and real documents named like "signature page.jpg" are kept.
- Dates are read in many languages, with fallbacks, and unknown dates are flagged rather than replaced or used to drop mail.
- Non-Latin text is preserved in every format.
- EML/MBOX now have unique Message-IDs, threading headers, display names, and HTML bodies.
- Error messages stay on screen until dismissed. Dark mode is readable.
- "Hide email addresses" now also covers bodies, HTML, saved filters, and source links.
- Encryption no longer leaves a plain copy behind, and uses 600,000 PBKDF2 iterations with tamper-evident chunks.
- Rules can no longer freeze the page: wildcards run in linear time, and commas no longer break quoted phrases.

### Changed

- Nothing downloads until after review, where each conversation and file can be unticked.
- Reading state changes are disclosed before first use and counted afterwards.
- The Gmail script is injected only on demand, and the side panel is the only interface.
- Exports stream from storage, so large batches work, and they're saved next to their attachments.
- Each message is stored once instead of up to five times.
- Limits are user-set safety stops that can be raised and resumed.
- Added "Check Gmail compatibility" and content-free diagnostics.

### Removed

- The local file inspector: OCR, PDF and Office parsing, PII detection, redaction, and document classification, with their vendored libraries (about 8.8 MB). The export never used them.
- All Free/Pro leftovers and commercial planning documents.
- Regular-expression rules, because JavaScript can't time them out and even simple patterns can hang on hostile email text. Wildcards and Gmail's search operators cover normal use.
- The popup, starter workflows, custom PDF writers, NDJSON, plain text, Markdown, split JSON, and legacy migration code.
