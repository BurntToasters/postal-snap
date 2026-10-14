> [!IMPORTANT]
> Unstable releases (like this one) are released rapidly one after another to test new features. You should never install the unstable releases unless you know what you're doing.

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                                                                                                      | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS                           | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.1/Postal-Snap-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.1/Postal-Snap-Windows-arm64.exe)                                                                   | **[Universal DMG](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.1/Postal-Snap-macOS.dmg)**                  | **AppImage:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.1/Postal-Snap-Linux-x64.AppImage)                                                                                                                                                     |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/<MS_STORE_ID>?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> -->                                                                                           | **[Universal ZIP](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.1/Postal-Snap-macOS.zip)**                  | **Flatpak:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.1/Postal-Snap-Linux-x64.flatpak)                                                                                                                                                          |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
>

### ℹ️ Enjoying Postal Snap? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Postal Snap is a calm, accessible desktop email client. Mail stays on your computer. There is no Postal Snap cloud, telemetry, or account of mine to log into.

## Changes in `v0.4.1:`

- **FIX - Open message is never replaced:** Opening a mail link, Reply, or Forward no longer replaces the message you are writing while it is unsaved or still sending. If the open message cannot be saved, Postal Snap keeps your edits and says so. If a message is still sending, the new message waits until you try again.
- **FIX - Replied and forwarded marks:** Replied and forwarded marks stay on a message after you archive it and after you restart Postal Snap. Pending mark changes are finished before the message moves.
- **FIX - Archive after sending:** Archiving a sent message is now a separate follow-up step, and a message the server already accepted is never sent again. If archiving fails, the Outbox shows the warning with **Retry archive** and **Dismiss**.
- **FIX - Offline changes replay safely:** Flag, move, and delete changes made while offline replay more carefully after reconnect. Changes that no longer match a message are dropped. The incoming server's identity is checked before they replay.
- **FIX - Updates and sending:** Sending pauses while an update installs. Messages still waiting to send are kept as drafts, so none are lost.
- **FIX - Undo after moving:** Undo after archiving or moving a message works on the copy that is now in the new folder.
- **FIX - Outbox reasons:** The Outbox says why each message is waiting, not sent, or uncertain. A message whose delivery cannot be confirmed is never resent automatically.
- **FIX - Reset everything reports leftovers:** If Reset everything cannot remove every file, Postal Snap says the reset did not finish instead of reporting success. Restart Postal Snap to retry the cleanup.
- **FIX - Attachment files after account removal:** Attachment folders left behind by a removed account are tracked, and Postal Snap tries again the next time it starts.
- **FIX - Unreadable messages:** A message that cannot be read safely is shown as unreadable and is not opened again. Read it in another mail app or delete it.
- **FIX - Mail links and performance:** Mail links are read more carefully. Mail sync, database reads, and long message lists have been improved.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are signed and notarized. Windows binaries are Authenticode-signed with Azure Artifact Signing. Linux release files include GPG signatures.
- **Windows Binaries:** Windows installers are published separately for x64 and arm64; choose the installer matching your system architecture.

### This changelog is made using the BCLS standard: https://github.com/BurntToasters/BCLS
