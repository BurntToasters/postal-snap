# Partially implemented features

Quick tracker for things wired into the app but not 100% yet. Full scope rules live in `AGENTS.md`.

## Background groundwork (no UI yet)

- **Gmail/Outlook OAuth** (`src-tauri/src/oauth.rs`, `connect_oauth_account`): loopback PKCE, token exchange and refresh, keychain, and XOAUTH2 on IMAP and SMTP. Hidden from setup UI. Not a 0.4.0 ship item; user-facing sign-in can wait until 0.5.0. Before that UI ships, register the app and put client IDs in the build (`docs/OAUTH.md`). Do not register `run.rosie.snap://oauth/callback`.
- **`auth_method` account column** (schema v5): `password` or `oauth`. Password changes stay refused for OAuth accounts. `remove_account` deletes OAuth tokens.

## Registered but unused IPC

Kept on purpose; each has a planned consumer. Remove if still unused after that work lands.

- `list_all_mailboxes`: planned unified-inbox search (scope decision pending).
- `search_all_cached_messages`: command registration removed from Rust because no mailbox UI used it. The backing `Database::search_all_accounts` API stays parked for the pending unified-inbox decision, and the frontend API entry is removed separately.

## Dead storage (removed in schema v6)

- ~~`attachment_blobs` table~~, ~~`protected_messages` table~~, ~~`drafts.sender_email` column~~: dropped; blob accounting removed from eviction/usage; pagination index added.

## Thin coverage (works, could go further)

- **Send size**: 25 MiB shows a warning but sending stays enabled; providers differ, backend caps at 100 MiB. Deliberate.
- **Setup inputs during testing**: editable while the connection test runs; the backend tests a request snapshot, so edits cannot corrupt the in-flight check.
- **IDLE**: watches INBOX only; other folders refresh on the 5-minute sync loop.
- **Flag sync**: CONDSTORE `CHANGEDSINCE` when advertised; QRESYNC `VANISHED` replaces the expunge `UID SEARCH` when the server accepts `ENABLE QRESYNC`. Other servers scan every cached UID. GreenMail does not advertise QRESYNC, so it is covered by Rust tests and the iCloud smoke test only.
- **Mail rules**: applied only after successful syncs. Settings can reorder rules and preview unread Inbox matches. A message can start a sender rule in that form. Server-side filter upload is not implemented.
- **Attachment IDs**: deterministic hash (name + CID + size + index) with legacy fallback. No per-message salt; distinct contents with identical metadata collide.
- **Search ranking**: subject, then sender, then recipients, outweigh the body. Matches are still an AND of prefixes, CJK recall is limited, and server body matches append by date.
- **Backfill cutoff**: INTERNALDATE-based, stops after 3 consecutive old messages.
- **Redirect drafts**: kept as redirects locally and through Undo Send. The server Drafts copy has no body, and a draft imported back from the server opens as an ordinary message.
- **Block domain**: hidden for the account's own domains and a fixed list of shared providers (`SHARED_MAIL_DOMAINS` in `src/blockedSenders.ts`). Other large shared domains are not detected.
- **Remembered open message**: returning to a folder reopens the last read message only. A message left unread stays closed so it is not marked read.
- **Message list pointer shortcuts**: the star, read, and day-select buttons are mouse shortcuts hidden from assistive tech. Row names carry the state, and `s`, `u`, select mode, and the context menu do the same work. Not yet checked with VoiceOver.
- **Linux arm64**: build scripts exist (`build:linux:arm64`, flatpak arm64) but only x64 ships.
- **Store trains**: MSIX/PKG scripts exist; GitHub-only for now.
- **Vibrancy on Linux**: intentionally opaque; toggle hidden where unsupported.
