# Contributing

Thanks for helping improve InboxFoundry.

## The rule that matters most

Never attach real email, exports, addresses, Gmail URLs, IDs, or tokens to anything public. Use synthetic data and the compatibility check, which contains counts only.

## Most useful contribution: Gmail compatibility

Gmail changes its page without notice. If something stops working:

1. Run **Check Gmail compatibility** on a list and on an open conversation.
2. Open a "Gmail page changed" issue with the output, your browser version, and Gmail's language.
3. To fix it, update the table at the top of `lib/gmail-adapter.js`, the only place Gmail selectors live, and add the new shape to `tests/e2e/fixture.mjs`.

## Setup

```bash
npm install
npm test
npm run lint
npm run test:e2e
```

Load the folder at `chrome://extensions` with **Load unpacked**. After a change, press **Reload** on the extension card, then reopen the side panel. There is no build step, and no runtime dependencies: keep it that way unless the benefit is clear and reviewed.

## Where things live

| Path | Purpose |
| --- | --- |
| `sidepanel.*` | The only interface. Reads storage directly |
| `content.js` | Scan and download engine, injected into Gmail on demand |
| `background.js` | Storage access for `content.js`, and Chrome downloads |
| `lib/gmail-adapter.js` | Everything that knows about Gmail's page |
| `lib/gmail-date.js` | Reading Gmail's dates in any language |
| `lib/filter-engine.js` | Rules that decide what matches |
| `lib/export-engine.js`, `lib/exporter.js` | File formats, ZIP, encryption, export orchestration |
| `lib/job-store.js`, `lib/job-machine.js` | Durable storage and job lifecycle |

## Principles

- **No silent loss.** If mail can't be captured, say so on screen and in the exports.
- **Stay focused.** This finds and saves Gmail mail. Other features belong in other projects.
- **Prove it through the UI.** A bug fix gets a test that fails without it, in `tests/e2e/run.mjs` when it involves Gmail or the panel.

## Pull requests

Keep changes focused. Describe the user-facing behavior, privacy or permission impact, and what you tested, including whether you ran it on live Gmail. Update docs and the changelog where relevant. By contributing, you license your work under the MIT License. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
