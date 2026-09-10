# Release testing

Use synthetic accounts and messages only. Never attach real customer, employee, financial, medical, or legal email to a public issue.

## Automated gate

Run:

```bash
npm test
```

This checks JavaScript syntax, rule/state/export/path/download-policy unit tests, mocked background-worker durability and selective-retry behavior, manifest permissions, CSP, manifest/imported resources, extension-page script/style references, DOM IDs referenced by UI code, sanitized-diagnostics invariants, and local README links.

Run the isolated browser lifecycle gate:

```bash
npm run test:browser
```

This launches an unpacked extension in a fresh temporary browser profile against a loopback-only HTTPS Gmail fixture. It does not open a real Gmail account. The test proves content-script injection, a non-persisting two-thread dry run, keyword filtering, a durable checkpoint, safe Stop, immediate partial-export availability, resume, exact matched/rejected records in IndexedDB, initialized side-panel scripts and retained-batch loading, service-worker termination/restart, tab reload, and durable counter restoration. It also runs the actual bundled Tesseract.js/PDF.js stack in the extension side panel against a generated high-contrast PNG and an image-only scanned PDF and verifies recognized fixture tokens. The Gmail fixture uses three synthetic threads and expects `3 scanned / 2 matched / 1 rejected`.

The browser test requires OpenSSL and a Chromium-family executable that permits unpacked extensions in headless mode. Set `INBOXFOUNDRY_OPENSSL` or `INBOXFOUNDRY_CHROME` when auto-detection is not suitable. Some branded Chrome builds reject `--load-extension` in headless mode; Chromium or Brave can run this development-only gate. To run both automated layers:

```bash
npm run test:release
```

## Manual real-Gmail synthetic matrix

The browser gate validates lifecycle behavior against deterministic Gmail-shaped DOM fixtures. For every release candidate, also use a dedicated test mailbox with synthetic messages and record Chrome version, Gmail language, date, tester, and pass/fail evidence.

- One-message thread with no attachment.
- Multi-message thread with collapsed messages and trimmed quoted content.
- Empty/draft-like message body.
- Current thread, current page, selected rows, and all-pages scope.
- Inbox, Sent, label, search, Spam, Trash, and `in:anywhere` candidates.
- ANY and ALL rules, exclusions, whole-word, wildcard, valid/invalid regex.
- One-message ALL versus cross-message matching.
- Sender, recipient, domain, subject, date, message-count, attachment-presence rules.
- Whole-thread versus matching-message output.
- PDF, spreadsheet, unknown extension, uppercase extension, duplicate filename, inline image, logo, tiny image, and unknown-size file.
- Metadata-only, matching-download, all-download, and no-file actions.
- Chrome multiple-download prompt, completed file, interrupted file, erased file, and blocked/dangerous file.
- Attachment review shows matching/exclusion reasons; selected filenames populate rules; selective retry resumes only checked interrupted tasks.
- Local inspector hashes synthetic identical/different files correctly, searches text/PDF/DOCX/XLSX/PPTX, decodes embedded ToUnicode maps plus bounded Flate/ASCIIHex/ASCII85/RunLength filter chains, honors file/text/PDF-stream/CMap/object/ZIP-expansion limits, rejects encrypted PDFs, unsupported filters, malformed encodings, prototype-like font aliases, corrupt CRC, and unsafe packages, clears memory, and exports no extracted text/snippets.
- Opt-in OCR recognizes synthetic English PNG/JPEG and scanned-PDF fixtures, bypasses searchable PDFs, rejects unsupported/SVG/encrypted input, enforces image/PDF/page/session/pixel/dimension/text limits before expensive work, processes pages sequentially, terminates on cancellation, works with all runtime paths under `chrome-extension://`, and never places recognized text or page segments in a default report.
- PII detection validates Luhn/IBAN checksums, avoids common date/number false positives, redacts selected pattern types, keeps raw findings out of default reports, and includes structured suggestions only after explicit approval.
- Incremental SHA-256 matches standard vectors and Node's implementation across arbitrary chunk boundaries, never whole-reads unsupported large binaries, reports progress, enforces the 2 GB limit, and cancels cleanly.
- Simulated background routing failure does not click Gmail's download control or create duplicate downloads.
- Stop while opening, extracting, downloading, returning to list, and paginating.
- Resume after Stop, tab reload, browser restart, and expired job lease.
- Attempt concurrent start from two Gmail tabs.
- Unexpected manual navigation, offline/reconnect, signed-out session, and Gmail timeout.
- JSON, split JSON, NDJSON, CSV, TXT, Markdown, HTML search, merged basic PDF, individual-PDF ZIP/index/checksums, manifest, evidence ZIP/checksums, encrypted archive, and wrong-passphrase rejection.
- Unicode subject/sender/body/name, reserved device filename, traversal-like filename, very long name, and duplicate name.
- Incremental job skips only previously matched thread keys from the same exact scope.
- Delete current job, all jobs, all presets, and verify downloaded files remain.
- Diagnostics contain no subject, body, address, filename, Gmail URL, thread/message ID, or filter term.

## Release blockers

Do not publish when any completed thread can be silently lost or duplicated, diagnostics expose mailbox content, a permission lacks a shipped purpose, Stop corrupts a job, resume is not idempotent, raw email HTML executes in an extension page, or Gmail selector compatibility has not been confirmed.
