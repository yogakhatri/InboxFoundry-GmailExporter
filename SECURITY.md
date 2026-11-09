# Security policy

## Supported version

Fixes go to the latest version on the default branch.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Don't open a public issue for an unpatched vulnerability. Provide the affected version or commit, reproduction steps using synthetic data, the impact, and a suggested fix if you have one. Never include real email, tokens, Gmail URLs, attachments, or exports. The maintainer aims to acknowledge complete reports within 7 days and to coordinate disclosure after a fix.

## Security model

- **Mail is untrusted input.** Captured text and HTML are never rendered as markup. The side panel uses text nodes only, and exported HTML escapes everything.
- **Sender content can't trigger actions.** Attachment detection ignores the message body entirely, so links in an email are never clicked or fetched. Direct downloads only use Gmail attachment hosts (`mail.google.com`, `*.googleusercontent.com`) over HTTPS.
- **Least access.** Host access is Gmail only. The Gmail script is injected on demand. The download-filename listener exists only during the rare click-based download, so other downloads are untouched.
- **Separation.** Exports and encryption run in the side panel, so passphrases never enter Gmail's process. The background worker gives the Gmail script a fixed list of operations, none of which delete data.
- **No remote code.** The CSP allows only packaged scripts, with no `eval` or inline code.
- **No regular expressions from users.** They run on Gmail's main thread and can't be timed out, so a bad pattern on a long email could freeze the tab. Rules use contains, exact, and linear-time wildcard matching instead.
- **Output safety.** CSV formulas are neutralized, email headers can't be injected, and file and ZIP paths are sanitized.

## Limits

Anyone with access to the browser profile or unencrypted downloads can read exported mail. Encrypted files are only as strong as their passphrase. Hiding addresses is best effort.
