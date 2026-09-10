# Lean release repository audit

Audited: 2026-08-30  
Source baseline: InboxFoundry 4.5.0  
Required product flow: **Find → Review → Export**

This report classifies the current repository before the lean-release refactor. “Complete” means the implementation exists and has proportionate automated evidence. It does not mean the Chrome Web Store release acceptance criteria have all passed.

## COMPLETE

- **Extension baseline:** Manifest V3, Chrome 114 minimum, a Gmail-only host permission, local storage/download/side-panel permissions, no analytics, and no remote executable code.
- **Local privacy boundary:** mailbox records remain in extension-owned IndexedDB and requested files go through Chrome Downloads. Diagnostics are content-sanitized. Privacy, security, support, contribution, and license documents exist.
- **Durable jobs:** formal job states, item-level IndexedDB records, checkpoints, per-tab ownership leases, safe Stop, partial records, resume, interrupted-job recovery, retained batches, and cleanup are implemented.
- **Download reliability:** direct and click-routed Gmail downloads are tracked durably; routing fails closed; completed/interrupted/erased states refresh from Chrome; selected resumable tasks can be retried.
- **Gmail query builder:** sender, recipient, subject, filename, date, label, category, status, attachment presence, size, and `in:anywhere` criteria compile to Gmail search operators.
- **Local filter engine:** include/exclude terms, ANY/ALL, exact/contains/prefix/suffix/wildcard/guarded regex, subject/body/header/address/domain/date/thread-size rules, attachment presence, thread/message scope, and match evidence are implemented.
- **Attachment rules:** common type groups, custom extensions, filename include/exclude, size bounds, unknown-size policy, inline controls, clutter exclusions, and metadata reasons are implemented.
- **Existing export views:** JSON v2, split JSON, NDJSON, CSV, text, Markdown, sanitized searchable HTML, basic PDF, individual-PDF ZIP, attachment manifest, deterministic evidence ZIP, and encrypted JSON are implemented.
- **Reconstructed portability writers:** EML ZIP and MBOX writers exist with UTF-8 transfer encoding, explicit reconstructed provenance, header-injection protection, safe paths, indexes, and checksums. Unit tests pass; browser acceptance remains incomplete.
- **Advanced local tools:** incremental SHA-256, exact duplicate proof, metadata duplicate/version families, bounded PDF/OOXML/text search, English image/scanned-PDF OCR, classification, structured suggestions, likely-PII detection, and redacted text-copy packages are implemented.
- **Automated baseline:** `npm test` passes 82 tests plus syntax, manifest/resource, CSP, vendored-asset-integrity, privacy, and DOM-reference validation.
- **Synthetic lifecycle browser baseline:** the previous v4.4.0 gate proved filtering, Stop, partial export availability, resume, IndexedDB recovery, side-panel initialization, service-worker restart/reload recovery, and actual bundled PNG/scanned-PDF OCR.

## PARTIAL

- **Gmail adapter:** Gmail-specific selectors and actions are mostly concentrated in `content.js`, but they are interleaved with job orchestration, download logic, record construction, exports, and message dispatch. A layout change still requires editing the 1,200-line content script rather than a dedicated adapter.
- **Simple workflow:** the pieces for Find, dry-run preview, attachment review, and export exist, but they are presented as many numbered configuration sections rather than one guided flow.
- **Review:** open-thread preview and a content-free sample dry run exist. Attachment review exists only for a retained/saved batch. There is no complete pre-download review screen containing every matched email/file with per-instance selection and a final confirmation.
- **Size estimation:** saved JSON size can be estimated and individual attachment sizes are parsed where Gmail exposes them. There is no job-wide estimated attachment-byte counter or enforced approximately 250 MB Free cap.
- **ZIP behavior:** evidence/PDF/redaction ZIPs are deterministic and checksummed. The normal evidence ZIP intentionally does not contain separately downloaded attachment binaries, so “matching attachments in one ZIP” is not yet satisfied.
- **Audit package:** record manifests, attachment indexes, package checksums, download states, duplicate metadata, and failure data exist, but downloaded attachment binaries cannot currently be re-read and embedded automatically. The user-facing name still says “Evidence ZIP” in places rather than “Verified Archive.”
- **Error handling:** many failures are understandable and retryable, but raw exception messages can still reach the side panel. There is no centralized user-facing error mapper with a prescribed action for each recoverable state.
- **Performance:** processing is sequential, checkpointed, paced, cancellable between threads, and bounded by record/download counts. Some derived exports and classic ZIP creation still build complete payloads in memory.
- **Progress:** processed/matched/rejected/message/download counts, rate, elapsed state, and a progress bar exist. Remaining-email count and a clear named “current stage” are not consistently available.
- **Duplicate review:** deterministic metadata and opt-in hash duplicate groups exist, but duplicate status is not part of the required pre-export item-selection screen.
- **Store readiness:** icons, manifest, README, privacy/security documents, deterministic packaging, and test documentation exist. Dedicated store short/full descriptions, screenshot copy, Free/Pro comparison page, and owner checklist are missing.

## BROKEN OR RELEASE-BLOCKING

No automated test currently fails. The following required product behavior is nevertheless contradicted by the current implementation and blocks the lean release:

- **Downloads happen before Review:** matching attachment downloads are started while each thread is captured. Pressing Start is currently the only confirmation; users cannot remove individual discovered files before bytes are downloaded.
- **Free limits are wrong:** schema/UI currently expose 250 matched threads and 500 downloads, with no 250 MB cap. The specification requires 50 emails, 100 attachments, and approximately 250 MB, with visible non-silent limit messaging.
- **No Free/Pro enforcement:** every advanced filter, output, reliability control, and local intelligence tool is available directly. There is no centralized feature policy, entitlement state, upgrade explanation, or gated control behavior.
- **No licensing abstraction:** `getLicenseStatus`, activation/deactivation/refresh, configurable upgrade/license URLs, signed/local entitlement storage, and no-backend fallback behavior do not exist.
- **Default UI is not lean:** Gmail scope, advanced email rules, attachments, all outputs, encryption, destination, retained review, OCR/search/redaction, presets, diagnostics, and destructive storage controls are visible in one long workspace.
- **No first-run onboarding:** a one-step privacy acknowledgement exists, but the required maximum-three-screen Find/Review/local-data introduction does not.
- **v4.5.0 is not a verified release:** EML/MBOX changes pass unit tests but have not passed the browser-output gate, and no v4.5.0 production ZIP has been accepted.

## UNUSED, DUPLICATED, OR SHOULD LEAVE THE PRIMARY UI

- `docs/COMMERCIAL_PRODUCT_PLAN.md` and much of `docs/FEATURE_ROADMAP.md` describe cloud, enterprise, automation, Gmail API, and multi-platform work that is explicitly out of scope for this release. Preserve them only as historical material or replace their active-roadmap role with the lean specification.
- The popup’s quick unfiltered export duplicates the side-panel start path and bypasses the intended guided Find → Review → Export experience. The popup should become a compact status/launcher surface.
- NDJSON, plain text, Markdown, split JSON, individual-PDF ZIP, encryption/decryption, local OCR/document search, PII/redaction, internal-ID/raw-HTML switches, pacing, incremental jobs, complex match modes, folder templates, and preset administration are working capabilities that should move behind **Advanced Filters** or **Advanced Tools**, not be deleted.
- `state.options.keywords` is retained legacy state with no current matching behavior. The old `state.options` bridge is still needed for migration and popup compatibility, so removal must wait until those paths are refactored and regression-tested.
- Small `sanitizeFolderName`/`sanitizeFileName` wrappers in `content.js` and `sanitizePart` in `background.js` delegate to the shared path-safety module and are not independent implementations. They may be renamed/centralized during adapter work but should not be removed merely for line-count reduction.
- CSV and attachment-manifest formatting currently live in `content.js` while the other writers live in `lib/export-engine.js`. This is genuine export-logic fragmentation and should be centralized without changing output semantics.

## MISSING

- A dedicated Gmail DOM adapter/service with centralized selectors and methods for list discovery, opening/expanding/extracting a thread, discovering/downloading attachments, pagination, and return navigation.
- A three-action Home screen: **Download Attachments**, **Export Emails**, and **Custom Search**.
- A maximum-three-screen onboarding flow with no registration.
- A durable two-stage collection model that first records candidate emails/files, then accepts per-item selections, then downloads/exports only approved items.
- A complete Review screen with counts, estimated bytes, type breakdown, source/sender/date, selected state, exclusion reason, duplicate status, Select all, per-item removal, and source-message navigation.
- Centralized `FREE`/`PRO` feature definitions and an entitlement service used by configuration normalization and UI capabilities.
- Free-limit enforcement at 50 emails / 100 attachments / approximately 250 MB, with explicit “selected of total” messaging and no silent truncation.
- Provider-independent licensing configuration and service with safe Free behavior when no backend is configured.
- Browser tests for every core output, especially reconstructed EML/MBOX and ZIP entry/checksum inspection.
- Import-client compatibility fixtures for EML/MBOX and browser-level Unicode/long-filename coverage.
- Dedicated store listing copy, screenshot plan, permission explanations, Free/Pro table, release-owner actions, and final acceptance checklist.

## Refactor constraints

- Preserve current job, filter, download-policy, export, parser, and privacy behavior unless a lean-release requirement explicitly changes it.
- Hide advanced tools before considering deletion.
- Do not add Gmail API/OAuth, cloud destinations, remote OCR/AI, automation, other mail providers, teams, or enterprise administration.
- Reliability has priority over any new feature.
