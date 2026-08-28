# Postal Snap agent guide

## Product

Postal Snap is a proprietary, paid-capable desktop email client for seniors and anyone wanting a calm, minimal interface. Package name: `postal-snap`. Application identifier: `run.rosie.snap`.

The v0.1 scope is deliberately focused:

- Guided iCloud Mail setup using an app-specific password.
- Secure manual IMAP/SMTP setup.
- Multiple isolated accounts; no unified inbox.
- Familiar folders, message list, reader, search, drafts, outbox, attachments, and rich compose.
- No telemetry, analytics, licensing server, trial logic, or Postal Snap cloud.
- English-US first, with UI strings kept central for later localization.

Do not add Gmail/Outlook OAuth presets, POP, plaintext transport, threading, contacts, signatures, rules, templates, scheduled send, calendar, or a cloud backend unless the user expands scope.

## Stack and layout

- Tauri 2 desktop shell.
- React 19 + TypeScript + Vite frontend in `src/`.
- Rust/Tokio backend in `src-tauri/src/`.
- SQLite + FTS5 local storage.
- `async-imap` over verified TLS for IMAP.
- `lettre` for SMTP and MIME submission.
- `mail-parser` for received MIME.
- Tiptap React for rich compose.
- Vitest/Testing Library tests in `src/tests/`.
- Playwright mocked-IPC flows in `e2e/`.
- Packaging and release orchestration lives in `package.json` and `scripts/`.

Important files:

- `src/components/MailShell.tsx`: main mailbox UI.
- `src/components/MessageReader.tsx`: safe received-mail reader.
- `src/components/Composer.tsx`: rich composer and draft behavior.
- `src/components/SetupWizard.tsx`: iCloud/manual account setup.
- `src/styles.css`: responsive accessible design system.
- `src-tauri/src/commands.rs`: typed IPC boundary and account serialization.
- `src-tauri/src/mail.rs`: IMAP, SMTP, MIME, sync, and server search.
- `src-tauri/src/db.rs`: SQLite, FTS, offline queue, drafts, and outbox.
- `src-tauri/src/security.rs`: remote-image SSRF defenses and redaction.
- `src-tauri/src/settings.rs`: validated atomic `settings.json` storage.
- `docs/ARCHITECTURE.md`: architecture overview.
- `docs/RELEASING.md`: release process.
- `docs/RELEASE_CHECKLIST.md`: final manual go/no-go checks.

## Product and UI rules

- Keep the UI minimalist but recognizably an email client.
- Optimize for low cognitive load: large labels, clear hierarchy, plain errors, and obvious primary actions.
- Interactive targets must be at least 44px where practical.
- Preserve keyboard navigation, visible focus, screen-reader names, reduced motion, forced-colors support, and 200% text scaling.
- Preserve right, bottom, and hidden reading-pane modes plus narrow-window mailbox drawer/back navigation.
- System light/dark mode is the default. Postal blue is the restrained accent.
- Avoid icon-only actions unless they have an accessible name and tooltip where useful.
- Keep destructive and uncertain-send states explicit. Never imply delivery when SMTP outcome is uncertain.

## Security invariants

These are release blockers. Do not weaken them for convenience.

- Accept only implicit TLS or required STARTTLS. Reject plaintext, invalid certificates, POP, and OAuth-only manual configurations.
- Credentials cross IPC only during setup, are cleared by the frontend, wrapped/zeroized in Rust, stored only in the native credential vault, and never returned or logged.
- Never log addresses, subjects, bodies, credentials, attachment names, local paths, or raw server responses.
- Received HTML must remain sanitized and displayed in a scriptless, networkless sandboxed iframe.
- Block scripts, forms, frames, active objects, event handlers, unsafe URLs, remote CSS resources, and automatic remote images.
- Remote images load only after consent through the Rust proxy. Revalidate every redirect, pin validated DNS addresses, reject credentials in URLs, and block loopback/private/link-local/reserved destinations.
- Received CID images may be exposed only as bounded data URLs through opaque attachment IDs. Never expose raw paths.
- External HTTP(S) links require deliberate activation and confirmation, then open in the system browser.
- No broad filesystem permissions. Attachments write only to explicit user-selected destinations.
- Preserve strict CSP and separate capabilities: `default.json` is direct distribution; `store.json` excludes updater/process permissions.
- Store builds must not initialize or expose the Tauri updater.
- Do not automatically retry an uncertain SMTP send. Keep it in `needs_attention` for an explicit user retry.
- Preserve message/MIME/recipient/attachment/remote-image size and nesting limits.

## Mail and storage behavior

- One async serialized actor/lock per account. Interrupt IMAP IDLE for operations, then resume.
- Sync by UID and UIDVALIDITY. UIDs are mailbox-scoped; never reuse a moved source UID as the destination UID.
- Database schema changes use transactional `PRAGMA user_version` migrations. Preserve referenced managed attachments when upgrading legacy databases.
- IMAP `STATUS` totals/unread are authoritative; optimistic local count deltas must reset on the next successful status refresh.
- Fetch envelopes first and full message bodies on demand. Background backfill is latest-first.
- Default cache policy is recent mail: 90 days and 1 GiB. Eviction must preserve envelopes, drafts, and unsent mail.
- Queue offline flag/move/delete/draft operations and replay safely after reconnect.
- Search returns cached FTS results first and may fall back to IMAP server search. Server body-only matches must be returned directly, not filtered through local FTS afterward.
- Folder roles prefer IMAP SPECIAL-USE and then conservative provider/name fallbacks.
- iCloud IMAP tries the address local part first, then the full address; SMTP always uses the full address.
- Account setup must test both IMAP and SMTP before saving the account or credential. `add_account` already performs this test; do not double-submit setup from the UI.

## Distribution

- Direct downloads use GitHub Releases only: `BurntToasters/postal-snap`.
- Direct updater endpoint:
  `https://github.com/BurntToasters/postal-snap/releases/latest/download/latest-{{target}}-{{arch}}.json`
- Stable manifests: `latest-<target>-<arch>.json`.
- Beta manifests: `latest-<target>-beta-<arch>.json`.
- Never reintroduce `prod.rosie.run` or S3 updater assumptions.
- Direct Windows: signed x64/arm64 NSIS `.exe` plus signed updater payloads.
- Direct macOS: universal Developer ID signed/notarized DMG and ZIP.
- Linux: x64/arm64 AppImage and Flatpak only; no DEB/RPM.
- First 0.1.0 shipment is GitHub-only. Microsoft Store and Mac App Store packaging scripts exist for a later train; they are not a 0.1.0 ship gate.
- Microsoft Store (later): x64/arm64 MSIX bundle, Store-managed updates, Windows 10 22H2 floor.
- Mac App Store (later): universal sandboxed app and signed installer PKG, Store-managed updates.
- Mac Store and direct Mac builds use separate configuration/entitlements.
- All packages include generated npm and Cargo third-party notices.

The package scripts intentionally mirror the sibling IYERIS workflow conventions. Extend `package.json` scripts instead of creating a second release entry point. Remove/avoid IYERIS-specific vendor or file-manager behavior.

## Commands

Use package scripts as the canonical interface:

```sh
npm run tauri:dev
npm run test:all
npm run test:e2e
npm run test:rust
npm run test:mail-integration
npm run lint
npm run lint:rust
npm run typecheck
npm run format:check
npm run audit
npm run licenses
```

Useful packaging commands include `build:win:*`, `build:mac:universal`, `build:mas`, `build:msstore`, `build:linux:*`, and `flatpak:bundle*`. See `package.json` and `docs/RELEASING.md` before changing release flow.

`npm run audit:cargo` uses an explicit list of acknowledged advisories from the current Tauri GTK3/urlpattern graph. It denies every new RustSec warning. Do not broaden the list; review dependency paths and document the reason for every addition.

The `b` and `r` package scripts intentionally perform destructive branch cleanup. Never run them unless the user explicitly requests that workflow and the exact target is verified.

## Working rules

- Preserve user changes and unrelated dirty-worktree content.
- Prefer small typed IPC commands over plugin permissions or frontend-native access.
- Validate ownership at account/mailbox/message/draft/outbox boundaries.
- Keep errors actionable but redacted.
- Add regression coverage for every security, sync, draft/outbox, and release-tooling fix.
- Run focused tests while editing, then `npm run test:all` before handoff when possible.
- Never use real mailbox credentials in fixtures, logs, commits, screenshots, or issue text.
- Do not claim release readiness from mocked tests alone.

## Release status and manual gates

Automated frontend, Playwright, Rust, lint, clippy, type, config, and production-build gates are established. They do not make a release ready. Final GitHub 0.1.0 approval still requires external systems and real credentials:

- Online npm and RustSec audits.
- Pinned GreenMail 2.1.11 TLS integration run (requires Docker and OpenSSL).
- Dedicated iCloud smoke test via `npm run test:icloud` on a signing host (not CI).
- Signed GitHub builds on every target architecture.
- Authenticode, Gatekeeper, notarization, updater-signature, entitlement, and manifest verification.
- Clean install, update, `mailto:`, offline restart, and uninstall testing.

Windows App Certification Kit, Mac App Store Connect, and store metadata are later store-train gates.

Use `docs/RELEASE_CHECKLIST.md` as the authoritative final checklist. Prefer a signed GitHub release candidate before publishing stable `0.1.0`.
