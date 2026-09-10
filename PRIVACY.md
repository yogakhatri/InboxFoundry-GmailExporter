# Privacy

Last updated: August 30, 2026

InboxFoundry is designed to process data locally in the user's browser.

## Data the extension accesses

When the user starts an export, the extension reads content that Gmail exposes in the active mailbox interface, including thread subjects, message headers, sender and recipient information, dates, message text, message HTML, attachment names, and attachment download controls.

The optional local file inspector reads only files the user explicitly chooses through Chrome's file picker. It can hash selected files, temporarily decode supported text-like PDF, DOCX, XLSX, PPTX, and ordinary text files, and—only when separately enabled—recognize English text in supported images and scanned PDFs. OCR uses bundled local model and renderer files; it does not use a CDN or remote recognition service. The inspector does not automatically scan Downloads or any folder.

## How data is used and stored

- Captured thread and message data is stored locally using Chrome extension storage so the export can resume and the user can download JSON later.
- Generated JSON is saved to the user's configured Downloads directory.
- Job records are checkpointed in extension-owned IndexedDB; small settings use extension local storage.
- When selected, attachments are downloaded through Chrome into `InboxFoundry` below the configured Downloads directory.
- The side panel requires a one-time plain-language acknowledgement before the first export.
- Optional archive encryption and decryption happen locally with Web Crypto. Passphrases are used only for the current action and are not persisted.
- Local file-inspector text, including OCR-recognized text, remains only in side-panel memory until the inspector is cleared or the panel closes. OCR cancellation terminates its local worker. Large selected files are hashed incrementally in bounded chunks and are not copied into extension storage. Exported inspector reports contain filenames, metadata, hashes, duplicate groups, OCR engine metadata, the user's search query, and match counts, but not full extracted/OCR text, OCR page segments, or search snippets. Local classification, likely-sensitive-pattern findings, and structured field suggestions are excluded unless the user explicitly approves their inclusion. Optional redacted text copies are generated only on request and may still contain sensitive material that detection or OCR missed.
- Data remains until the user selects **Delete saved export data**, removes the extension, clears the extension's storage, or deletes downloaded files.

## Data sharing and network use

The extension does not transmit captured mailbox data to the project maintainers or to an analytics, advertising, telemetry, or other third-party service. It does not contain remote code.

Gmail and attachment requests still communicate with Google as part of the user's existing Gmail session. Chrome may provide browser services such as download reputation checks according to the user's browser configuration; those services are outside this project's control.

## User responsibility

Exported email may contain personal, confidential, regulated, or copyrighted information. Users are responsible for authorization to export it, secure storage, retention, sharing, and deletion.

Because this source-distributed project can be modified by anyone, this statement applies to the unmodified source in this repository. Review changes before installing a fork.
