# Partially implemented features

Quick tracker for things wired into the app but not 100% yet. Full scope rules live in `AGENTS.md`.

## Background groundwork (no UI yet)

- **Gmail/Outlook OAuth** (`src-tauri/src/oauth.rs`): provider metadata, PKCE URL builder, token exchange/refresh, keyring vault, XOAUTH2 strings. Nothing calls it. Still needed: setup UI, deep-link callback handling, SASL wiring into IMAP/SMTP connect paths.
- **OAuth deep-link callback**: `tauri.conf.json` schemes are `mailto` only. `oauth::redirect_uri` defaults to loopback (`http://127.0.0.1/`) and is parameterized. Do not register `run.rosie.snap://oauth/callback`. No listener routes codes to `oauth::exchange_code` yet. `remove_account` already calls `oauth::remove_tokens`.
- **`auth_method` account column** (schema v5): migrated, defaults `password`. OAuth accounts will set it; `update_account_password` already refuses non-password accounts.

## Registered but unused IPC

Kept on purpose; each has a planned consumer. Remove if still unused after that work lands.

- `get_account_inbox_counts`: planned per-account sidebar badges.
- `update_account_display_name`: planned inline account renaming; the command and `Database::update_account_display_name` exist but no UI calls them yet.
- `sync_all_accounts`: planned single refresh across every account; no UI caller yet.
- `list_all_mailboxes`: planned unified-inbox search (scope decision pending).
- `search_all_cached_messages`: command registration removed from Rust because no mailbox UI used it. The backing `Database::search_all_accounts` API stays parked for the pending unified-inbox decision, and the frontend API entry is removed separately.

## Dead storage (removed in schema v6)

- ~~`attachment_blobs` table~~, ~~`protected_messages` table~~, ~~`drafts.sender_email` column~~: dropped; blob accounting removed from eviction/usage; pagination index added.

## Thin coverage (works, could go further)

- **Send size**: 25 MiB shows a warning but sending stays enabled; providers differ, backend caps at 100 MiB. Deliberate.
- **Setup inputs during testing**: editable while the connection test runs; the backend tests a request snapshot, so edits cannot corrupt the in-flight check.
- **IDLE**: watches INBOX only; other folders refresh on the ~120s full-sync loop.
- **Flag sync**: always FETCHes flags for the cached UID set; no CONDSTORE/MODSEQ yet.
- **Mail rules**: applied only after successful syncs; server-side filter upload, rule reordering, and test-match preview are not implemented.
- **Attachment IDs**: deterministic hash (name + CID + size + index) with legacy fallback. No per-message salt; distinct contents with identical metadata collide.
- **Search ranking**: unweighted bm25 AND-of-prefix; body can drown subject/sender; CJK recall limited. Server body matches append by date.
- **Backfill cutoff**: INTERNALDATE-based, stops after 3 consecutive old messages.
- **Linux arm64**: build scripts exist (`build:linux:arm64`, flatpak arm64) but only x64 ships.
- **Store trains**: MSIX/PKG scripts exist; GitHub-only for now.
- **Vibrancy on Linux**: intentionally opaque; toggle hidden where unsupported.
