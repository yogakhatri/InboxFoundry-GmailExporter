# Commercial product implementation plan

Status: implementation in progress; see [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for audited shipped/deferred boundaries  
Working product name: **InboxFoundry**  
Working tagline: **Find it. Filter it. Export it.**

## 1. Product we are building

InboxFoundry will be a privacy-first email export and attachment-archive product. It will help users:

1. choose a Gmail scope;
2. create precise email and attachment rules;
3. preview what matches and remove unwanted material;
4. safely export messages and files;
5. preserve the source context and integrity of every record; and
6. resume, repeat, or automate the workflow.

The product will not be marketed as a scraper. The public promise will be:

> Find the exact conversations and files you need, remove the clutter, preserve their context, and create a private, verifiable archive.

## 2. Scope decisions

### Included in the main product

- Gmail email and attachment discovery.
- Granular filters and exclusions.
- Local export and document packaging.
- Attachment preview, classification, search, and organization.
- Safe jobs, checkpoints, partial export, resume, and retry.
- Local privacy and optional encrypted archives.
- Cloud filing and workflow automation in paid plans.
- Professional and team recordkeeping workflows.
- Optional Gmail API engine after the DOM product is stable.
- Outlook/Microsoft 365 as a later platform expansion.

### Deliberately excluded from the early product

- Mail merge.
- Marketing-email sending.
- Automatic replies.
- Contact enrichment.
- A full CRM.
- Bulk deletion or destructive mailbox cleanup.
- Cloud AI enabled by default.
- Claims of guaranteed legal admissibility.

These exclusions keep the product focused, reduce permissions, and preserve customer trust.

## 3. Product tiers

Privacy, safe stop/resume, transparency, and basic diagnostics will never be paid-only safety features.

### Free — a genuinely useful product

Free users receive:

- current message, current thread, selected rows, current page, Gmail search, and label scope;
- Gmail query builder for sender, recipient, subject, date, label, status, attachments, and filename;
- include and exclude keywords;
- ANY, ALL, exact phrase, whole-word, case-sensitive, wildcard, and guarded regex rules;
- subject, sender, recipient, headers, body, thread text, and attachment-filename fields;
- whole-thread or matching-message export;
- attachment type groups and custom extensions;
- filename include/exclude rules;
- inline image, signature logo, tiny image, and common clutter exclusion;
- attachment metadata-only or local-download mode;
- preview/dry run;
- clear match reasons;
- safe stop, partial export, resume, and retry;
- accurate started/complete/interrupted/failed download states;
- JSON, CSV, NDJSON, TXT, and sanitized HTML;
- basic PDF export for smaller jobs;
- standard local folder organization;
- three retained jobs and five saved presets;
- a generous limit of 250 matched threads and 500 downloaded attachments per job;
- unlimited new free jobs, subject to the per-job limits;
- local processing, no email-content upload, and no advertising.

The exact limits will remain remotely configurable only if this can be done without transmitting mailbox information. The application should count completed records locally and send no email identifiers, subjects, filenames, or filter terms to licensing services.

### Personal Pro

Everything in Free, plus:

- unlimited job size within practical browser and disk limits;
- unlimited saved jobs and presets;
- merged and individual PDFs;
- ZIP packages and offline searchable archives;
- advanced filename and folder templates;
- compact views that remove quoted text and signatures;
- password-protected and encrypted packages;
- checksum manifests;
- split exports by size or record count;
- incremental exports;
- attachment duplicate and version tools;
- local attachment-text extraction;
- local PDF/document/spreadsheet search;
- local OCR allowance or optional OCR add-on;
- advanced export templates;
- priority retry and recovery tools; and
- personal commercial-use license.

### Business

Everything in Pro, plus:

- Google Drive and saved Drive destinations;
- Shared Drive support;
- label-triggered and scheduled workflows where the selected engine supports them;
- workflow packs for accounting, legal, real estate, HR, travel, insurance, procurement, sales, and projects;
- multiple Gmail accounts;
- reusable client/project/matter destinations;
- advanced audit manifests;
- business-use licensing;
- priority support; and
- optional Dropbox, OneDrive, Box, S3, SFTP, or WebDAV connectors.

### Team

Everything in Business, plus:

- central billing;
- members and roles;
- shared presets and destinations;
- administrator policies;
- team audit logs without body content;
- Google Workspace deployment guidance;
- usage summaries that contain no mailbox content;
- member onboarding and offboarding; and
- invoiced annual plans.

### Enterprise

Everything in Team, plus:

- optional Gmail API engine;
- domain-level deployment and supported administrator workflows;
- SAML SSO and SCIM;
- service-account/domain-wide-delegation design where appropriate;
- DPA and security documentation;
- custom retention and regional requirements;
- SLA and dedicated support;
- API, webhook, and custom destination work;
- security assessment support; and
- volume licensing.

## 4. Technical foundation

Maximum features cannot be safely added to the current single-file state model. The foundation will be upgraded before expanding the interface.

### User interface

- Replace the small popup as the main workspace with a Gmail-specific Chrome side panel.
- Keep a compact popup for status, stop, resume, partial export, and opening the side panel.
- Organize the side panel into Scope, Email rules, Attachment rules, Output, Destination, Preview, and Progress steps.
- Always show a human-readable summary of the effective job.
- Use progressive disclosure so normal users see simple choices and experts can open advanced rules.

### Storage

- Use IndexedDB for job, thread, message, attachment, event, and download-task records.
- Use `chrome.storage.local` only for small settings, migrations, active-job metadata, and licensing state.
- Store one record per item instead of serializing the entire mailbox after every thread.
- Generate large outputs through chunks rather than loading everything into memory.
- Display storage usage and cleanup controls.

### Durable job engine

- Formal state machine: draft, validating, running, pausing, paused, stopped, completed, failed, and cancelled.
- Transactional checkpoint after every completed thread.
- Do not add a thread to the completed set until its data is committed.
- Persistent job queue and download-task queue.
- One-active-job lease tied to the owning Gmail tab.
- Account and scope identity to prevent mixed datasets.
- Idempotent thread, message, and attachment task IDs.
- Resume after tab, browser, content-script, and service-worker restarts.
- Immutable copy of filters and output settings stored with each job.

### Modular engines

- Gmail DOM adapter.
- Filter evaluation engine.
- Attachment classifier.
- Document renderer.
- Export writers.
- Download coordinator.
- Destination connectors.
- Future Gmail API adapter.
- Future Outlook adapter.

### Testable rule model

All filters will be represented as versioned data instead of popup-specific fields. This allows presets, import/export, repeatability, migrations, automated tests, and future API execution.

## 5. Build phases

Each phase has an exit gate. A phase is not complete merely because its UI exists.

## Phase 0 — Product and schema freeze

### Work

- Confirm InboxFoundry as the working brand or replace it after trademark/domain review.
- Finalize free and paid boundaries.
- Define versioned Job, Scope, EmailRule, AttachmentRule, ExportProfile, Destination, MatchEvidence, Error, and AuditEvent schemas.
- Define exact ANY/ALL/thread/message/exclusion semantics.
- Define the file-type classification table.
- Define privacy and licensing data flows.
- Create synthetic Gmail test scenarios and fixture emails.

### Exit gate

- Every visible control maps to a documented schema field.
- Filter truth tables are agreed upon.
- No implementation-critical product ambiguity remains.

## Phase 1 — Architecture and side-panel shell

### Work

- Create the side-panel application and compact popup.
- Implement IndexedDB repositories and migrations.
- Implement job state machine and job lock.
- Add structured logging that excludes email bodies by default.
- Add storage usage and independent data deletion.
- Migrate existing v3 data without loss.
- Split content extraction, background coordination, state, and UI responsibilities.

### Exit gate

- A synthetic job can start, checkpoint, stop, resume, complete, and delete without scraping Gmail.
- Browser/service-worker restart tests preserve state.
- Two Gmail tabs cannot modify one active job.

## Phase 2 — Generous Free filtering core

### Scope features

- Current thread.
- Selected Gmail rows.
- Current page.
- All pages in current view.
- Current search or label.
- First-N safety limit.
- Gmail query builder and expert raw query.

### Email filters

- Include/exclude keyword lists.
- ANY/ALL/exact/whole-word/case/wildcard/regex modes.
- Subject, sender, recipient, header, body, thread, and attachment-name fields.
- Sender/recipient/domain include and exclude.
- Date, subject, attachment presence, and thread-size rules.
- Whole-thread versus matching-message output.
- One-message-must-satisfy versus cross-message matching.
- Match evidence and rejection reasons.

### Attachment filters

- Type groups.
- Custom extensions.
- Filename contains/all/exact/start/end/wildcard/regex.
- Filename and extension exclusions.
- Metadata-only, matching-download, and all-download modes.
- Require a matching attachment as a separate email rule.

### Exit gate

- Automated truth-table tests cover every logical combination.
- A preview shows identical results to the subsequent export.
- Email inclusion and attachment downloading cannot affect each other accidentally.

## Phase 3 — Safe jobs, partial export, and accurate downloads

### Work

- Safe pause and stop behavior.
- Explicit partial-export completion card.
- Optional automatic partial JSON after stop.
- Resume last job and retry failed items.
- Accurate Chrome download lifecycle tracking.
- Final filename, MIME, bytes, completion time, and interruption reason.
- Per-thread and per-file outcome dashboard.
- Pacing, timeouts, bounded retries, and exponential backoff.
- Unexpected navigation, offline, account change, disk, storage, and session-expiry handling.
- Sanitized diagnostic export.

### Exit gate

- Stopping never duplicates or loses a completed thread.
- Download counters distinguish queued, started, complete, interrupted, cancelled, blocked, and failed.
- Restart-and-resume tests are idempotent.

## Phase 4 — Free export formats and organization

### Work

- Versioned JSON.
- CSV per thread/message and attachment manifest.
- NDJSON.
- TXT.
- Markdown.
- Sanitized HTML.
- Basic separate PDF output for free-size jobs.
- Standard job/thread/message folder structure.
- Safe and deterministic filenames.
- Original filename and path metadata.
- Conflict strategies: uniquify and skip.
- Output preview and approximate size estimate.

### Exit gate

- Every format has fixtures and schema validation.
- CSV formula injection is prevented.
- Raw HTML is never executed as trusted extension content.
- Unicode, reserved names, long paths, and duplicate names pass tests.

## Phase 5 — Attachment workspace and clutter removal

### Work

- Attachment list and thumbnail views.
- Preview supported files.
- Reveal exact source message.
- Jump back to Gmail source.
- Hide inline images, signature logos, social icons, tracking pixels, thumbnails, and tiny assets.
- Duplicate attachment ID and filename detection.
- Revision ordering and keep-all/keep-newest choice.
- Select individual files after filtering.
- File count, file size, and total-size safety budgets where metadata permits.

### Exit gate

- Clutter rules are explainable and reversible.
- No file is discarded without being visible in an excluded-items view.
- Source-message relationships survive every output format.

## Phase 6 — Pro packaging and archive formats

### Work

- One PDF per message/thread.
- Merged PDF.
- Page numbering and headers/footers.
- Compact PDF without quoted text/signatures.
- ZIP per thread/job.
- Offline searchable HTML archive.
- Custom safe folder and filename templates.
- Split large output packages.
- Password protection/encryption.
- SHA-256 checksum manifest.
- Signed generation manifest where practical.
- Export profiles for repeated workflows.

### Exit gate

- Large exports run with bounded memory.
- Archive indexes open offline.
- Encrypted packages cannot be opened with an incorrect password.
- Integrity checks reproduce the manifest hashes.

## Phase 7 — Local document intelligence

### Work

- Extract text from PDF, DOCX, XLSX, CSV, PPTX, and supported text formats.
- Local OCR for scanned PDFs and images.
- Search inside attachment contents.
- Show file/page/sheet match evidence.
- Local structured extraction for invoices, receipts, quotations, resumes, contracts, and statements.
- Version similarity and duplicate-content hashing.
- Optional PII detection and redaction copy.
- On-device classification and summarization experiments.

### Exit gate

- No document content leaves the device in default mode.
- Extraction confidence and sources are visible.
- Users approve structured results before export.
- OCR and parsers have file-size, CPU, and timeout protections.

## Phase 8 — Destinations and repeat automation

### Work

- Google Drive folder picker and uploads.
- Shared Drives.
- Saved destinations.
- Project/client/matter destination presets.
- Incremental exports.
- Label-triggered workflows where technically reliable.
- Scheduled workflows in the appropriate engine.
- Dropbox, OneDrive, Box, S3, SFTP, and WebDAV connectors based on demand.
- Google Sheets, Airtable, CRM, accounting, API, and webhook outputs based on demand.
- Resumable cloud uploads.
- Destination permission and connectivity checks before starting.

### Exit gate

- Every connector uses least-privilege consent.
- Users see exactly which data leaves the device.
- Failed uploads resume without duplicating remote files.

## Phase 9 — Professional workflow packs

### Work

- Accounting invoices/receipts/statements/W-9 pack.
- Legal matter/exhibit/header/hash pack.
- Real estate transaction pack.
- Mortgage closing-document pack.
- HR onboarding/employee-record pack.
- Recruiting resume/candidate pack.
- Travel quotation/itinerary/rate/voucher pack.
- Insurance claim-document pack.
- Procurement quotation/PO/vendor pack.
- CRM/client-conversation pack.
- Project approval/deliverable pack.
- Education account-offboarding pack.

Each pack contains filters, file groups, naming templates, folder templates, export columns, destination suggestions, and warnings. Packs are editable—not black-box automation.

### Exit gate

- Each pack has synthetic examples, documentation, and expected-output fixtures.
- No pack claims regulatory compliance without the necessary review.

## Phase 10 — Licensing and commercial launch

### Work

- Free, Pro, Business, Team, and Enterprise entitlement model.
- Monthly, annual, and optional lifetime personal licensing.
- Trial and refund handling.
- Secure license verification with offline grace period.
- Customer portal, invoices, taxes, and license transfer.
- Upgrade/downgrade and cancellation.
- No email-content data in billing or licensing requests.
- Onboarding, help center, tutorials, changelog, compatibility page, and feedback voting.
- Opt-in sanitized crash diagnostics.

### Exit gate

- Product remains usable when the license server is briefly unavailable.
- Free functionality cannot be remotely disabled by mistake.
- Billing telemetry contains no mailbox content or filter terms.

## Phase 11 — Team and enterprise controls

### Work

- Central billing and member management.
- Roles and policies.
- Shared presets and destinations.
- Team audit logs.
- SSO/SCIM.
- Enterprise deployment packages and documentation.
- DPA, security whitepaper, SLA, procurement documentation, and support processes.
- Security assessment and incident-response exercises.

### Exit gate

- Tenant separation tests pass.
- Administrators cannot read user exports unless the product explicitly supports and discloses that workflow.
- Enterprise logs remain content-free by default.

## Phase 12 — Optional Gmail API engine

### Work

- OAuth and minimal read-only scope.
- Message/thread listing, structured retrieval, attachment retrieval, and quota handling.
- Gmail query execution.
- True raw EML.
- MBOX generation.
- Reliable incremental and scheduled jobs.
- Domain administrator workflows only after separate review.
- CASA/OAuth verification and updated public disclosures.

### Exit gate

- DOM and API exports use the same rule and output schemas.
- Rate limits use bounded exponential backoff.
- Revoked authorization cleanly disables API functionality.
- API mode is optional and never silently enabled.

## Phase 13 — Platform expansion

### Work

- Edge, Brave, and Opera compatibility certification.
- Safari feasibility and adapter.
- Outlook/Microsoft 365 adapter.
- Cross-platform preset format.
- Optional desktop companion only for PST, very large archives, or selected-folder workflows that cannot be safely handled by a browser extension.

## 6. Feature-category mapping

The previously researched 24 categories are covered as follows:

| Category | Primary phase |
| --- | --- |
| Export scope | 2 |
| Gmail query builder | 2 |
| Keyword/content filters | 2 |
| Searchable fields | 2 and 7 |
| Unwanted-email filtering | 2 and 5 |
| Attachment-type filtering | 2 |
| Filename filtering | 2 |
| Attachment clutter removal | 5 |
| Attachment-content search | 7 |
| Attachment actions | 2, 3, and 5 |
| Output formats | 4, 6, and 12 |
| Folder/filename organization | 4 and 6 |
| Destinations | 8 |
| Stop/pause/resume/partial export | 3 |
| Preview/review | 2 and 5 |
| Progress/diagnostics | 3 |
| Job/preset management | 1 and 2 |
| Automation | 8 and 12 |
| Record integrity/legal tooling | 6 and 12 |
| Privacy/security | every phase |
| Team/business | 11 |
| Vertical workflow packs | 9 |
| Optional AI/structured extraction | 7 |
| Commercial product systems | 10 and 11 |

## 7. Quality plan

### Automated tests

- Filter truth tables.
- Wildcard and guarded regex behavior.
- File-type classification.
- Filename sanitization.
- Folder template safety.
- Match evidence.
- Thread versus message rules.
- Email versus attachment-rule independence.
- State-machine transitions.
- Resume idempotency.
- Active-job locking.
- Download event recovery.
- Database migrations.
- Export schemas and examples.
- CSV injection prevention.
- HTML sanitization.
- Encryption and checksum verification.
- Permission and remote-code checks.

### Browser tests

- Synthetic Gmail accounts.
- Conversation view on and off.
- One-message and very long threads.
- Collapsed messages and trimmed text.
- Pagination.
- Gmail labels and searches.
- Multiple Gmail languages.
- Multiple Gmail accounts and delegated accounts.
- Empty messages, drafts, Spam, Trash, and inline-only content.
- Duplicate filenames and unknown extensions.
- Offline/reconnect and Gmail timeout behavior.
- Stop/resume at every processing phase.
- Browser and extension restart.

### Release gates

- No known data-loss or duplication defect.
- No silent skipped thread.
- No content in diagnostics or licensing calls.
- Permissions match shipped features.
- Privacy documentation matches actual behavior.
- Automated validation and manual synthetic Gmail checklist pass.
- Gmail selector compatibility confirmed before release.

## 8. Metrics without mailbox surveillance

If the user explicitly opts into product analytics, collect only:

- installation and app version;
- broad feature events such as preview started or export completed;
- anonymous success/failure codes;
- duration buckets;
- output format category;
- plan and entitlement state; and
- browser/OS compatibility information.

Never collect:

- sender or recipient;
- subject;
- body;
- attachment name or content;
- Gmail URL, thread ID, or message ID;
- keyword or regex rules;
- destination paths; or
- filenames.

Primary business metrics:

- first successful export rate;
- time to first successful export;
- job completion rate;
- resume success rate;
- attachment completion rate;
- preview-to-export conversion;
- weekly retained users;
- free-to-paid conversion;
- support tickets per 1,000 jobs; and
- Gmail UI breakage detection time.

## 9. Recommended launch sequence

1. **Free private beta:** Phases 0–4.
2. **Public free beta:** Add Phase 5 and stabilize Gmail compatibility.
3. **Personal Pro launch:** Add Phase 6 and selected Phase 7 capabilities.
4. **Business launch:** Add Drive, repeat workflows, and the first vertical packs from Phases 8–9.
5. **Team launch:** Add Phase 11 controls.
6. **Enterprise/API launch:** Complete Phase 12 and required security/OAuth work.
7. **Platform expansion:** Phase 13.

## 10. Immediate implementation backlog after plan approval

No code should start until the first six items are approved:

1. Final working name and positioning.
2. Free-tier limits and paid boundaries.
3. Whole-thread versus matching-message default.
4. Stop semantics: finish current thread or stop immediately and retry it.
5. Whether PDF belongs in the first Free release or the next release.
6. Minimum Chrome version after adopting the side panel.

Once approved, implementation begins with:

1. versioned schemas;
2. filter truth tables and test fixtures;
3. IndexedDB job repository;
4. durable job state machine and lock;
5. side-panel shell; and
6. migration of the current exporter into the modular job engine.
