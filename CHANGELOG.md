> [!IMPORTANT]
> Unstable releases (like this one) are released rapidly one after another to test new features. You should never install the unstable releases unless you know what you're doing.

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                                                                                                      | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS                           | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/Postal-Snap-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/Postal-Snap-Windows-arm64.exe)                                                                   | **[Universal DMG](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/Postal-Snap-macOS.dmg)**                  | **AppImage:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/Postal-Snap-Linux-x64.AppImage)                                                                                                                                                     |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/<MS_STORE_ID>?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> -->                                                                                           | **[Universal ZIP](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/Postal-Snap-macOS.zip)**                  | **Flatpak:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/Postal-Snap-Linux-x64.flatpak)                                                                                                                                                          |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
>

### ℹ️ Enjoying Postal Snap? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Postal Snap is a calm, accessible desktop email client. Mail stays on your computer. There is no Postal Snap cloud, telemetry, or account of mine to log into.

## Changes in `v0.4.2:`

- **FIX - Message list layout:** Messages, folder headings, filters, and day labels line up again. Selected messages use one continuous highlight.
- **NEW - Message hover actions:** Hover over a message for Star, Read or Unread, Archive, and Trash. Star and unread indicators stay visible. Touch and keyboard controls remain available.
- **IMPROVED - Mailbox filters:** All, Unread, and Starred stay visible. More holds Pinned, To me, Has attachments, and Invitations, and shows the active filter.
- **FIX - Quick reply width:** Quick reply fills the reader width, expands when focused or filled, and grows as you type. Reply still opens the full composer.
- **FIX - Quick reply keeps your note:** If another message cannot be saved or replaced, your quick reply stays in the box. Opening a reply also avoids a composer crash in WebKit.
- **IMPROVED - Reader toolbar:** Reply actions stay together. Star, Archive, Trash, and More share a group. Message navigation appears only when needed.
- **IMPROVED - Header and sidebar alignment:** Reader links and notices line up with the message. The unread-folders control matches the sidebar.
- **FIX - Large text and compact layout:** Message rows, filters, and reader controls fit better at 200% text in comfortable and compact density.
- **IMPROVED - Code organization:** Mailbox and reader behavior is split into smaller modules for easier maintenance.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are signed and notarized. Windows binaries are Authenticode-signed with Azure Artifact Signing. Linux release files include GPG signatures.
- **Windows Binaries:** Windows installers are published separately for x64 and arm64; choose the installer matching your system architecture.

### This changelog is made using the BCLS standard: https://github.com/BurntToasters/BCLS
