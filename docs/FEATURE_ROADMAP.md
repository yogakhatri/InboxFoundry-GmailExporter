# Feature roadmap and product specification

Status: proposed for versions after 3.0  
Last researched: August 29, 2026

## Product goal

InboxFoundry should let a non-technical user define exactly which Gmail conversations to inspect, which messages to retain, which attachments to download, and which output formats to create—without sending mailbox data to an external service.

The extension must remain understandable and safe: users see the effective scope before starting, can stop without losing completed work, and receive an auditable report showing why each item was included, excluded, downloaded, or failed.

## Product principles

1. **Local by default.** Filtering and export happen on the user's device.
2. **Email selection and attachment selection are separate.** A user may export an email but download only matching attachments.
3. **Explicit matching rules.** Every filter states whether it uses ANY, ALL, exact phrase, wildcard, or regular-expression matching.
4. **No silent loss.** Skips, selector failures, unavailable attachments, interrupted downloads, and filter rejections are counted and explained.
5. **Safe interruption.** Stop, browser restart, tab closure, and extension service-worker shutdown do not corrupt completed results.
6. **Least permission.** Add a Chrome permission only when the released feature needs it.
7. **Versioned output.** Schema changes increment `formatVersion` and remain documented.

## Recommended interface

The existing popup is suitable for quick actions, but the complete filter builder should use a Gmail-specific Chrome side panel. A side panel stays visible while the user reviews Gmail and has enough space for validation, presets, progress, and errors. Chrome's Side Panel API is available in Chrome 114 and newer, so adopting it would require raising the minimum supported Chrome version and adding the `sidePanel` permission.

The toolbar popup should become a compact launcher showing:

- current job status and progress;
- **Open export builder**;
- **Pause/stop**;
- **Export partial result**;
- **Resume last job**; and
- the last error, when present.

## 1. Job lifecycle and partial exports

### Required behavior after user stop

When the user selects **Stop**:

1. Change status to `Stopping safely…` and prevent another job from starting.
2. Finish and checkpoint the current thread, or mark it incomplete and leave it eligible for retry. Never record a partially extracted thread as complete.
3. Stop opening new threads and starting new attachment downloads.
4. Persist the job as `stopped` with `stoppedAt`, current scope, rules, counters, completed thread IDs, pending retry items, and errors.
5. Show a completion card with:
   - candidate threads found;
   - threads inspected;
   - threads matched and exported;
   - messages exported;
   - attachments matched;
   - downloads complete, interrupted, and failed;
   - skipped and retryable items.
6. Present three clear actions:
   - **Export partial JSON**;
   - **Resume this job**;
   - **Start a new job**.
7. Support an optional setting: **Automatically export partial JSON when I stop**.

Partial output must contain only fully checkpointed records and include:

```json
{
  "jobStatus": "stopped",
  "isPartial": true,
  "stoppedAt": "2026-08-29T12:00:00.000Z",
  "resumeAvailable": true
}
```

### Lifecycle states

`draft → validating → running → pausing → paused → running → completed`

Alternative terminal states are `stopped`, `cancelled`, and `failed`. `paused` is resumable; `cancelled` requires an explicit decision to export or delete captured data.

### Job management

- One active job per Chrome profile, enforced with a lock and owning Gmail tab ID.
- Unique job ID, display name, Gmail account slot, source URL/query, created time, and updated time.
- Job history with counts but no email previews unless the user opens a job.
- Rename, duplicate, resume, export, or delete a job.
- Configurable retention: keep until deleted, delete after successful export, or delete after a chosen number of days.
- Warn before mixing a different Gmail account or scope into an existing dataset.

## 2. Source and mailbox scope

Offer these source modes:

- current Gmail list/search;
- current page only;
- all pages in the current view;
- currently selected Gmail rows;
- current open thread only;
- Inbox, Sent, Drafts, Spam, Trash, All Mail, or a chosen label;
- Gmail query built by the extension; and
- saved scope preset.

### Gmail query builder

The builder should expose common Gmail-supported criteria without forcing users to memorize syntax:

- sender (`from:`);
- recipients (`to:`, `cc:`, `bcc:`, `deliveredto:`);
- subject words or phrase (`subject:`);
- date range (`after:`, `before:`, `older_than:`, `newer_than:`);
- label and category;
- read, unread, starred, important, muted, and other status;
- has attachment, Drive file, document, spreadsheet, presentation, or inline image;
- attachment filename or extension (`filename:`);
- message size (`larger:`, `smaller:`);
- exact phrase, AND, OR, grouped criteria, and exclusions;
- mailing-list address; and
- raw advanced Gmail query for expert users.

Always show the generated query and provide **Open this search in Gmail** before export. Gmail documents these operators, but Gmail search works at conversation level in several cases. The extension must locally re-check user rules after opening each thread.

## 3. Email and message filtering

### Keyword rules requested for the product

Users can add:

- include keywords;
- exclude keywords;
- exact phrases;
- any-word, all-words, or ordered phrase matching;
- optional case sensitivity;
- whole-word matching;
- wildcard patterns such as `invoice*2026`;
- advanced regular expressions with validation and a timeout/complexity guard; and
- reusable named keyword groups, such as `Travel quote terms`.

### Searchable fields

Each keyword rule can target one or more fields:

- subject;
- sender display name and address;
- To, Cc, and Bcc values exposed by Gmail;
- visible header text;
- message plain text;
- normalized message text;
- attachment filename;
- thread combined text; and
- raw HTML, behind an advanced option because markup can create unexpected matches.

### Matching semantics

The interface must explicitly ask:

- **Match ANY include rule** or **match ALL include rules**?
- Do exclusions override inclusions? Recommended default: yes.
- Include the **whole thread** when one message matches, or export **matching messages only**? Recommended default: whole thread, with `matchedMessageIndexes` recorded.
- For a thread, must one message satisfy all rules, or may different messages satisfy different rules? Recommended default: one message must satisfy all message-level rules.
- Should quoted replies and signatures be searched? Offer `full visible body` and `best-effort newest content only` modes.

Every exported record should contain non-sensitive match evidence:

```json
{
  "match": {
    "matched": true,
    "ruleIds": ["subject-invoice", "body-overdue"],
    "fields": ["subject", "bodyTextNormalized"],
    "matchedMessageIndexes": [2]
  }
}
```

Do not store surrounding email excerpts in match evidence unless the user enables it.

### Additional email filters

- sender or recipient include/exclude lists;
- email domain include/exclude lists;
- date and time range;
- subject include/exclude;
- message or thread has/does not have attachments;
- minimum and maximum number of messages in a thread;
- read/unread, starred, important, label, and category where reliably exposed;
- only messages sent by me / received by me;
- language, using browser-local detection only and clearly marked experimental;
- duplicate message ID handling;
- maximum number of matched threads for sample exports; and
- random or first-N preview sample without downloading files.

## 4. Attachment selection and downloading

Attachment rules must control two independent decisions:

1. **Should this email/thread be included?** Optional rule: require at least one matching attachment.
2. **Which attachments should be downloaded?** This must not remove an otherwise matching email unless the user requests it.

### Attachment actions

- do not inspect or download attachments;
- record attachment metadata only;
- download matching attachments;
- download all attachments from matched emails; or
- download only attachments from the messages that matched email rules.

### File-type groups

Provide friendly multi-select groups plus custom extensions:

| Group | Default extensions |
| --- | --- |
| PDF | `.pdf` |
| Excel and spreadsheet | `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.csv`, `.tsv`, `.ods` |
| Word and document | `.doc`, `.docx`, `.rtf`, `.odt`, `.txt` |
| Presentation | `.ppt`, `.pptx`, `.odp` |
| Images | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.tif`, `.tiff`, `.bmp`, `.svg`, `.heic` |
| Archives | `.zip`, `.rar`, `.7z`, `.tar`, `.gz`, `.bz2` |
| Data | `.json`, `.xml`, `.yaml`, `.yml`, `.sql` |
| Email/calendar/contact | `.eml`, `.msg`, `.ics`, `.vcf` |
| Audio/video | common audio and video extensions |
| All other files | anything not classified above |

Extension matching is case-insensitive. If Gmail exposes a MIME type, record it and use it as supporting evidence, but use the filename extension as the DOM-mode fallback.

### Filename rules requested for the product

- filename contains any term;
- filename contains all terms;
- exact filename;
- filename starts with / ends with;
- wildcard pattern;
- validated regular expression;
- exclude filename patterns;
- include/exclude extensions; and
- case-sensitive option.

Example: export matching emails but download only `PDF` or `Excel and spreadsheet` files whose filename contains `invoice`, `rate`, or `quotation`, excluding `draft` and `sample`.

### Other attachment rules

- minimum/maximum file size when known;
- include or exclude inline images;
- include or exclude signature images;
- include or exclude duplicate attachments;
- duplicate strategy: keep all, keep first, or uniquify names;
- filename conflict strategy: uniquify by default, optionally skip;
- maximum files per message/thread/job;
- maximum total download bytes as a safety budget;
- organize by job / sender domain / date / thread / message;
- filename template using safe fields such as date, sender domain, subject, and original filename;
- metadata manifest even when no files are downloaded;
- retry failed or interrupted downloads only; and
- never automatically bypass Chrome dangerous-download warnings.

In DOM mode, size and MIME information may be unavailable before download. Such filters must use `unknown size/type` behavior chosen by the user: include, exclude, or ask/record.

### Accurate download status

Track Chrome download IDs until each job reaches `complete` or `interrupted`. Record final path, MIME type, bytes, completion time, interruption reason, and whether the file still exists when checked. Do not call a download complete merely because Chrome created it.

## 5. Export formats and contents

### Core formats

- versioned JSON bundle;
- newline-delimited JSON for large datasets;
- CSV summary with one row per message or thread;
- plain-text thread files;
- sanitized standalone HTML for reading, never raw HTML executed directly; and
- attachment manifest CSV/JSON.

### Advanced formats

- EML per message and MBOX per job only when the source provides true RFC 822 raw data;
- ZIP package containing records and downloaded files, with streaming/chunking for large exports;
- encrypted export using a user-provided passphrase and a documented modern format; and
- checksum manifest for integrity and duplicate detection.

DOM-captured `bodyHtmlRaw` is not equivalent to a complete EML message. Accurate EML/MBOX belongs to a future Gmail API mode because the API can return a message in `raw` format.

### Export choices

- include/exclude raw HTML;
- include/exclude Gmail URLs and internal IDs;
- redact email addresses in an analytics export;
- include only match evidence and metadata;
- pretty JSON or compact JSON;
- split output after a chosen record count or approximate size;
- deterministic filenames;
- time zone for normalized dates while retaining the original date string; and
- preview schema and estimated data sensitivity before downloading.

## 6. Preview, validation, and presets

- **Test rules** against the currently open thread without saving it.
- **Preview first N candidates** and show matched/rejected counts.
- Show a human-readable rule summary: “Export whole threads where subject or body contains ANY of …; exclude …; download PDFs and spreadsheets named …”.
- Warn about contradictory or empty rules.
- Validate regex and wildcard patterns before starting.
- Estimate scope from Gmail's visible result count when available, clearly marked as an estimate.
- Save, rename, duplicate, import, and export filter presets.
- Ship useful presets: all attachments, PDFs only, spreadsheets only, invoices, date-range archive, sender/domain archive, and metadata-only audit.
- Persist ordinary preferences separately from sensitive job data. Do not sync keywords or email-specific presets across browsers unless the user explicitly enables it.

## 7. Progress, diagnostics, and recovery

- Progress for pages, candidates, inspected threads, matches, messages, attachment matches, download states, rejects, and errors.
- Current phase and safe-stop explanation.
- Elapsed time, processing rate, and conservative ETA.
- Expandable sanitized event log with no body content by default.
- Per-thread outcome: exported, filtered out, skipped, retryable, or failed.
- Retry failed threads, failed attachments, or all retryable items.
- Configurable pacing and exponential backoff when Gmail is slow.
- Detect unexpected navigation, account change, tab closure, session expiry, offline state, storage errors, and disk/download interruption.
- Export a sanitized diagnostic report separately from mailbox data.
- Notify the user when a long job completes or needs attention, only if a future release adds and explains the notifications permission.

## 8. Data architecture and correctness

The current single large object in `chrome.storage.local` should be replaced before large feature-rich jobs are supported:

- IndexedDB with one record per job/thread/message for transactional checkpoints and large payloads;
- `chrome.storage.local` for small settings, active-job metadata, and migration markers;
- persisted service-worker routing because Manifest V3 service-worker globals can disappear after shutdown;
- write completed thread data before adding its key to the completed set;
- immutable rule snapshot stored with every job;
- schema and data migrations with rollback-safe backups;
- account/scope identity to prevent accidental cross-account mixing;
- job-level lock to block simultaneous tabs from overwriting shared state;
- idempotent attachment task IDs and thread IDs;
- bounded memory usage and chunked export generation; and
- storage usage display with cleanup controls.

Chrome documents that extension service workers can be terminated after inactivity and that global variables are lost. Chrome also warns that extension storage has quotas and performance costs. Job state therefore must not depend on in-memory globals.

## 9. Privacy, security, and release requirements

- Prominent first-run disclosure before any email is read.
- Plain-language explanation of every permission and data category.
- No analytics, remote code, or external processing by default.
- If optional integrations are ever added, require separate consent and show exactly what leaves the device.
- Escape spreadsheet-formula prefixes in CSV exports to prevent CSV injection.
- Sanitize paths against traversal, reserved names, control characters, and excessive length.
- Treat raw email HTML, filenames, URLs, and headers as untrusted data.
- Do not execute attachment content or automatically open downloaded files.
- Keep conflict action at `uniquify` or `skip`; do not overwrite by default.
- Content Security Policy and no `eval`/dynamic code.
- Clear all job data, presets, and logs independently.
- Automated checks for permissions, remote scripts, schema examples, filename sanitization, filter truth tables, migrations, and resume idempotency.
- Manual Gmail tests using synthetic accounts and fixtures.
- Chrome Web Store privacy policy, prominent disclosure, data-use declarations, screenshots, permission justifications, and a narrow single-purpose listing.

## 10. Optional advanced capabilities

These are valuable but should not delay the reliable filtering core:

- Gmail API source mode for structured messages, exact attachment IDs, raw EML, reliable pagination, and operation without manipulating the visible Gmail UI.
- Incremental exports since the previous successful job.
- Watch mode for new matching mail, only in Gmail API mode and with explicit consent.
- Local-only classification templates such as invoices, receipts, resumes, or travel quotes.
- User-authored JavaScript is intentionally not recommended because it increases security and Web Store review risk; a constrained rule language is safer.
- Optional local model integration only when the model and processing remain on-device and the performance/privacy cost is clearly disclosed.
- Checksums and content-based attachment deduplication after download.
- Export to a user-selected local folder if a future supported browser API provides an acceptable user-consented workflow.

## 11. DOM mode versus Gmail API mode

### Continue DOM mode for the next release

Advantages:

- no OAuth application or Google Cloud setup;
- works with the user's existing Gmail session;
- narrow host permission; and
- easy source installation.

Limitations:

- Gmail selector and language changes can break extraction;
- the Gmail tab must stay open and mostly untouched;
- attachment metadata is incomplete;
- visible HTML is not a raw email; and
- large jobs are slow because every conversation must be opened.

### Add Gmail API as a later optional engine

The Gmail API supports listing messages or threads with most Gmail search syntax, retrieving structured messages, and getting attachments. It can also return raw message data. It would substantially improve reliability and EML support.

However, it introduces OAuth client setup, additional API host access, sensitive Gmail scopes, consent-screen work, production verification, quotas, and a more complex open-source installation story. It should be a separate, optional engine—not a hidden replacement for the local DOM mode.

## 12. Recommended implementation order

### Phase A — Filtered exporter MVP

1. Safe stop with explicit partial-export card and auto-export option.
2. Versioned job/rule model and one-active-job lock.
3. Include/exclude keywords with ANY/ALL/exact modes and field selection.
4. Whole-thread versus matching-message export choice.
5. Attachment type groups, custom extensions, and filename include/exclude rules.
6. Separate `require matching attachment` from `download matching attachments`.
7. Partial JSON metadata, filter evidence, and complete counters.
8. Unit tests for rule truth tables and filename classification.

### Phase B — Reliability and usability

1. Side-panel filter builder, human-readable summary, validation, and presets.
2. Sender, recipient, domain, subject, date, label, status, size, and custom Gmail query builder.
3. Preview/dry run and max-result safety limit.
4. Accurate Chrome download completion/interruption tracking and retry queue.
5. IndexedDB record storage, transactional checkpoints, tab/account lock, and migrations.
6. Error dashboard, sanitized diagnostics, progress rate, and ETA.
7. CSV, NDJSON, text, and attachment-manifest outputs.

### Phase C — Power-user features

1. Selected-thread/current-thread modes and incremental exports.
2. Wildcards and guarded regular expressions.
3. Advanced naming/folder templates, size budgets, and deduplication.
4. Split exports, checksum manifests, sanitized HTML, and optional encrypted bundles.
5. Localization and selector-fixture test coverage.

### Phase D — Optional Gmail API engine

1. OAuth and minimal read-only scope design.
2. API query, message/thread retrieval, attachment retrieval, and quota handling.
3. True EML/MBOX export.
4. Incremental/watch workflows.
5. Google OAuth verification and updated privacy disclosures before public release.

## 13. Phase A acceptance criteria

Phase A is complete only when all of the following pass:

- Stopping a job never loses or duplicates a completed thread.
- The stopped screen offers partial export and resume without reopening Gmail rows already completed.
- Keyword ANY, ALL, exact, exclusion, case, whole-word, field, message, and thread semantics have automated truth-table tests.
- `PDF only` downloads PDFs and no other extensions, case-insensitively.
- `Excel and spreadsheet` recognizes every documented default extension.
- Filename include/exclude and custom-extension rules work with duplicate filenames and Unicode names.
- Email inclusion remains independent of attachment download selection.
- JSON records the immutable rules and the reason each exported item matched.
- Download states distinguish started, complete, interrupted, failed, and not requested.
- A browser restart or extension service-worker restart does not corrupt the job.
- Simultaneous Gmail tabs cannot write the same active job.
- A synthetic manual test covers single messages, long threads, quoted content, no attachments, duplicate attachment names, unknown extensions, pagination, stop/resume, and partial export.

## Research basis

- Gmail officially supports combined search operators for sender, recipients, subject, dates, labels, attachment presence and filename, size, exact phrases, AND/OR, grouping, and exclusions. It also notes that negative queries may still return a conversation because matching is message-based: [Refine searches in Gmail](https://support.google.com/mail/answer/7190?hl=en).
- Gmail API list methods accept most Gmail advanced-search syntax, but API and Gmail UI search semantics differ, including alias expansion and thread-wide search: [Search and filter messages](https://developers.google.com/workspace/gmail/api/guides/filtering).
- Gmail API exposes message, thread, and attachment resources: [Gmail API reference](https://developers.google.com/workspace/gmail/api/reference/rest).
- The API's raw format returns a full message as base64url data, which is the correct basis for EML rather than DOM HTML: [Gmail message formats](https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format).
- Chrome downloads can be tracked through `in_progress`, `interrupted`, and `complete`, and organized filenames are relative to the Downloads directory: [Chrome Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads).
- Chrome warns that extension storage has quotas and performance costs: [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage).
- Manifest V3 service workers can terminate after inactivity, and global variables are lost, so durable job state must be persisted: [Extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
- A persistent filter-builder UI is possible through the Chrome Side Panel API in Chrome 114+: [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
- Chrome Web Store policy requires narrow permissions, secure user-data handling, a privacy policy, and prominent disclosure where applicable: [User data and minimum-permission policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).
- A public Gmail API application using sensitive or restricted scopes may require Google verification: [OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies).
