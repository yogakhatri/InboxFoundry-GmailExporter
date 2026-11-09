# Roadmap

Goal: the most trustworthy way to save a specific subset of your Gmail, with no account or setup. Free and open source. Not a backup tool, a mail client, or a document-analysis tool.

## Before 1.0

1. **Confirm on live Gmail.** Run the compatibility check and the [manual checklist](docs/TESTING.md) with synthetic mail, in English and at least one other language. Fix what it finds.
2. **Try capturing original messages.** Gmail's "Show original" page may allow true EML/MBOX with real headers and attachments, without opening conversations or changing read state. It's undocumented, so it needs testing on a real account before anything depends on it.
3. **Publish** on the Chrome Web Store and Edge Add-ons once 1 is done.

## Later, if people ask

- Translated interface.
- Saving directly to a chosen folder with the File System Access API.
- Attachments inside the ZIP.
- More export formats, such as Markdown.

Ideas and reports are welcome as GitHub issues.
