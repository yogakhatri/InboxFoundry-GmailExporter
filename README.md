# InboxFoundry

![InboxFoundry icon](assets/icon128.png)

InboxFoundry is a privacy-first Chrome extension for filtering, organizing, and exporting Gmail conversations and attachments. It works locally against the Gmail interface: there is no account service, analytics SDK, remote processing, or Gmail API setup.

> Independent open-source software; not affiliated with or endorsed by Google. Gmail is a trademark of Google LLC.

## Highlights

- Scan the current Gmail inbox, label, category, or search across all result pages.
- Build Gmail searches for sender, recipient, date, label, size, attachment, unread, starred, and `in:anywhere` scope.
- Include or exclude keywords using ANY/ALL, contains, exact, starts/ends with, wildcard, whole-word, case-sensitive, or guarded regular-expression matching.
- Match subject, body, sender, recipients, visible headers, or attachment names.
- Filter sender, recipient, domain, subject, and date independently.
- Export whole matching threads or matching messages only, with match evidence.
- Independently ignore files, retain metadata, download every file, or download matching files only.
- Filter friendly file groups, custom extensions, filenames, and known file sizes.
- Safely stop after the current thread, export partial results, and resume durable checkpoints.
- Retain three named batches and five custom presets, plus starter workflows.
- Create incremental batches, safe folder templates, and split JSON archives.
- Export JSON, NDJSON, CSV, text, Markdown, searchable HTML, merged basic PDF, indexed/checksummed individual-PDF and reconstructed-EML ZIPs, reconstructed MBOX, an attachment manifest, and a verifiable evidence ZIP.
- Create and locally decrypt passphrase-protected AES-256-GCM JSON archives.
- Record Chrome download completion/interruption state and SHA-256 integrity hashes.
- Review discovered file decisions and durable download tasks, turn selected filenames into reusable include/exclude rules, and selectively resume interrupted files.
- Group likely duplicate attachments by normalized filename and known size, and group common draft/final/version filename families with explicit metadata-only confidence labels.
- Opt in to inspect explicitly selected local files: calculate real SHA-256 hashes, prove identical content, search supported documents, and run fully local English OCR on images or scanned PDFs without uploading or persisting their contents.
- Review transparent local document classifications, suggested invoice/PO/contract fields, and likely email/phone/card/IBAN/US-SSN patterns; optionally create best-effort redacted text copies.

Free safety limits are 250 matched threads and 500 attachment downloads per job. Rejected threads do not consume the match limit.

## Install from source

InboxFoundry requires Chrome 114 or newer.

1. Download or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the folder containing `manifest.json`.
4. Reload Gmail once after installation or an extension update.
5. Pin **InboxFoundry** for quick access.

## First export

1. Open Gmail in a list view, such as Inbox, All Mail, a label, or search results.
2. Open InboxFoundry and select **Open filter workspace**.
3. Read and acknowledge the local-data disclosure.
4. Optionally build a Gmail query and open it in Gmail.
5. Configure email rules, attachment rules, formats, and safety limits.
6. Open a representative conversation and choose **Preview open thread**, or choose **Test current-list sample** for a first-N dry run. Neither preview creates a job, saves message content, or downloads attachments.
7. Return to the Gmail list and choose **Start new export**. Keep that tab open and do not navigate it while the job runs.
8. If Chrome asks, allow multiple downloads from Gmail.

The popup also provides a quick unfiltered export. First-time users must acknowledge the disclosure in the workspace before any export starts.

## Stop, resume, and batches

**Stop safely** finishes and checkpoints the current thread, then stops before opening another. Enable automatic partial export or choose **Export saved results** afterward. Use **Resume saved job** from the same Gmail view to continue without repeating completed threads.

Each new export gets a separate batch and download folder. The three newest jobs can be reopened under **Recent batches**.

Open **Attachment review** for a retained batch to inspect matched/excluded filenames, classifications, sizes, and download states. Select discovered names to add them to the next batch's include or exclude rules. Interrupted Chrome downloads can be selected and resumed individually when Chrome reports that they are resumable.

Open **Local file inspector** to choose downloaded files manually. InboxFoundry incrementally hashes files up to 2 GB with progress and cancellation, temporarily extracts up to 2 MB from ordinary text files, and safely parses selected text PDFs, DOCX, XLSX, and PPTX within separate stream/package and total-text limits. PDF support includes common embedded `ToUnicode` font maps, inherited/indirect font resources, ASCIIHex, ASCII85, RunLength, Flate, and bounded filter chains. Search results identify the matching XLSX sheet, PPTX slide, DOCX part, or PDF content stream.

English OCR is a separate opt-in. It uses bundled Tesseract.js and PDF.js assets entirely inside the extension, processes selected files sequentially, and is used for supported images or PDFs that have no searchable text. The default limits are 20 selected images/PDF pages for the session, 10 pages per PDF, 20 MB per image, 50 MB per PDF, 16 megapixels per render, and 2 million recognized characters. Cancellation terminates the OCR worker. The first OCR run can take longer while the bundled model initializes; scanned-PDF OCR requires Chrome 118 or newer, while the rest of InboxFoundry remains supported from Chrome 114.

The inspector can prove content-identical files even when names differ, suggest business-document types and fields, and flag likely sensitive patterns. Extracted and OCR text and snippets stay out of reports; structured suggestions enter a report only after checking the approval control. Optional redacted copies never alter originals, include original/redacted hashes, per-pattern counts, a manifest and checksums, and must still be reviewed because automated detection can miss content. Clearing the inspector, cancelling analysis, or closing the side panel releases its in-memory content.

```text
Downloads/
└── InboxFoundry/
    └── Batch 001 · 8-29-2026/
        └── 00001 - Example subject/
            ├── Message-001/invoice.pdf
            └── Message-002/rates.xlsx
```

Chrome uniquifies conflicts; InboxFoundry never overwrites an existing download.

## Rule behavior

Email inclusion and file downloading are separate. A matching email can be exported while its files are ignored or metadata-only. **Require an attachment matching file rules** explicitly makes a matching file necessary for email inclusion.

Exclusions override inclusions. Whole-thread mode includes the complete loaded conversation when a message matches; matching-message mode keeps only matched messages and records original indexes. Gmail search defines candidates, but InboxFoundry re-checks local rules inside each thread.

Regular expressions are length- and complexity-guarded. File-size rules apply when Gmail exposes a recognizable size; unknown size behavior is recorded in the configuration.

## Output

JSON format version 2 contains the immutable configuration, source URL, lifecycle and partial flag, counters, records, match evidence, attachment results, Chrome download states, and SHA-256 integrity manifest. CSV formulas are neutralized. Printable HTML uses escaped text and does not execute captured email HTML.

**Evidence ZIP** packages canonical JSON, NDJSON, CSV, searchable HTML, an attachment manifest, metadata duplicate/version analysis, a plain-language README, and `CHECKSUMS.sha256`. Attachment binaries stay in their recorded Downloads folders: InboxFoundry deliberately does not request broad filesystem-read access merely to copy them back into the ZIP.

See [the export specification](docs/EXPORT_FORMAT.md), [audited implementation status](docs/IMPLEMENTATION_STATUS.md), [release test matrix](docs/TESTING.md), and [feature roadmap](docs/FEATURE_ROADMAP.md).

## Privacy and permissions

Email records and job state are stored in extension-owned IndexedDB. Small settings use `chrome.storage.local`. Requested exports and attachments go to Downloads. Deleting a job does not remove already downloaded files.

| Permission | Purpose |
| --- | --- |
| `https://mail.google.com/*` | Read the visible Gmail interface and use conversation/attachment controls. |
| `storage` | Store preferences and active-job metadata locally. |
| `unlimitedStorage` | Support larger local jobs, subject to available disk space. |
| `downloads` | Route and track requested attachment downloads. |
| `sidePanel` | Provide the persistent filtering and job workspace. |

No permission grants access to non-Gmail websites. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Known limitations

- DOM mode depends on Gmail's interface and may need selector maintenance after Gmail changes.
- Gmail language can affect pagination/control detection; English has the best current coverage.
- The Gmail tab must stay open. Completed checkpoints remain resumable after interruption.
- Gmail may not expose size, MIME type, or a usable control for every attachment, Drive link, or signature asset.
- PDF extraction supports ordinary unencrypted text PDFs with common embedded Unicode maps and bounded plain, Flate, ASCIIHex, ASCII85, and RunLength streams. Opt-in OCR supports English text in PNG, JPEG, WebP, BMP, GIF, and scanned PDFs, but it is best-effort: handwriting, low-resolution pages, complex layouts, and languages other than English may be inaccurate. Searchable PDFs bypass OCR. Encrypted PDFs and SVG are not OCRed. Object streams, LZW, unusual CMaps, predictors, uncommon filters, or missing Unicode maps may yield incomplete direct extraction. Legacy Office, audio, video, and other binary formats are hash-only. Incremental hashing is skipped above the 2 GB per-file safety limit.
- Basic PDF is text-oriented. DOM-mode EML/MBOX files are clearly marked reconstructions and omit unavailable transport headers, original MIME structure, and attachment binaries; exact source messages require a future, separately consented Gmail API engine.
- Normal exports and separately downloaded attachments are not encrypted. The optional `.ifenc` JSON archive is passphrase encrypted, but its separately downloaded attachments are not packaged inside it.

## Troubleshooting

- **Cannot connect:** reload Gmail once after installing/updating.
- **No rows found:** return to a Gmail list/search, not an open conversation.
- **Resume refused:** return to the original Gmail list/search for that batch.
- **Files blocked:** allow multiple downloads for `mail.google.com` and inspect `chrome://downloads`.
- **Selector failure:** report Chrome/Gmail language and sanitized diagnostics; never post mailbox content.

## Development

```bash
npm test
```

This runs syntax, filter/export unit tests, and manifest/resource validation. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for manual Gmail regression testing. Report vulnerabilities via [SECURITY.md](SECURITY.md).

Run the account-free browser lifecycle gate (requires OpenSSL and a compatible Chromium/Brave executable):

```bash
npm run test:browser
```

It uses a fresh temporary browser profile and a loopback-only synthetic Gmail fixture to verify filtering, safe Stop, partial-export availability, resume, IndexedDB durability, workspace loading, service-worker restart, reload recovery, and the actual bundled OCR stack against synthetic image and scanned-PDF fixtures. `npm run test:release` runs both automated gates. See [release testing](docs/TESTING.md) for requirements and the remaining real-Gmail synthetic matrix.

To build an allowlisted Chrome release archive after the full automated gate passes:

```bash
npm run package
```

The command creates `dist/inboxfoundry-vVERSION.zip` and a matching SHA-256 checksum. It deliberately excludes source-control metadata, tests, issue templates, and local files.

Community expectations and help boundaries are documented in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SUPPORT.md](SUPPORT.md).

## License

MIT. See [LICENSE](LICENSE).
