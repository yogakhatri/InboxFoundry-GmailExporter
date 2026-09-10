# InboxFoundry export format

InboxFoundry 4 writes JSON `formatVersion: 2`. UTF-8 JSON is the canonical archive; CSV, NDJSON, text, HTML, PDF, reconstructed EML/MBOX, attachment-manifest, and ZIP package files are derived views.

## Top-level fields

| Field | Meaning |
| --- | --- |
| `formatVersion` | Output contract version (`2`). |
| `schemaVersion` | Internal job/rule schema version. |
| `generator` | Product name and extension version. |
| `job` | Batch ID/name, lifecycle state, timestamps, and `isPartial`. |
| `source` | DOM source mode and starting Gmail URL. |
| `config` | Immutable normalized email, attachment, output, and safety rules. |
| `totals` | Inspected, matched, rejected, message, and download counters. |
| `threads` | Fully checkpointed matching conversation records. |
| `downloads` | Chrome download task state (`in_progress`, `complete`, `interrupted`, or `erased`). |
| `attachmentAnalysis` | Metadata-only duplicate candidates and filename-version families; never represented as a content-hash conclusion. |
| `integrity` | SHA-256 digest for each captured thread and the ordered thread array. |

`job.isPartial` is true for stopped, interrupted, failed, and draft jobs. A thread appears in `threads` only after extraction and attachment work for that thread has been durably checkpointed.

## Thread and message records

Each thread includes `threadKey`, `subject`, optional Gmail `url`, `captureMode`, timestamps, download folder, `matchEvidence`, `messages`, and `attachmentResults`.

`matchEvidence` contains rule reasons, original matching message indexes, and matching attachment names/indexes without storing surrounding content excerpts.

Messages include:

- original `index` and Gmail message ID when exposed;
- sender, recipients, original date, and visible header text;
- raw and normalized visible body text;
- raw body HTML only when enabled;
- attachment metadata;
- message download folder and per-file results.

DOM-captured HTML is untrusted input and is not an RFC 822 message. InboxFoundry therefore does not label it EML or MBOX.

## Attachment results

Per-thread results may use `ignored`, `metadata-only`, `started`, `failed`, or `limit-reached`. `started` means Chrome accepted the task; authoritative final state is in the top-level `downloads` array, which records download ID, method, routed folder, final path when available, completion time, and interruption error.

## Derived formats

- **NDJSON:** one complete thread object per line.
- **CSV:** one row per message; formula-leading cells are prefixed safely.
- **Text:** readable thread separators and message headers.
- **Searchable HTML:** escaped plain message text plus a fixed local-only search control; captured raw HTML is never injected.
- **Basic PDF:** text-oriented pages using a built-in PDF writer.
- **Individual PDFs ZIP:** one safely named text-oriented PDF per thread, plus `index.csv`, package notes, and `CHECKSUMS.sha256`.
- **Reconstructed EML ZIP:** one UTF-8, base64-transfer-encoded `.eml` per captured message, safely grouped by thread, plus `index.csv`, explicit reconstruction notes, and `CHECKSUMS.sha256`.
- **Reconstructed MBOX:** one mboxrd-compatible mailbox containing the same reconstructed messages for import into common desktop mail tools.
- **Attachment manifest:** CSV row per detected/requested file and result.
- **Evidence ZIP:** deterministic classic ZIP containing `archive.json`, `records.ndjson`, `records.csv`, `attachments.csv`, `attachment-analysis.json`, `index.html`, `README.txt`, and `CHECKSUMS.sha256`.

The ZIP contains record data and manifests, not attachment binaries. The binaries remain in the recorded Downloads folders because the local DOM extension cannot safely re-read arbitrary downloaded files without requesting broader filesystem capabilities. `CHECKSUMS.sha256` covers every other entry in the package, while `archive.json` retains per-thread integrity hashes.

EML and MBOX produced in DOM mode are intentionally marked `X-InboxFoundry-Reconstructed: true`. They contain captured date, sender, recipients, subject, text body, and attachment-name metadata, but are not original raw RFC 5322 messages: unavailable transport headers, MIME structure, and separately downloaded attachment bytes cannot be recreated exactly. Use canonical JSON for the highest-fidelity DOM-mode record; exact source EML remains a future Gmail API capability requiring separate consent.

JSON may be split into numbered parts using a configured thread count. Each part includes its index/count and hashes for only the records in that part.

## Encrypted archive

The optional `.ifenc` file is a JSON envelope containing AES-256-GCM ciphertext. A 256-bit key is derived locally from the user passphrase using PBKDF2-HMAC-SHA-256, a random 16-byte salt, and 250,000 iterations; every archive uses a random 12-byte IV. The passphrase is not saved in job configuration or extension storage. The side panel can decrypt the archive locally and download its canonical JSON. There is no password recovery.

## Compatibility

Consumers should reject unsupported major `formatVersion` values, ignore unknown fields, treat missing optional DOM fields as unavailable, and check `job.isPartial` before assuming mailbox-scope completion.
