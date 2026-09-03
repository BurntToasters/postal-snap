# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                                                                                                      | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS                           | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.3/Postal-Snap-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.3/Postal-Snap-Windows-arm64.exe)                                                                   | **[Universal DMG](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.3/Postal-Snap-macOS.dmg)**                  | **AppImage:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.3/Postal-Snap-Linux-x64.AppImage) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.3/Postal-Snap-Linux-arm64.AppImage)                                    |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/<MS_STORE_ID>?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> -->                                                                                           | **[Universal ZIP](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.3/Postal-Snap-macOS.zip)**                  | **Flatpak:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.3/Postal-Snap-Linux-x64.flatpak) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.3/Postal-Snap-Linux-arm64.flatpak)                                        |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
>

### ℹ️ Enjoying Postal Snap? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Postal Snap is a calm, accessible desktop email client. Mail stays on your computer. There is no Postal Snap cloud, telemetry, or account of mine to log into.

## Changes in `v0.1.3:`

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
