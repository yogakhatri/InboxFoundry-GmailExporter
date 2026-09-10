# Implementation status

This document separates shipped behavior from the commercial roadmap. It is intentionally conservative: a phase is not called complete merely because controls or interfaces exist.

Last audited: 2026-08-30 against InboxFoundry 4.5.0.

| Phase | Status | Verified implementation | Remaining gate work |
| --- | --- | --- | --- |
| 0 — Product/schema | Substantial | Versioned job/config/output schemas, documented match semantics, classification table, Free limits, working brand | Trademark/domain review; larger synthetic Gmail fixture corpus |
| 1 — Architecture | Substantial | Side panel + popup, IndexedDB v2 job/thread/message/attachment/download/event/preset stores, v1 upgrade, formal lifecycle, expiring tab lease, compact local metadata, storage estimate and independent cleanup, mocked service-worker restart routing test, account-free real-browser content/worker/workspace lifecycle harness | Larger Gmail-selector fixture corpus and dedicated synthetic-mailbox compatibility runs |
| 2 — Free filtering | Substantial | Current thread/page/selected rows/all pages/search, Gmail query builder, keyword/address/domain/date/subject/thread-size/attachment rules, whole-thread/matching-message modes, cross-message logic, match evidence, open-thread preview, content-free first-N current-list dry run, presets | Robust extraction of Gmail-only read/important/label state inside opened threads |
| 3 — Reliability | Substantial | Transactional terminal checkpointing, safe Stop, partial export availability, resume, retryable thread outcomes, queued/started/complete/interrupted/failed download states, fail-closed click routing, selective resumable-download retry, lease recovery, diagnostics, rate/elapsed display, automated browser Stop/resume/worker-restart/reload recovery | Re-opening Gmail to retry non-resumable failed attachment tasks; broader synthetic offline/session-expiry browser tests |
| 4 — Free output | Substantial | JSON v2, NDJSON, CSV, TXT, Markdown, searchable sanitized HTML, basic PDF, individual-PDF ZIP, reconstructed EML ZIP/MBOX with explicit provenance, manifest, checksums, folder templates, splitting, output-size estimate, CSV/path/header-injection protections | Golden fixtures for every full writer; browser-level Unicode/long-path/import-client matrix |
| 5 — Attachment workspace | Partial | File groups/custom extensions/name/size rules, inline/clutter exclusions, explainable open-thread preview, saved-batch list review, fast selected-name include/exclude rules, durable task states, selective interrupted-file retry, source message indexes, metadata duplicate/version candidates, opt-in SHA-256 content hashes and proven duplicate groups for user-selected local files | Thumbnail/content previews and per-instance selection before download; automatic attachment-file hashing requires a separately consented file/destination architecture |
| 6 — Pro packaging | Partial | Searchable offline HTML, safe templates, split JSON, record-only evidence ZIP with entry checksums, merged basic PDF, indexed/checksummed individual-PDF ZIP, SHA-256 manifests, incremental batches, AES-256-GCM passphrase archives and local decryption | Attachment-binary ZIP streaming, advanced styled PDFs, package-level attachment encryption, bounded-memory record writers |
| 7 — Local intelligence | Partial | Opt-in incremental SHA-256 hashing up to 2 GB, exact content-duplicate proof, bounded extraction/search with PDF-stream/DOCX-part/XLSX-sheet/PPTX-slide evidence, embedded ToUnicode maps, inherited/indirect PDF font resources, bounded Flate/ASCIIHex/ASCII85/RunLength chains, safe OOXML parsing, transparent document classification, invoice/PO/contract field suggestions, likely PII detection, approval-gated findings, manifested/checksummed redacted text copies, privacy-safe default reports, bounded opt-in local English OCR for supported images and scanned PDFs with pinned vendored assets and cancellation | PDF object streams/LZW/predictors and unusual CMaps, legacy Office, multilingual/handwriting OCR, richer structured schemas, learned on-device models |
| 8 — Destinations/automation | Not started | Local Downloads only | OAuth/connectors, cloud consent UI, resumable uploads, scheduling/label triggers |
| 9 — Workflow packs | Partial | Editable starter rules for accounting, legal, real estate, HR, travel, insurance, procurement, projects, education, research, and spreadsheets | Pack-specific output templates, warnings, documentation, and golden fixtures |
| 10 — Licensing | Not started | Free limits are local and mailbox-content-free | Billing provider, signed entitlements, offline grace, portal/tax/refund operations |
| 11 — Team/enterprise | Not started | — | Tenant backend, roles/policies, SSO/SCIM, legal/security operations |
| 12 — Gmail API | Not started | Shared schemas are API-compatible in principle | OAuth project, minimal-scope API adapter, EML/MBOX, verification and disclosures |
| 13 — Platforms | Not started | Chromium Manifest V3 baseline | Certification and Outlook/Safari adapters |

## Why later phases are not simulated

Cloud destinations, Gmail API mode, billing, and team controls require real OAuth applications, backend tenancy, secrets, legal policies, and external test accounts. Placeholder buttons would create misleading security claims. Their absence is deliberate until those systems can be implemented and verified end to end.

## Current release target

The current code targets a Free private/public beta covering the reliable local parts of Phases 0–5 plus selected local Phase 6 features. The account-free browser lifecycle gate passes, but the dedicated-mailbox synthetic Gmail matrix in [TESTING.md](TESTING.md) remains required before a store release is described as production-ready.
