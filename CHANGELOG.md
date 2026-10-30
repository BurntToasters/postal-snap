> [!IMPORTANT]
> Unstable releases (like this one) are released rapidly one after another to test new features. You should never install the unstable releases unless you know what you're doing.

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                                                                                                      | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS                           | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.5.1/Postal-Snap-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.5.1/Postal-Snap-Windows-arm64.exe)                                                                   | **[Universal DMG](https://github.com/BurntToasters/postal-snap/releases/download/v0.5.1/Postal-Snap-macOS.dmg)**                  | **AppImage:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.5.1/Postal-Snap-Linux-x64.AppImage)                                                                                                                                                     |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/<MS_STORE_ID>?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> -->                                                                                           | **[Universal ZIP](https://github.com/BurntToasters/postal-snap/releases/download/v0.5.1/Postal-Snap-macOS.zip)**                  | **Flatpak:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.5.1/Postal-Snap-Linux-x64.flatpak)                                                                                                                                                          |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
>

### ℹ️ Enjoying Postal Snap? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Postal Snap is a calm, accessible desktop email client. Mail stays on your computer. There is no Postal Snap cloud, telemetry, or account of mine to log into.

## Changes in `v0.5.1:`

- **FIX - macOS updates:** Later updates preserve the installed app's identity and avoid an extra Gatekeeper prompt. Updating to 0.5.1 from an older version still uses that version's updater.
- **FIX - macOS restart:** Restarting after an update or Erase All Data reopens Postal Snap in its existing Dock icon instead of adding a second one.
- **FIX - Update reliability:** Changing update channels during installation no longer causes a restart without installing. Failed downloads release their resources.
- **FIX - Mail state:** A refused IMAP flag or keyword write now stays queued instead of being reported as success and discarded. The pinned `async-imap` parser is patched locally to surface the server's tagged response.
- **FIX - Cached mail:** A refused or interrupted folder list, folder status, or message search reply no longer clears cached folders or messages. Empty Folder reports a refused server search instead of claiming success.
- **FIX - Sync:** Folder sync clamps impossible unread counts from STATUS instead of failing the folder forever.
- **FIX - Server search:** Search refuses folders whose EXAMINE reply omits UIDVALIDITY instead of purging cached mail.
- **FIX - Plain text:** A large plain-text message no longer freezes the reader while it looks for links and addresses.
- **FIX - Sending:** A server that accepts the connection and then stops answering no longer holds that account until quit. The message stays in Needs attention.
- **FIX - macOS close:** Closing the window quits when the menu bar icon is not there, instead of hiding the app with no way to see it.
- **FIX - Rules:** When two rules would move the same message, the earlier rule keeps its destination.
- **FIX - Rules:** A pending rule save no longer clears newer text in the form, and a second click while the save is pending does not create a duplicate rule.
- **FIX - Drafts and snoozed mail:** Queued drafts cannot be restored by stale saves, and snooze transfers stay tied to the correct destination mailbox.
- **IMPROVED - Settings and accessibility:** Settings, composer, reader, message list, and folder controls have clearer layouts, keyboard focus, and behavior at larger text sizes and narrow widths.
- **IMPROVED - Attachments and releases:** Attachment reads are bounded, and update manifests and release assets receive stricter validation.

## Changes in `v0.5.0:`

- **NEW - Message downloads:** Mail opens with a partial body and fetches the full message when needed. The reader offers a clear download action, and attachments can optionally stay available offline.
- **NEW - Undo notices:** Move and archive actions offer a short Undo window with status notices that remain available while focused.
- **NEW - Command palette:** Use Mod+K to find and run available mailbox actions, with shortcut help from the keyboard overlay.
- **NEW - Rich signatures:** Set a formatted account signature with a plain-text alternative.
- **NEW - Inbox badge scope:** Choose the Active account Inbox or All account Inboxes; the latter sums existing Inbox unread counts without combining mail views.
- **NEW - Received-sender suggestions:** Find addresses from the active account's received mail; suggestions exclude your addresses and aliases, muted threads, blocked senders, Junk, Trash, and no-reply addresses.
- **IMPROVED - Sync:** A read-only INBOX watcher wakes the serialized account worker when servers allow another connection; folder status and queued move work are handled in batches.
- **IMPROVED - Large mailboxes:** Message lists handle long folders with virtualized rows and preserve keyboard and screen-reader list navigation.
- **IMPROVED - Recovery and resilience:** Reader or composer render failures can recover in place, while mail parsing and local operations remain isolated to the affected message or task.

## Changes in `v0.4.3:`

- **NEW - Update channel:** Settings > Advanced has an Update channel choice: Auto, Stable, or Beta. Auto follows the build you installed. It is hidden in Microsoft Store, Mac App Store, and Flatpak builds. Switching channels discards an update that was already downloaded.
- **IMPROVED - Beta to Stable:** Choosing Stable on a beta build never downgrades. Postal Snap waits for a newer stable release.
- **IMPROVED - Settings tab name:** "Privacy & Security" is now "Advanced".
- **IMPROVED - Large text and density:** Switches, checkboxes, radio buttons, folder indents, and recipient suggestions scale with text size in comfortable and compact density.
- **IMPROVED - Keyboard and screen readers:** Dialogs keep focus inside, including summaries and the composer body. Recent searches support full keyboard use. The account switcher announces the selected account. Setup announces completed steps. The search scope label stays stable and shows its state in forced-colors mode.
- **IMPROVED - Folder list:** The expand button is a full-size target and reports whether it is expanded. Folder action names are consistent.
- **IMPROVED - Truncated text:** Cut-off text and icon buttons show their full name on hover.
- **FIX - Wording:** Uses "Canceled" and "On this computer" consistently.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are signed and notarized. Windows binaries are Authenticode-signed with Azure Artifact Signing. Linux release files include GPG signatures.
- **Windows Binaries:** Windows installers are published separately for x64 and arm64; choose the installer matching your system architecture.

### This changelog is made using the BCLS standard: https://github.com/BurntToasters/BCLS
