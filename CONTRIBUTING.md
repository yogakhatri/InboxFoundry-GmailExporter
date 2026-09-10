# Contributing

Thanks for helping improve InboxFoundry.

## Before opening an issue

- Test the latest version from the default branch.
- Reproduce the problem with a narrow Gmail search and synthetic or non-sensitive email.
- Check whether Gmail's interface language is English.
- Never attach a real export, email body, message ID, authentication token, or personal Gmail URL to a public issue.

A useful bug report includes the extension version, Chrome version, operating system, Gmail language, exact action, expected result, actual result, and sanitized console error. Explain whether conversation view is enabled and whether attachments were selected.

## Development setup

1. Fork and clone the repository.
2. Run `npm test` with a current Node.js release.
3. Load the repository folder from `chrome://extensions` using **Load unpacked**.
4. After each source change, select **Reload** on the extension card and reload the Gmail test tab.

There is no compile or bundle step. Keep the extension dependency-free unless a dependency has a clear, reviewed benefit. OCR/PDF runtime files are deliberately vendored so extension pages never load executable code or recognition models from a network. When updating one, record its exact package version, license, npm integrity, and SHA-256 runtime hashes in `vendor/ASSET_MANIFEST.json`; update `vendor/THIRD_PARTY_NOTICES.md`; run the unit, validation, and real browser gates; and never replace an asset with an unreviewed download.

## Manual test checklist

Use a test account and synthetic messages. Run the applicable cases in [docs/TESTING.md](docs/TESTING.md), including every changed scope, rule, output, Stop/resume phase, download outcome, and migration path. Record what was actually tested; do not write “all tests passed” when Gmail/browser cases were not run.

## Pull requests

Keep changes focused. Explain the user-facing behavior, privacy or permission impact, testing performed, and any Gmail selectors added or changed. Update README, export specification, privacy statement, and changelog when applicable.

By contributing, you agree that your contribution is licensed under the MIT License.

Participation is also governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
