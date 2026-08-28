# Postal Snap 0.1 release checklist

Record the build commit, tester, date, operating-system version, and result for every manual item. A GitHub 0.1.0 release is blocked by any unchecked **required** item. Store items are listed separately and are not a 0.1.0 go/no-go.

Mocked frontend, Playwright, and unit tests do not by themselves mean the release is ready.

## Automated gates

- [ ] Clean checkout uses Node.js 24 and Rust 1.97.1.
- [ ] `npm ci` succeeds without lockfile changes.
- [ ] `npm run audit` reports no npm or RustSec vulnerabilities (online; signing host).
- [ ] `npm run workspace:prepare` passes (`SKIP_E2E=1`; Playwright is not required on the signing host).
- [ ] CI on the release commit is green, including `npm run test:e2e`.
- [ ] `npm run test:mail-integration` passes against pinned GreenMail 2.1.11 TLS services.
- [ ] A copy of the oldest supported v1 database opens, migrates transactionally, and preserves referenced draft/outbox attachments.
- [ ] Direct feature builds compile. Store (`mas` / `msstore`) compile checks are optional for GitHub-only 0.1.0.
- [ ] Generated npm and Cargo notices are present in every package.
- [ ] `src-tauri/tauri.conf.json` updater pubkey is a real minisign key. `TAURI_UPDATER_PUBLIC_KEY` is not required in `.env`; if it is set, it matches the committed key.

## Mail behavior

Required for GitHub 0.1.0. The live iCloud smoke is a signing-host gate; do not treat it as done because CI passed.

- [ ] `npm run test:icloud` passes on a signing host with a dedicated iCloud account and app-specific password.
- [ ] IMAP local-part fallback and full-address fallback both have coverage.
- [ ] Inbox, Sent, Drafts, Archive, Trash, Junk, and custom folders map correctly.
- [ ] Read, unread, star, move, archive, trash, junk, reply, reply-all, and forward round-trip.
- [ ] HTML and plain-text compose, inline images, and attachments arrive correctly.
- [ ] Local and server-created drafts round-trip; a simultaneous edit preserves both versions and labels the recovered copy.
- [ ] Sent-folder deduplication finds the stable Message-ID; a failed Sent copy retries without another SMTP submission.
- [ ] Cached Inbox opens after an offline restart.
- [ ] Offline changes replay after reconnect.
- [ ] An uncertain SMTP result stays in Needs attention and is never automatically resent.
- [ ] Current-folder and all-folder searches return subject and body matches.
- [ ] Two accounts remain isolated through sync, drafts, outbox, and removal.

## Safety and accessibility

- [ ] Hostile-message fixtures cannot run scripts, submit forms, frame content, or load remote resources.
- [ ] Remote images never load before consent; private, loopback, link-local, and redirect targets stay blocked.
- [ ] External links require activation and open in the system browser.
- [ ] Passwords, addresses, subjects, bodies, attachment names, and server replies do not appear in logs.
- [ ] Keyboard-only setup, mail reading, composing, settings, and account switching work.
- [ ] Screen-reader labels, visible focus, reduced motion, forced colors, and 200% text pass.
- [ ] Narrow-window drawer and message back navigation work.
- [ ] VoiceOver and Narrator complete setup, read, reply, attachment, and send flows with understandable announcements.

## GitHub packages (required for 0.1.0)

Windows creates the GitHub draft. Mac and Linux wait for that draft and never create a second one. Each continue path uploads only that host's artifacts; do not run complete-set verification until every architecture is present.

- [ ] Windows x64 and arm64 NSIS installers have valid Authenticode and updater signatures.
- [ ] Universal macOS DMG/ZIP passes `codesign`, Gatekeeper, notarization, and staple validation.
- [ ] Linux x64 and arm64 AppImages launch; Flatpak bundles pass sandbox smoke tests.
- [ ] `mailto:` opens a prefilled Postal Snap composer on every platform.
- [ ] Direct builds update from the correct signed stable or beta GitHub manifest.
- [ ] Install, upgrade, and uninstall preserve or remove user data exactly as documented.

## Later: store packages (not a GitHub 0.1.0 gate)

- [ ] Store builds expose no self-updater and report store-managed updates.
- [ ] Microsoft x64/arm64 MSIX bundle passes Windows App Certification Kit and clean Windows 10/11 VM tests.
- [ ] Mac App Store app contains its provisioning profile, has only intended sandbox entitlements, and validates in App Store Connect.
- [ ] Store metadata, privacy disclosures, support URL, screenshots, and pricing are final.

## Publish

- [ ] Release session tag and remote tag resolve to the audited commit.
- [ ] Normalized artifacts, SHA-256 files, GPG signatures, updater payloads, and embedded updater signatures all verify.
- [ ] Stable and beta manifest names route to the intended release.
- [ ] After every architecture is uploaded, `npm run release:verify:local` and/or `npm run release:verify-draft` pass on the complete set. `release:finalize:hard` is the publish step; it also verifies the remote draft.
- [ ] The assembled `v0.1.0` GitHub release remains an unpublished draft until every required GitHub-only manual gate is checked.
- [ ] A recovery copy of signing and updater keys exists outside the build host.
