# Partially implemented features

Quick tracker for things wired into the app but not 100% yet. Full scope rules live in `AGENTS.md`.

## Background groundwork (no UI yet)

- **Gmail/Outlook OAuth** (`src-tauri/src/oauth.rs`, `connect_oauth_account`): loopback PKCE, token exchange and refresh, keychain, and XOAUTH2 on IMAP and SMTP. Hidden from setup UI. New sign-in is refused unless the `oauth` Cargo feature is enabled; token refresh remains available for existing accounts. User-facing sign-in is deferred to 0.6.0. Before that UI ships, register the app and put client IDs in the build (`docs/OAUTH.md`). Do not register `run.rosie.snap://oauth/callback`.
- **`auth_method` account column** (schema v5): `password` or `oauth`. Password changes stay refused for OAuth accounts. `remove_account` deletes OAuth tokens.

## Registered but unused IPC

Kept on purpose; each has a planned consumer. Remove if still unused after that work lands.

- `list_all_mailboxes` is used by Settings for folder assignments.
- `search_all_cached_messages`: command registration removed from Rust because no mailbox UI used it. The backing `Database::search_all_accounts` API stays parked for the pending unified-inbox decision, and the frontend API entry is removed separately.

## Dead storage (removed in schema v6)

- ~~`attachment_blobs` table~~, ~~`protected_messages` table~~, ~~`drafts.sender_email` column~~: dropped; blob accounting removed from eviction/usage; pagination index added.

## Thin coverage (works, could go further)

- **Automatic remote images**: parked until trustworthy sender authentication exists. Images require an explicit per-message click; old remembered-sender settings are retained but ignored.
- **Send size**: 25 MiB shows a warning but sending stays enabled; providers differ, backend caps at 100 MiB. Deliberate.
- **Setup inputs during testing**: editable while the connection test runs; the backend tests a request snapshot, so edits cannot corrupt the in-flight check.
- **IDLE**: watches INBOX only; other folders refresh on the 5-minute sync loop.
- **Flag sync**: CONDSTORE `CHANGEDSINCE` when advertised; QRESYNC `VANISHED` replaces the expunge `UID SEARCH` when the server accepts `ENABLE QRESYNC`. Other servers scan every cached UID. GreenMail does not advertise QRESYNC, so it is covered by Rust tests and the iCloud smoke test only.
- **Mail rules**: applied after successful syncs, including rows retained from a failed pass. Settings can reorder rules and preview unread Inbox matches. A message can start a sender rule in that form. Server-side filter upload is not implemented.
- **Attachment IDs**: deterministic hash (name + CID + size + index) with legacy fallback. No per-message salt; distinct contents with identical metadata collide.
- **Search ranking**: subject, then sender, then recipients, outweigh the body. Matches are still an AND of prefixes, CJK recall is limited, and server body matches append by date.
- **Backfill cutoff**: INTERNALDATE-based, stops after 3 consecutive old messages.
- **Redirect drafts**: kept as redirects locally and through Undo Send. The server Drafts copy has no body, and a draft imported back from the server opens as an ordinary message.
- **Block domain**: hidden for the account's own domains and a fixed list of shared providers (`SHARED_MAIL_DOMAINS` in `src/blockedSenders.ts`). Other large shared domains are not detected.
- **Remembered open message**: returning to a folder reopens the last read message only. A message left unread stays closed so it is not marked read.
- **Message list pointer shortcuts**: the hover cluster provides Star, Read or Unread, Archive, and Trash shortcuts hidden from assistive tech. The cluster stays hidden on touch. Row names carry the state; `s`, `u`, `e`, `Delete`, select mode, and the context menu provide keyboard equivalents. The day-select button is also hidden from assistive tech. Not yet checked with VoiceOver.
- **Linux arm64**: build scripts exist (`build:linux:arm64`, flatpak arm64) but only x64 ships.
- **Store trains**: MSIX/PKG scripts exist; GitHub-only for now.
- **Vibrancy on Linux**: intentionally opaque; toggle hidden where unsupported.

## Open at 0.5.2

- **Colored flags need server keywords**: a server that does not allow `$MailFlagBit0/1/2` keeps a plain `\Flagged` flag. The color is not stored there and does not sync to Apple Mail.
- **Junk training needs server keywords**: `$Junk` and `$NotJunk` are written only when PERMANENTFLAGS allows them. Otherwise moves into or out of Junk do not train the server filter.
- **`.eml` viewer never loads remote images**: opened files have no consent path for remote content. This is intentional for 0.5.2.
- **Attachment and message drag-out deferred to 0.5.3**: `start_attachment_drag` and `start_message_drag` are registered stubs that return "Not available yet." Linux has no planned drag-out.
- **Store manifests lack the `.eml` association**: the direct config declares it in `src-tauri/tauri.conf.json` (`fileAssociations`). The MSIX manifest from `scripts/msstore-pack.js` and the Flatpak desktop entry (`packaging/flatpak/run.rosie.snap.desktop`) do not yet declare `message/rfc822`.
- **Traffic-light position is unverified visually**: `MAC_TRAFFIC_LIGHTS` (18, 22) in `src-tauri/src/main.rs` must be checked on macOS in all three densities.
- **PDF preview is partial**: only the first 20 pages render, each at most 1600 px wide. Encrypted or malformed files show an unavailable state.
- **`starred` i18n keys**: the copy in `src/i18n/mail.ts` already says "Flagged". The object keys `starred` and `noStarred` stay for compatibility; rename them only with their call sites.
- **`npm run audit:cargo` decision (0.5.2)**: passes with no new acknowledged IDs. Patched rather than acknowledged:
  - `pin-utils` RUSTSEC-2026-0441 (via `async-imap`): removed from the vendored `async-imap`. Its `unsafe_pinned!` macro is a local copy in `src-tauri/vendor/async-imap/src/lib.rs`.
  - `async-executor` 1.14.0 yanked (via `zbus`): bumped to 1.14.1, published 2026-11-02 and eligible 2026-11-05, through `scripts/cargo-safe-update.mjs`.
  - The five existing acknowledged IDs (`RUSTSEC-2024-0370`, `-2024-0429`, `-2026-0370`, `-0371`, `-0372`) are still reported. Their reasons remain in `scripts/audit-cargo.js`.
- **npm moderate advisories (dev-only, 14 findings)**: all trace to `minimatch` below 11.0.1 (10.2.6 via `eslint`, `typescript-estree`, `@eslint/config-array`, `test-exclude`; 9.0.9 via `read-package-json`) and `glob` 9.0.0 through 14.0.1 (10.5.0 via `read-package-json`; 13.0.6 via `test-exclude`). `typescript-eslint` 8.72.1 is the latest age-eligible release and does not clear them. Clearing them needs `overrides` in `package.json` (`minimatch` 11.0.1 or later; `glob` 14.0.2 or later with `test-exclude` on a compatible major). Production audit is clean, and `audit:npm` gates on high severity. Left for a dependency decision.
