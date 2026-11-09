# Privacy

Last updated: November 9, 2026

InboxFoundry works entirely in your browser. It has no server, account, analytics, advertising, or telemetry, and contains no remote code.

## What it reads

Only after you start a search, it reads what Gmail shows in the active tab: subjects, senders, recipients, dates, message text and HTML, attachment names and sizes, and attachment download links. Until you use the side panel, no InboxFoundry code runs in Gmail.

## What it changes in Gmail

It opens conversations the way you would, so **Gmail marks them as read**. It records how many were unread when opened and shows you. It doesn't send, delete, archive, or label anything.

## Where data goes

- Captured mail is stored in this browser's extension storage (IndexedDB) so you can review, resume, and save it.
- Files you save go to your Downloads folder under `InboxFoundry`.
- A list of what you've already exported, holding Gmail thread and message IDs but no content, is kept so repeat exports can skip it. Clear it with **Forget what was already saved**.
- Your search form and saved searches are stored locally and may contain addresses or terms you typed.

The extension sends mail data nowhere. Attachment downloads are requests to Google using your existing Gmail session. Chrome may apply its own services, such as download safety checks, according to your browser settings.

## Keeping and deleting

Nothing is deleted automatically. Captured mail stays until you delete the batch, delete all batches, remove the extension, or clear its storage. Deleting a batch doesn't touch files already saved to disk.

## Encryption and hiding addresses

- **Encrypt** writes one passphrase-protected file (AES-256-GCM, PBKDF2 with 600,000 iterations) and no plain export copy. The passphrase is never stored. Attachments aren't encrypted, and captured mail stays readable in the browser until you delete the batch.
- **Hide email addresses** replaces addresses in saved records, including bodies and HTML, on a best-effort basis. Names written out in text aren't detected. Check before sharing.

## Permissions

| Permission | Why |
| --- | --- |
| `https://mail.google.com/*` | Read the Gmail page you search, only in the tab you use |
| `scripting` | Load the reading code into Gmail only when you start something |
| `downloads` | Save attachments and exports into folders and track their progress |
| `storage`, `unlimitedStorage` | Keep settings and captured mail locally, however large the batch |
| `sidePanel` | Show the interface beside Gmail |

## Your responsibility

Exported mail can contain personal or confidential information, including other people's. You are responsible for having the right to export it and for storing and sharing it safely.

This statement covers the unmodified source in this repository. Review changes before installing a fork.
