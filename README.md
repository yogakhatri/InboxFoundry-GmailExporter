# InboxFoundry

![InboxFoundry icon](assets/icon128.png)

Find exactly the Gmail conversations and attachments you need and save them to your computer. No account, no server, no setup.

> Independent open-source software, not affiliated with or endorsed by Google. Gmail is a trademark of Google LLC.
>
> **Status: 0.1.0 pre-release.** It's tested thoroughly against a Gmail-shaped test page, but not yet confirmed against live Gmail. Please run [the compatibility check](#check-gmail-compatibility) and report what you see.

## What it does

1. **Search.** Choose attachments, emails, or both. Fill in sender, dates, words, or file type, and InboxFoundry runs that search in your open Gmail tab.
2. **Review.** It opens each result and lists the conversations and files it found. Nothing downloads yet. Untick anything you don't want.
3. **Save.** Attachments go into tidy folders, and emails into the formats you pick:

```text
Downloads/InboxFoundry/Batch 001 2026-08-29/
├── archive.zip
└── 00001 - Invoice for August/
    └── Message-001/invoice.pdf
```

| Format | Good for |
| --- | --- |
| Complete archive ZIP | One file with JSON, a spreadsheet, a readable page, a file list, and checksums |
| Readable page (HTML) | Reading and searching, or printing to save as PDF in any language |
| Spreadsheet (CSV) | One row per message |
| Data (JSON) | The most complete record, for scripts and analysis |
| MBOX, or EML in a ZIP | Opening in a mail program. These are rebuilt from the page, so read [the limits](#known-limits) |
| List of files (CSV) | What was found, what was saved, and what wasn't |

Tick **Encrypt** to write a single passphrase-protected file instead, with no plain copy of the exports.

**Is this the right tool?** InboxFoundry is for a *specific subset* of your mail. For a whole-mailbox backup, use [Google Takeout](https://takeout.google.com) or [Got Your Back](https://github.com/GAM-team/got-your-back).

## Install from source

Requires Chrome, Edge, Brave, or another Chromium browser, version 116 or newer.

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open Gmail and click the InboxFoundry toolbar icon to open the side panel.

## Good to know

- **Opening a conversation marks it as read.** InboxFoundry reads mail by opening it in the page, so this can't be avoided. It tells you how many were unread, and marks them in the review list. Narrow your search to open fewer conversations.
- **Keep the Gmail tab open.** It's safest to leave the tab visible. A background tab keeps working but may be slower.
- **Stop is safe.** Stop finishes the current conversation. Everything captured is kept, can be saved, and can be resumed. Reloading Gmail, closing the tab, and restarting the browser don't lose completed work either.
- **It never hides a gap.** If a conversation can't be read, a limit is reached, or the last page can't be confirmed, the batch is marked **partial** on screen and in every export, with the reason.
- **Repeat exports.** Turn on "Skip mail already saved" to export only what's new from the same search. Conversations with new replies are picked up again.
- **Your data.** Captured mail stays in this browser until you delete the batch. Nothing is deleted automatically. See [PRIVACY.md](PRIVACY.md).

## Check Gmail compatibility

Gmail changes its page without notice, and this extension depends on it. Under **Batches, data and help**, press **Run check** once on a Gmail list and once with a conversation open. It's read-only and reports only counts, never mail content, so you can safely paste the result into an issue.

## Known limits

- Reads the Gmail web page. A Gmail redesign can break it until the selectors in [`lib/gmail-adapter.js`](lib/gmail-adapter.js) are updated.
- EML and MBOX files are rebuilt from the page, not Google's original messages. They have no original transport headers, To and Cc are merged, and attachments stay in their folders rather than inside each message.
- Checksums detect accidental corruption. They aren't proof of authenticity, and these exports aren't forensic evidence.
- Google Drive links and files Gmail offers no download for are listed but not downloaded. Images embedded inside a message body aren't saved as files.
- Encryption covers the export files only. Downloaded attachments aren't encrypted, and captured mail stays readable in the browser until you delete the batch.
- The interface is in English. It's built to work with Gmail in other languages, but hasn't yet been confirmed on live Gmail in any language.

## Troubleshooting

- **"Open Gmail in this window":** make the Gmail tab active in the same window as the panel.
- **Files fail with a click-related message:** allow multiple downloads for `mail.google.com`, or check `chrome://downloads`.
- **"Ask where to save each file" is on in Chrome:** a few files may show a save dialog. Turning that setting off avoids it.
- **Something looks wrong:** run the compatibility check, press **Copy diagnostics**, and open an issue. Neither contains mail content. Never post real email.

## Development

```bash
npm install
npm test
npm run lint
npm run test:e2e
npm run package
```

There's no build step. `npm run test:e2e` needs Chromium and OpenSSL, because branded Chrome 137+ can't load unpacked extensions from the command line. See [docs/TESTING.md](docs/TESTING.md), [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md), [ROADMAP.md](ROADMAP.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

Much of this code was written with AI assistance and is checked by the automated tests described above. Independent human review is welcome, especially of anything that handles mail.

## License

MIT. See [LICENSE](LICENSE). Report vulnerabilities through [SECURITY.md](SECURITY.md).
