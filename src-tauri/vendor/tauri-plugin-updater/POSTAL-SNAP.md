# Vendored updater

This package comes from Tauri `plugins-workspace` commit `f36ba7ba48695776bc11cce0bfdc45678ec24f72`, package version 2.14.0. Workspace dependencies were expanded into the package manifest. The original MIT and Apache-2.0 licenses are included.

Postal Snap changes the macOS install path to preserve the outer app directory and remove quarantine only from the signature-verified staged Contents tree. The existing privileged install and rollback paths operate on Contents. Other platforms and signature verification retain the upstream implementation.

Run `npm run test:macos-updater` on macOS and `npm run test:e2e -- e2e/updater-safety.spec.ts --project=chromium`. A signed update, administrator-owned install, visible Dock behavior, and saved attachment quarantine still require the release checklist.
