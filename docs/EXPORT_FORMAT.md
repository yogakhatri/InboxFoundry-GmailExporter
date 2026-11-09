# Export format

`emails.json` (`formatVersion: 3`) is the most complete record. Other formats are derived from the same captured data. All exports are copies read from the Gmail web page, not Google's original messages.

## Top-level JSON fields

| Field | Meaning |
| --- | --- |
| `formatVersion` | Output contract version |
| `generator` | Product and version |
| `job` | Batch name, status, timestamps, `isPartial`, `partialReasons`, `partialExplanations` |
| `exportedAt` | When this file was written |
| `source` | Scope, and starting Gmail URL unless hidden |
| `config` | Rules used. Search terms are replaced when addresses are hidden |
| `totals` | `inspected`, `matched`, `rejected`, `unchanged`, `failed`, `incomplete`, `repeatedViews`, `messages`, `unread`, `matchedThreads`, `excludedInReview` |
| `threads` | Conversation records |
| `integrity` | SHA-256 per record and across all records. Detects accidental corruption only |

**Always check `job.isPartial`.** It's true if the scan was stopped, hit a limit, couldn't confirm the last page, or couldn't fully read some conversations. Reasons include `stopped`, `limit-matched`, `limit-inspected`, `pagination-end-unconfirmed`, `threads-failed`, `threads-incomplete`, `rows-opened-same-conversation`, and `no-rows-found`.

## Records

Each thread has `recordId`, `threadKey` (optional), `subject`, `url` (optional), `captureMode`, `folder`, `capturedAt`, `wasUnread`, `warnings`, `matchEvidence`, and `messages`.

`warnings` may include `messages-not-readable:N`, `gmail-shows-N-messages-captured-M`, `date-unverified`, and `no-gmail-thread-id`.

Each message has `index`, `messageId` (optional), `from`, `fromName` (optional), `recipients` (To and Cc merged, because the page doesn't reliably separate them), `date` (as Gmail displayed it), `dateIso`, `dateSource` (`displayed`, `message-id`, or `unknown`), `rawHeaderText`, `bodyTextRaw`, `bodyHtmlRaw` (optional), and `attachments`.

`bodyHtmlRaw` is untrusted content. Don't render it without sanitizing.

## Other formats

- **CSV:** one row per message, UTF-8 with a BOM, with formula-like cells neutralized.
- **Attachment list CSV:** every file found, whether it was selected, its final state, saved path, and why it was left out. States: `discovered`, `skipped`, `unavailable`, `pending`, `in_progress`, `complete`, `interrupted`, `failed`, `erased`, plus `google-drive-link`.
- **HTML:** escaped text with search and a print button. Printing is the way to get a PDF, and it handles every language. Captured HTML is never injected.
- **EML ZIP and MBOX:** marked `X-InboxFoundry-Reconstructed: true`, with stable unique Message-IDs and `In-Reply-To`/`References` within a conversation. If no date could be read, the export time is used and `X-InboxFoundry-Date-Estimated: true` is set. Attachment names are listed in a header, and the files stay in their folders.
- **Archive ZIP:** `emails.json`, `emails.csv`, `attachments.csv`, `emails.html`, `README.txt`, and `CHECKSUMS.sha256`. Limited to 4 GB and 65,535 entries; you'll get a clear error beyond that.

## Encrypted files (`.ifenc`)

Encryption bundles the chosen formats into a ZIP, then encrypts it. The file is:

1. The line `INBOXFOUNDRY-ENC2`.
2. A one-line JSON header: `cipher`, `kdf`, `iterations`, `salt` (hex), `noncePrefix` (hex), `chunkSize`, `contentName`.
3. Ciphertext chunks: each plaintext chunk of `chunkSize` bytes, plus a 16-byte tag.

The key is AES-256 from PBKDF2-HMAC-SHA-256. Each chunk's 12-byte IV is the 8-byte prefix followed by a big-endian 32-bit chunk index, and its additional data is one byte: `1` for the final chunk, else `0`. Reordering or truncation therefore fails to decrypt. The side panel can decrypt these files; the format is documented so that any tool can.
