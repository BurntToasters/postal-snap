# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                                                                                                      | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS                           | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.5/Postal-Snap-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.5/Postal-Snap-Windows-arm64.exe)                                                                   | **[Universal DMG](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.5/Postal-Snap-macOS.dmg)**                  | **AppImage:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.5/Postal-Snap-Linux-x64.AppImage)                                                                                                                                                     |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/<MS_STORE_ID>?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> -->                                                                                           | **[Universal ZIP](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.5/Postal-Snap-macOS.zip)**                  | **Flatpak:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.5/Postal-Snap-Linux-x64.flatpak)                                                                                                                                                          |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
>

### ℹ️ Enjoying Postal Snap? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Postal Snap is a calm, accessible desktop email client. Mail stays on your computer. There is no Postal Snap cloud, telemetry, or account of mine to log into.

## Changes in `v0.1.5:`

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
- **NEW - Background Auto-Download & Restart Badge:** Updates are silently checked and downloaded in the background; when ready, a prominent, accessible top-right badge ("Update Ready · Click to Restart") informs seniors to click and restart at their convenience.
- **NEW - Comprehensive Email Details Breakdown:** Completely overhauled the "Show Details" view in the email reader: reveals From, Reply-To, To, Cc, full date/time with timezone, folder name, verified TLS security badge, Message-ID, and total message size, with one-click copy buttons.
- **FIX - Message Reader Inline Images & Attachments:** Fixed an issue where emails with only inline images displayed an empty attachments section; now only true file attachments are listed with clean counts and sizes.
- **FIX - Plain Text Email Linkification:** Safe click-to-open confirmation for web links (`http/https`) and mailto links in plain text messages.
- **FIX - Outbox Duplicate Send Prevention:** Drafts are now immediately removed from the Drafts mailbox as soon as SMTP delivery succeeds, preventing duplicate sends to recipients if folder reconciliation needs retry.
- **FIX - Mailbox Role Fallbacks & Dot Hierarchies:** Expanded IMAP folder role detection to support dot-separated mailbox hierarchies (e.g., `INBOX.Sent`, `INBOX.Trash`) and standard Outlook/Exchange naming conventions (`Deleted Items`, `Sent Items`, `Junk Email`, `Bin`).
- **FIX - Search Results Merging & Empty State:** Search now seamlessly combines local cached FTS results with server search matches without overwriting, and displays an informative empty state with a "Clear search" action when no results are found.
- **FIX - Composer Quoted Recipient Splitting:** Fixed recipient address field validation when pasting or entering quoted display names containing commas (e.g., `"Doe, Jane" <jane@example.com>`).
- **UI - Senior Accessibility & WCAG Contrast Uplift:** Raised button and text contrast in dark mode to >6.5:1 (exceeding WCAG AAA), improved high-contrast focus rings, enlarged touch targets and composer controls, and enlarged auxiliary text labels across the mail shell.
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
