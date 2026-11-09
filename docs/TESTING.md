# Testing

Use synthetic messages only. Never attach real email to an issue.

## Automated

```bash
npm test          # unit tests and static validation
npm run lint      # unused code and undefined names
npm run test:e2e  # real extension, real browser, Gmail-shaped page
```

`npm run test:e2e [name-filter]` loads the extension into a temporary profile and maps `mail.google.com` to a loopback page, so real Gmail is never contacted. It clicks the real side-panel buttons and checks the real files on disk. It needs OpenSSL and a Chromium-family browser. Set `INBOXFOUNDRY_CHROME` if auto-detection fails. Branded Chrome 137+ can't be used because it no longer accepts `--load-extension`. One small shim points the panel's "active tab" lookup at the Gmail tab, because the test opens the panel as a separate page.

## What the automated tests can't prove

`tests/e2e/fixture.mjs` is written from knowledge of Gmail's markup. **It is not Gmail.** Passing means the logic is sound against that shape, not that every selector matches the live page today. These need the checklist below:

- Selectors: row IDs, message blocks, attachment cards, pagination range.
- Whether the Older button and rows respond to synthetic mouse events.
- Collapsed-message and trimmed-content controls.
- Chrome's real one-a-minute timer throttling. `INBOXFOUNDRY_SLOW=1 npm run test:e2e -- "six minutes"` keeps a tab hidden for over seven minutes, but the page's timers weren't throttled in headless Chromium, so that behaviour needs a normal window.
- Popup blocking, the "Ask where to save" setting, and dangerous-file prompts.

## Manual checklist on live Gmail

Use a dedicated account with synthetic mail. Record browser version, Gmail language, date, and pass or fail. Don't write "all passed" for cases you didn't run.

**Start here.** Run **Check Gmail compatibility** on a list and on an open conversation with attachments. Expect `rowsWithGmailId` to equal `rowsVisible`, `olderControl` to be `label` or `position`, `messagesNotExpanded` to be 0, `datesUnknown` to be 0, and attachments to have direct URLs.

- [ ] Search by sender, date, and file type; the Gmail search shown is the one that runs.
- [ ] More than one page of results: every conversation captured, once, with no freeze.
- [ ] Rows in the panel match what's in Gmail, with the same subject and dates.
- [ ] Long conversation with collapsed messages and trimmed content: all messages captured.
- [ ] Newsletter with "Download" links and an app-store badge: nothing opens, nothing listed as a file.
- [ ] Attachments: PDF, same name twice, Drive link, large file. The right files land in the right folders, and sizes look right.
- [ ] Inbox, All Mail, a label, a search, Spam, Trash; reading pane on and off; conversation view off.
- [ ] Gmail in a non-English language: pagination, dates, and sizes.
- [ ] Tab hidden for over five minutes while scanning.
- [ ] Stop, Resume, reload Gmail mid-scan, close the tab mid-scan, restart the browser.
- [ ] Repeat export skips saved mail and picks up a new reply.
- [ ] Open EML/MBOX in a mail program; print the HTML to PDF with non-English text.

## Before publishing

Don't publish if any conversation can be silently lost or duplicated, Stop corrupts a job, diagnostics expose mail content, a permission has no shipped purpose, captured HTML can execute in an extension page, or the live-Gmail checklist hasn't been run.
