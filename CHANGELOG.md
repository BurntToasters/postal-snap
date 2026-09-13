# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                                                                                                      | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS                           | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.10/Postal-Snap-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.10/Postal-Snap-Windows-arm64.exe)                                                                   | **[Universal DMG](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.10/Postal-Snap-macOS.dmg)**                  | **AppImage:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.10/Postal-Snap-Linux-x64.AppImage)                                                                                                                                                     |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/<MS_STORE_ID>?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> -->                                                                                           | **[Universal ZIP](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.10/Postal-Snap-macOS.zip)**                  | **Flatpak:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.10/Postal-Snap-Linux-x64.flatpak)                                                                                                                                                          |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
>

### ℹ️ Enjoying Postal Snap? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Postal Snap is a calm, accessible desktop email client. Mail stays on your computer. There is no Postal Snap cloud, telemetry, or account of mine to log into.

## Changes in `v0.1.10:`

- **FIX - Updates no longer restart while you work:** Signed updates still download in the background, but they no longer install and quit immediately. Use the Update Ready badge or Settings → Restart Postal Snap when you are ready; closing the app on Windows and Linux also installs quietly. If a quiet install fails, the window stays open so drafts are not lost.
- **UI - Licenses and credits:** Settings → About → Licenses and credits opens an in-app window with the bundled MPL text, npm and Cargo notices, and EasyList/TweetFeed license files instead of sending you to GitHub.
- **UI - Current app icon:** Setup, the empty reader, splash, and recovery screens use the current paper-plane logo instead of the old envelope mark.

## Changes in `v0.1.9:`

- **UI - Mail-inspired depth and hierarchy:** Refined setup, Settings, toolbar, message, reader, and form surfaces with calmer layered materials, restrained highlights, clearer selected states, and stronger dark/light contrast.
- **UI - Setup flow:** Reworked account choice and setup presentation, improved 200% text behavior, resets each step to the top, and moves keyboard focus to the new heading without scrolling it away.
- **UI - Settings cleanup:** Removed the duplicate preference-only reset from General. The complete Reset & Restart action remains in Accounts as the single reset path.
- **Accessibility:** Conversation headers participate in roving keyboard navigation, local Drafts/Outbox/Snoozed actions keep Space activation, and focus remains visible through setup transitions.
- **Security:** Account secrets are zeroized earlier, external About/help links use native validation and reported-threat policy, search input work is bounded, and UID-based mail operations fail closed when mailbox identity is unavailable or changes.
- **Reliability:** Added timeouts to Sent-copy and remote-draft IMAP commands, transactional credential rollback when a password update cannot finish, and one in-flight guard per scheduled Outbox message.
- **Compatibility:** Legacy databases containing duplicate email rows no longer fail their schema migration; existing accounts remain available for cleanup while new duplicates stay blocked.
- **Release tooling:** Beta validation now checks the published `latest-<target>-beta-<arch>.json` updater manifests and fails on missing required manifests, all npm/Tauri/Cargo version metadata synchronizes together, and the E2E runner owns Vite directly so Windows quality gates exit cleanly.

## Changes in `v0.1.8:`

- **UI - macOS 27 Mail-inspired shell:** The mailbox sidebar now reaches the window edges, the main toolbar is quieter and consistently grouped, Compose and Get Mail remain explicit at normal desktop widths, and search sits in the trailing toolbar cluster with mailbox/account scoping.
- **UI - Mailbox and reader hierarchy:** Message rows use tighter Mail-like spacing and selection treatment, sidebar symbols use the app accent, Mark All Read moves into the mailbox More menu, and reader actions are grouped into compact pill controls.
- **UI - Liquid Glass restraint:** Glass is reserved for navigation and interactive chrome while message lists, readers, rendered email, composer, Settings, setup, and attachment previews stay opaque for legibility. macOS now requests semantic Sidebar vibrancy instead of HUD material.
- **UI - Composer, setup, and settings polish:** Dialog chrome, grouped controls, selected settings navigation, and setup provider cards use flatter surfaces, quieter borders, and more consistent rounded geometry.
- **FIX - Native appearance sync:** When theme follows the system, native window-effect tint now tracks live light/dark appearance changes instead of staying at the launch appearance.
- **FIX - Responsive mailbox drawer:** The sidebar toggle now follows the same 1049px drawer breakpoint as CSS, stays usable in 761–1049px windows, and clears modal/inert state when resizing back to desktop.
- **FIX - Search scope refresh:** Switching between This mailbox and This account reruns an active search immediately instead of leaving stale results on screen.
- **UI - Narrow-window clarity:** Mailbox/account search scope remains visible in compact windows, and Settings keeps section labels visible while its tab strip scrolls horizontally.
- **FIX - Test and release gates:** Search tests follow the native searchbox role, Playwright no longer fans one mocked-IPC spec across dozens of competing workers, the accessibility scan waits for the actual mail shell, and draft download links target `v0.1.8`.
- **UI - macOS toolbar refinement:** Non-primary toolbar controls drop permanent pill bezels, Settings selection keeps neutral text with an accented symbol, message rows use a single quiet separator, and the search-scope control now keeps a full 44px target.
- **FIX - Bottom reader resize:** Large saved bottom-pane heights are clamped to the available desktop viewport so shrinking a window cannot push the reader past its lower edge.
- **PKG:** Application, Tauri, npm lockfile, and Cargo metadata are synchronized to `0.1.8`.

## Changes in `v0.1.7:`

- **FIX - Composer link safety:** Quoted and inserted web links stay inert in the editor (`href="#"` plus `data-external-href`). Live addresses are restored only when Postal Snap builds the outgoing MIME.
- **FIX - Date-less mail:** Body downloads now request IMAP `INTERNALDATE` and keep a cached stamp instead of jumping Date-less messages to “now.”
- **FIX - Undo send while offline:** Losing IMAP IDLE persists offline and skips the undo-send timer so a never-attempted hold is not marked Needs attention.
- **FIX - Double Send:** Send is guarded with an in-flight lock so a double-click cannot enqueue two Outbox rows.
- **FIX - Bulk move destination:** After Archive/Trash/Junk of many messages, the destination folder refreshes immediately instead of waiting for the next sync.
- **FIX - Thread headers:** `References` keep RFC 5322 order; `In-Reply-To` is only a fallback when `References` is empty.
- **NEW - Empty Junk / Not Junk:** Empty Junk matches Empty Trash. Mail in Junk can return to Inbox with Not Junk.
- **UI - Print headers:** Print includes From, To, Subject, and Date for HTML and plain text. File > Print is wired. ⌘P / Ctrl+P prints the open message even when search is focused.
- **UI - Follow-up compose:** Reply/forward sheets no longer trap Tab, so keyboard users can return to the visible source message.
- **Security:** Unused `deep-link:allow-register` is removed from direct builds. Overlapping Settings saves keep every field, including nested cache policy, and still send `CONFIRM` when turning reported-threat checks off.
- **PKG:** macOS release submits the DMG to notarytool before stapling. Windows re-minisigns updater payloads after Authenticode. `release:verify:local` cryptographically verifies `.sig` files. Beta manifest sync pulls every architecture JSON from the published beta before copying them to latest. CI compile jobs generate third-party notices before `cargo check` on Linux, macOS, and Windows. Signed collection matches the IYERIS/Zinnia Tauri v2 pipeline: Linux updater payload is the AppImage plus `.AppImage.sig` (not `.AppImage.tar.gz`); macOS `codesign --display` reads stderr and requires Developer ID, TeamIdentifier, and Hardened Runtime. Universal `lipo` uses `CFBundleExecutable` (Cargo `postal-snap`), not the spaced product name.

## Changes in `v0.1.6:`

- **NEW - Conversation threads:** Replies group behind one row with a message count; expanding shows the thread newest-first. Threading follows In-Reply-To/References across folders and converges no matter which message syncs first.
- **NEW - Folder management:** Create, rename, and delete personal folders plus empty Trash, all with confirmation for destructive actions.
- **NEW - Bulk triage:** Select mode with checkboxes, mark read/unread, archive/junk/trash many at once, and one-tap mark-all-read. One server round trip per folder; partial failures report counts.
- **NEW - Recipient autocomplete:** To/Cc/Bcc suggest previous recipients from local send history with full keyboard support.
- **NEW - Attachment preview:** Preview images and plain-text files without downloading; other types stay download-only.
- **NEW - Translucent window (macOS/Windows):** Optional native blur behind the app in Settings > General; email itself always stays solid.
- **NEW - Password recovery:** Expired app passwords surface per account with an inline update form; no more remove-and-re-add.
- **NEW - Email signatures:** Per-account plain-text signature, edited in Settings > Accounts, appended automatically on send.
- **NEW - Undo send:** Outgoing mail holds for a configurable window (default 10s) with countdown, Send now, and Undo in the Outbox.
- **NEW - Snooze:** Hide any message until tomorrow morning, next week, or a chosen time. Snoozed mail waits in its own list and returns automatically.
- **NEW - Mail rules:** Per-account rules file new mail automatically — mark read, archive, trash, junk, or move to any folder — on every successful sync. Rules apply through the offline queue, so failures stay retryable instead of half-applied.
- **PKG:** Updated packages.

## Changes in `v0.1.5:`

- **FIX - Settings Accounts Overlap:** Fixed overlapping text in Settings > Accounts alias management; the alias header, help text, status, and Detect button now wrap cleanly at narrow widths and 200% text scaling.
- **FIX - Sync Timeouts & Efficiency:** Every IMAP sync step now has a 45s timeout instead of hanging forever, and unchanged mailboxes skip the flag re-download (verified by UIDVALIDITY/UIDNEXT/counts).
- **FIX - Offline Queue Independence:** Queued flag/move operations now retry independently; one failed item no longer parks the rest, and mailbox changes retire only the affected item.
- **FIX - Outbox Recovery:** Messages needing attention can rebuild their payload on explicit retry instead of sticking permanently; discarding a pending Sent copy no longer deletes the draft.
- **FIX - Drafts Visibility & Autosave:** Drafts pending server delete stay visible until confirmed; autosave runs every 6s plus on blur/hide; server draft imports preserve the From alias and stop refetch loops.
- **FIX - Forward Keeps Inline Images:** Forwarding now includes inline images as attachments instead of silently dropping them.
- **FIX - Search Ranking:** Cached results keep full-text rank order; server-only body matches append newest-first instead of being re-sorted away.
- **FIX - Oversize Messages:** Messages over the 50 MiB safety limit now open their envelope with an explicit notice; move, archive, and delete stay usable instead of a dead end.
- **FIX - iCloud Alias Discovery Hardening:** CalDAV discovery follows no redirects (no credential forwarding) and allowlists `*.icloud.com` / `*.apple.com` principal hosts.
- **FIX - Folder Roles:** Gmail labels and German/French/Spanish folder names now map to the right roles.
- **UI - Reader Overlay Dialog:** Hidden-pane reader is a proper modal with focus trap, Escape, title focus, and focus restore; mobile overlay focuses the message too.
- **UI - Toolbar Keyboard Nav:** Reader and composer toolbars support Arrow/Home/End navigation; splitters expose controlled panes and larger grab areas.
- **UI - Setup Announcements:** Sign-in failures announce as alerts; iCloud hints linked to inputs; progress steps exposed to assistive tech.
- **UI - Layout Fixes:** To/Cc-Bcc row no longer overlaps, toolbar/composer footer wrap, search and switches meet 44px targets, forced-colors covers dialogs/toasts/alias chips, vibrant-mode CSS variables fixed.
- **Codebase:** Stable attachment IDs (name + CID + size anchored, legacy fallback); pagination limit clamped; remote-draft UID tracking covered by tests.
- **PKG:** Updated packages.

## Changes in `v0.1.4:`

- **NEW - Native Update Flow & Streamlined macOS Menu Check:** Checking for updates from the macOS menu bar or Settings now exclusively displays clean native OS dialogues (reporting up to date, asking to download, and confirming restart) without redundantly opening the Settings window over an alert.
- **NEW - Background Auto-Download & Restart Badge:** Updates are silently checked and downloaded in the background; when ready, a prominent, accessible top-right badge ("Update Ready · Click to Restart") informs you to click and restart at your convenience.
- **NEW - Comprehensive Email Details Breakdown:** Completely overhauled the "Show Details" view in the email reader: reveals From, Reply-To, To, Cc, full date/time with timezone, folder name, verified TLS security badge, Message-ID, and total message size, with one-click copy buttons.
- **FIX - Message Reader Inline Images & Attachments:** Fixed an issue where emails with only inline images displayed an empty attachments section; now only true file attachments are listed with clean counts and sizes.
- **FIX - Plain Text Email Linkification:** Safe click-to-open confirmation for web links (`http/https`) and mailto links in plain text messages.
- **FIX - Outbox Duplicate Send Prevention:** Drafts are now immediately removed from the Drafts mailbox as soon as SMTP delivery succeeds, preventing duplicate sends to recipients if folder reconciliation needs retry.
- **FIX - Mailbox Role Fallbacks & Dot Hierarchies:** Expanded IMAP folder role detection to support dot-separated mailbox hierarchies (e.g., `INBOX.Sent`, `INBOX.Trash`) and standard Outlook/Exchange naming conventions (`Deleted Items`, `Sent Items`, `Junk Email`, `Bin`).
- **FIX - Search Results Merging & Empty State:** Search now seamlessly combines local cached FTS results with server search matches without overwriting, and displays an informative empty state with a "Clear search" action when no results are found.
- **FIX - Composer Quoted Recipient Splitting:** Fixed recipient address field validation when pasting or entering quoted display names containing commas (e.g., `"Doe, Jane" <jane@example.com>`).
- **UI - Accessibility & WCAG Contrast Uplift:** Raised button and text contrast in dark mode to >6.5:1 (exceeding WCAG AAA), improved high-contrast focus rings, enlarged touch targets and composer controls, and enlarged auxiliary text labels across the mail shell.
- **PKG:** Updated packages.

- **NEW - iCloud Aliases & Custom Domains:** Discover and manage iCloud email aliases and custom domains via CalDAV, with support for sending from any alias.
- **NEW - Auto-download newest messages:** Automatically prefetch message bodies for recent incoming messages during sync.
- **NEW - Full Sync / Download All:** Added "All messages (Download all)" storage option that automatically configures cache limits to unlimited.
- **NEW - Update Ready Badge & Native Dialog:** Non-intrusive toolbar badge when a signed update is downloaded and ready, with native OS dialog confirmation to restart.
- **NEW - Native OS Dialogs:** Native modal dialogs across macOS, Windows, and Linux for confirmations and alerts.
- **UI:** Overhauled rich composer with docked minimize pill mode, full-screen maximize toggle, keyboard shortcut sending (`⌘↵` / `Ctrl+Enter`), and clean grouped toolbar without horizontal scrollbars.
- **UI:** Modernized Settings dialog with card-based section layout and dedicated alias management.
- **PKG:** Updated packages.

## Changes in `v0.1.2:`

- **UI:** Fixed an issue where a late mark-as-read, star, move, search, or draft save could overwrite the message or folder you just switched to.
- **Security:** Message loads, flags, and moves now re-check mailbox UIDVALIDITY and stay scoped to the selected account.
- **Logo:** Updated the app icons.
- **Docs:** Removed the proprietary-notice line from the README.
- **Codebase:** Version sync now updates `Cargo.lock` so a version bump no longer breaks `--locked` release builds.
- **PKG:** Updated packages.

## Changes in `v0.1.1:`

- **NEW - Settings access:** Open Settings before adding a mailbox, including from setup and the macOS menu.
- **NEW - Settings portability:** Export, import, or reset preferences without touching accounts, credentials, or mail.
- **NEW - macOS menu:** Check for signed updates, use standard Window actions, and get account-aware mail commands.

## Changes in `v0.1.0:`

- **NEW - iCloud setup:** Guided iCloud Mail setup that uses an app-specific password.
- **NEW - Manual mail:** Secure IMAP and SMTP setup. Only implicit TLS or required STARTTLS is accepted; plaintext and invalid certificates are rejected.
- **NEW - Isolated accounts:** Multiple accounts stay separate. There is no unified inbox.
- **NEW - Mailbox:** Familiar folders, a message list, a reader, search, drafts, outbox, attachments, and rich compose.
- **Security:** Account passwords are stored only in the OS credential vault and never returned over IPC or written to logs.
- **Security:** Received HTML is sanitized and shown in a scriptless, networkless sandboxed iframe. Remote images load only after you say yes, through a proxy that blocks private and reserved destinations.
- **Security:** External links ask for confirmation, then open in the system browser. Attachments save only to a folder you pick.
- **UI:** Large labels, 44px targets where practical, keyboard navigation, visible focus, system light and dark themes, and right / bottom / hidden reading-pane layouts.
- **Windows:** Signed x64 and arm64 NSIS installers (Azure Artifact Signing). No MSI for this release.
- **macOS:** Signed and notarized universal DMG and ZIP.
- **Linux:** x64 AppImage and Flatpak. No DEB or RPM for this release. Arm64 Linux is not shipped yet.
- **Updater:** Direct updates come from GitHub Releases with signed Tauri V2 manifests.
- **PKG:** Updated packages.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are signed and notarized. Windows binaries are Authenticode-signed with Azure Artifact Signing. Linux release files include GPG signatures.
- **Windows Binaries:** Windows installers are published separately for x64 and arm64; choose the installer matching your system architecture.

### This changelog is made using the BCLS standard: https://github.com/BurntToasters/BCLS
