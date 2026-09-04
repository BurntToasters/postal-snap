# Postal Snap

Postal Snap is an accessible desktop email client built for seniors and anyone who wants a calm mail experience. Big readable text, obvious buttons, no clutter — and your mail stays on your computer.

## Download

Get the latest release from [GitHub Releases](https://github.com/BurntToasters/postal-snap/releases).

| Windows                      | macOS                                    | Linux                  |
| :--------------------------- | :--------------------------------------- | :--------------------- |
| Signed x64 / arm64 installer | Universal DMG / ZIP (signed & notarized) | x64 AppImage / Flatpak |

First releases are GitHub-only. Microsoft Store and Mac App Store builds come later.

## Why seniors like it

- **Guided iCloud setup:** step-by-step sign-in with an app-specific password; manual IMAP/SMTP for other providers.
- **Calm mailbox:** familiar folders, large labels, clear unread counts, right/bottom/hidden reading panes.
- **Readable mail:** adjustable text size up to 200%, light/dark follows the system, reduced-motion and high-contrast support.
- **Full keyboard use:** shortcuts for writing, replying, archiving, and navigating; visible focus everywhere.
- **Rich compose:** formatting toolbar, inline images, attachments with size warnings, drafts that autosave.
- **Aliases:** send and receive with iCloud aliases and custom domains.
- **Offline friendly:** queued flags, moves, drafts, and outbox replay safely after reconnect. Uncertain sends wait for your explicit retry — never silent duplicates.
- **Search:** instant local results plus server fallback across one folder or all.

## Getting started with iCloud

1. On your iPhone, iPad, or at [appleid.apple.com](https://appleid.apple.com), create an **app-specific password** for mail.
2. Open Postal Snap, choose **iCloud Mail**, enter your name, iCloud address, and that app-specific password (not your regular Apple password).
3. Click **Connect securely**. Your normal password never works here — the app tells you so if sign-in fails.

## Privacy & security

- Account passwords live only in the operating-system credential vault. They cross into the app once at setup and are never logged or returned.
- Mail data stays in a local database on the device. No telemetry, analytics, accounts, or cloud backend.
- Verified TLS only (implicit TLS or required STARTTLS). No plaintext, no POP.
- Received mail renders sanitized in a scriptless, networkless box. Remote images load only after you allow them, fetched through a proxy that blocks private-network targets.
- Links open in the system browser after confirmation. Attachments save only where you choose.

## Development

Prerequisites: Node.js 24+, Rust 1.97.1, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run setup:e2e
npm run tauri:dev
```

Before packaging, run:

```sh
npm run test:all
npm run test:mail-integration # Docker + OpenSSL
npm run audit
npm run licenses
```

Real iCloud and signed-package checks remain manual release gates. See [Releasing](docs/RELEASING.md), the [0.1 release checklist](docs/RELEASE_CHECKLIST.md), [Architecture](docs/ARCHITECTURE.md), and [Security](SECURITY.md).
