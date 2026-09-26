# Postal Snap 0.2 release checklist

Record the build commit, tester, date, operating-system version, and result for every manual item. A GitHub 0.2.x release is blocked by any unchecked **required** item. Store items are listed separately and are not a GitHub-train go/no-go.

Mocked frontend, Playwright, and unit tests do not by themselves mean the release is ready.

## Automated gates

- [ ] Clean checkout uses Node.js 24 and Rust 1.97.1.
- [ ] `npm ci` succeeds without lockfile changes.
- [ ] `npm run audit` reports no npm or RustSec vulnerabilities (online; signing host).
- [ ] `npm run workspace:prepare` passes (`SKIP_E2E=1`; Playwright is not required on the signing host).
- [ ] CI on the release commit is green, including merged Vitest + Playwright coverage from `npm run test:cov`.
- [ ] `npm run test:mail-integration` passes against pinned GreenMail 2.1.11 TLS services.
- [ ] A copy of the oldest supported v1 database opens, migrates transactionally, and preserves referenced draft/outbox attachments.
- [ ] Direct feature builds compile. Store (`mas` / `msstore`) compile checks are optional for GitHub-only 0.2.x.
- [ ] Generated npm and Cargo notices are present in every package.
- [ ] `src-tauri/tauri.conf.json` updater pubkey is a real minisign key. `TAURI_UPDATER_PUBLIC_KEY` is not required in `.env`; if it is set, it matches the committed key.

## Mail behavior

Required for GitHub 0.2.x. The live iCloud smoke is a signing-host gate; do not treat it as done because CI passed.

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
- [ ] A second account added from the mailbox tests IMAP and SMTP before saving, and the account switcher and `Ctrl+1` through `Ctrl+9` open the right account.
- [ ] First-run setup applies appearance, spacing, text size, and reading pane choices right away, and an account saved during setup opens the mailbox without a duplicate add.
- [ ] Removing the last account shows account setup with display options; restarting with accounts but a reset setup flag opens the mailbox.

## Safety and accessibility

- [ ] Hostile-message fixtures cannot run scripts, submit forms, frame content, or load remote resources.
- [ ] Remote images never load before consent; private, loopback, link-local, and redirect targets stay blocked.
- [ ] In the signed app on the newest macOS and on Linux, HTML and plain-text message bodies render in the reading pane, loaded images appear, and Print includes the whole body across pages. Clicking an HTML mail link shows the hostname-first confirmation and never blanks the message. Mocked Chromium tests cannot catch native navigation-policy or scriptless-frame behavior.
- [ ] Known advertising and tracking images stay blocked after Load images; fetch failures remain retryable.
- [ ] Reported-threat images stay blocked after Load images and are not labeled Safe or confirmed.
- [ ] `npm run filters:check` matches the committed official EasyList/EasyPrivacy and TweetFeed snapshots. Refresh TweetFeed alone with `npm run tweetfeed:update` when shipping a threat-list bump.
- [ ] External links require activation, show the real hostname, warn on reported-threat matches, and open only through the Rust opener.
- [ ] Passwords, addresses, subjects, bodies, attachment names, and server replies do not appear in logs.
- [ ] Keyboard-only setup, mail reading, composing, settings, and account switching work.
- [ ] Right-click and Shift+F10 menus on messages, folders, links, attachments, and the composer open at the pointer, support arrow keys, typeahead, Escape, and Tab, and return focus to where they opened.
- [ ] Screen-reader labels, visible focus, reduced motion, forced colors, and 200% text pass.
- [ ] Narrow-window drawer and message back navigation work.
- [ ] Native macOS and Windows titlebars drag from empty toolbar/heading space; controls, search and menus never initiate dragging. Double click, resize, fullscreen, minimize/restore and close follow platform behavior.
- [ ] Window controls remain usable through startup, setup, settings, maximized compose, and reader overlays. Check macOS traffic lights and Windows edge/keyboard snapping on native hosts; Chromium IPC tests do not prove native hit testing or Snap Layout flyouts.
- [ ] VoiceOver and Narrator complete setup, read, reply, attachment, and send flows with understandable announcements.

## GitHub packages (required for 0.2.x)

Windows creates the GitHub draft. Mac and Linux wait for that draft and never create a second one. Run `release:linux` on the x64 signing host (required). An arm64 Linux host is optional. Each continue path uploads only that host's artifacts; do not run complete-set verification until the required architectures are present.

- [ ] Windows x64 and arm64 NSIS installers have valid Azure Artifact Signing Authenticode signatures (publisher CN plus the Artifact Signing Public Trust EKU `1.3.6.1.4.1.311.97.1.0`) and updater signatures. Prove `Get-AuthenticodeSignature` on the installed `postal-snap.exe`, not only setup.exe. Pass that path as `POSTAL_SNAP_INSTALLED_EXE` when running `scripts/verify-windows-authenticode.ps1`. On Windows, `npm run release:verify:local` runs the same verifier against the release set. Run `npm run setup:win:artifact-signing` once as Administrator on the VM before `release:win`.
- [ ] A machine upgraded from a 0.1.8 roaming-profile install migrates the database, WAL files, and draft attachments to the local (non-roaming) app data directory and preserves drafts, outbox, and attachments. Keyring entries do not roam with the profile.
- [ ] `npm run validate:macos-entitlements` passes before compilation; the universal macOS app passes `codesign` with Hardened Runtime and Developer ID Application, `lipo -archs` shows x86_64 and arm64, local app-ticket validation, and Gatekeeper; the DMG is notarized, stapled, and `spctl --assess --type install`; and the ZIP contains that same notarized, stapled app.
- [ ] Linux x64 AppImage launches and `register_all` can claim mailto on a direct/AppImage host; Flatpak bundle passes sandbox smoke tests. Run `npm run preflight:linux` on the signing host (Ubuntu 24.04.4, glibc at or below 2.39, `pkg-config webkit2gtk-4.1` at or above 2.52.6) and confirm the host-linked ELF starts inside bwrap. arm64 Linux is optional until a signing host ships it.
- [ ] AppImage smoke on a clean host without FUSE 2: install `libfuse2`/`libfuse2t64` or run with `APPIMAGE_EXTRACT_AND_RUN=1`, and record which path worked. Also record host GStreamer availability for received-mail audio/video.
- [ ] Flatpak portal smoke tests, one per flow: attachment save through the FileChooser portal, external http(s) link through the OpenURI portal, credential store/retrieval through `org.freedesktop.secrets` (gnome-keyring and KWallet), notification through `org.freedesktop.Notifications`, `mailto:` handling from the installed desktop entry, and native Wayland fractional scaling/HiDPI, clipboard, and IME (ibus/fcitx5) with CJK fallback rendering.
- [ ] `npm run flatpak:bundle` runs `flatpak-builder-lint --exceptions manifest` and `appstreamcli validate` with no errors, and `org.flatpak.Builder` is installed via `npm run setup:flatpak`.
- [ ] `mailto:` opens a prefilled Postal Snap composer on every platform. AppImage registration is runtime-only and needs host `xdg-utils`/`desktop-file-utils`; do not register inside Flatpak.
- [ ] A machine without WebView2 gets a usable first-run installer; the embedded bootstrapper still downloads the Evergreen WebView2 runtime from Microsoft, so network access to `go.microsoft.com` is required. Do not ship `webviewInstallMode: skip`. Test `offlineInstaller` before claiming offline installs.
- [ ] Download the Windows installer in a browser on a clean VM with SmartScreen enabled and record the SmartScreen state and any warning the user sees. Artifact Signing provides base reputation only and is not an EV certificate.
- [ ] Direct builds update from the correct signed stable or beta GitHub manifest.
- [ ] Install, upgrade, and uninstall preserve or remove user data exactly as documented.

## Later: store packages (not a GitHub 0.2.x gate)

- [ ] Store builds expose no self-updater and report store-managed updates.
- [ ] Microsoft x64/arm64 MSIX bundle passes Windows App Certification Kit and clean Windows 10/11 VM tests.
- [ ] Mac App Store app contains its provisioning profile, has only intended sandbox entitlements, and validates in App Store Connect.
- [ ] Store metadata, privacy disclosures, support URL, screenshots, and pricing are final.

## Publish

- [ ] The release commit is tagged with a signed annotated tag (`git tag -s`) and `git tag -v` verifies the signer before publishing.
- [ ] Release session tag and remote tag resolve to the audited commit.
- [ ] `GPG_KEY_ID` is the signer's full fingerprint; local and draft GPG verification compares it against `VALIDSIG` and rejects any other key.
- [ ] Normalized artifacts, SHA-256 files, GPG signatures, updater payloads, and embedded updater signatures all verify.
- [ ] Stable and beta manifest names route to the intended release.
- [ ] After every architecture is uploaded, `npm run release:verify:local` and/or `npm run release:verify-draft` pass on the complete set. `release:finalize:hard` is the publish step; it also verifies the remote draft.
- [ ] The assembled GitHub release remains an unpublished draft until every required GitHub-only manual gate is checked.
- [ ] A recovery copy of signing and updater keys exists outside the build host.
