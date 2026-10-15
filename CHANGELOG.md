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
