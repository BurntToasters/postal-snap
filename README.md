# Postal Snap

Postal Snap is a accessible desktop email client built for seniors and anyone who wants a calm mail experience.

## Development

Prerequisites: Node.js 24+, Rust stable, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run setup:e2e
npm run tauri:dev
```

Postal Snap stores account passwords only in the operating system credential vault. Mail data stays on the device. The application has no telemetry or cloud backend.

Before packaging, run:

```sh
npm run test:all
npm run test:mail-integration # Docker + OpenSSL
npm run audit
npm run licenses
```

Real iCloud and signed-package checks remain manual release gates. See [Releasing](docs/RELEASING.md) and the [0.1 release checklist](docs/RELEASE_CHECKLIST.md).

## Distribution

First releases are GitHub-only.

- Direct: signed Windows NSIS installers, notarized universal macOS DMG/ZIP, Linux AppImage/Flatpak.
- Updates: signed manifests and payloads from GitHub Releases.
- Later: Microsoft Store MSIX and Mac App Store PKG (scripts exist; not part of GitHub 0.1.x).
