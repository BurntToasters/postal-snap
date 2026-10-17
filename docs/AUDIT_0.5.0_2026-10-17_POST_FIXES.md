# Postal Snap 0.5.0 post-fix audit — October 17, 2026

Audited `next-0.5.0` at `5b3f823f20d5c6cd84cdd2e911b23d0f1e9e60c1` ("Fix snooze transfers and account state races"), against the morning audit at `96a08cb` (`docs/AUDIT_0.5.0_2026-10-17.md`). The checkout was clean. This audit changes no production source.

Scope: every change in the fix commit, re-verification of the five earlier findings, and neighbouring code paths that share their failure modes. The rest of the 0.4.3→0.5.0 surface was covered by the earlier report and was not re-reviewed line by line. Existing gates were re-run in full.

## Status of earlier findings

| #   | Earlier finding                                 | Status                                                                                                              | Evidence                                                                                                                                                                                                               |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Batched move replay drops snoozes               | Closed                                                                                                              | `remove_moved_messages` writes `pending_snooze_transfers` (schema 41) in the same transaction as source deletion. GreenMail `greenmail-batched-move-keeps-snoozes` passes and asserts a two-message batch was planned. |
| 2   | Restoration can snooze the wrong mailbox copy   | Closed                                                                                                              | Landing is scoped to the destination `mailbox_id`; highest UID wins only within that mailbox. Rust test covers an other-folder copy with a higher UID.                                                                 |
| 3   | One failed destination refresh loses the snooze | Closed                                                                                                              | Transfers are durable and land in `upsert_envelopes`, `sync_folder`, and `refresh_mailbox_envelopes`. Rewritten GreenMail test no longer captures or restores the snooze itself.                                       |
| 4   | Overlapping identity saves overwrite newer data | Closed for name, Reply-To, signature, aliases, password; **same defect remains in sibling editors** (new finding 2) | Morning browser probes re-run: 4/4 pass (were 4/4 failing). New `e2e/account-response-merge.spec.ts` passes in both densities at 100%/200%.                                                                            |
| 5   | Windows installer overwrites shared `mailto`    | **Not closed** (new finding 1)                                                                                      | The hook no longer writes the shared key, but Tauri's own NSIS template still does.                                                                                                                                    |

The morning native probes (`reproduce-native.py`) target the removed `restore_snooze_for_message` API and no longer compile. The new tests in `src-tauri/src/db/snooze_transfers.rs` replace them.

## Findings

### 1. P2 — Tauri's NSIS template still overwrites and deletes the shared mailto handler

Locations: `src-tauri/tauri.conf.json:98-104` (`plugins.deep-link.desktop.schemes: ["mailto"]`), `src-tauri/windows/installer-hooks.nsh`.

The Tauri CLI (`@tauri-apps/cli` 2.12.2) reads `plugins > deep-link > desktop` and fills `deep_link_protocols` in its built-in `installer.nsi`. Extracted from the shipped CLI binary, the install section writes, between our PREINSTALL and POSTINSTALL hooks:

```nsis
WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
```

With `installMode: "currentUser"`, `SHCTX` is HKCU. A previously registered mail client's `HKCU\Software\Classes\mailto` command is therefore still overwritten on every install and upgrade, exactly as before. On uninstall the template deletes the whole `mailto` key when the command matches ours. That deletion runs on `/UPDATE` too, so an upgrade deletes and then rewrites the key.

The new hook interacts with this. Our PREUNINSTALL runs first and, on a real uninstall, deletes `shell\open\command` when it matches. Tauri's check then finds no command and skips its whole-key delete. The result is a stale `mailto` key that keeps `URL Protocol`, Tauri's `URL:run.rosie.snap protocol` default, and a `DefaultIcon` pointing at the removed binary. The icon is left because Tauri writes it quoted (`"…exe",0`) while our hook compares the unquoted `…exe,0`.

`scripts/release-assets.test.js` inspects only the hook file, so it passes while the generated installer still has the original behaviour.

The scheme cannot simply be removed from the Windows config. `tauri-plugin-deep-link` 2.6.1 `handle_cli_arguments` only accepts a launch argument whose scheme is listed in `desktop.schemes`, so removing it would break `mailto:` launches. Options:

- In PREINSTALL, copy an existing `mailto` command, default value, and icon to an app-owned backup key when they are not Postal Snap's. In POSTINSTALL, restore them over Tauri's writes. Tauri's uninstall then leaves a restored handler alone because it no longer matches. Upgrades need the same treatment.
- Or override the deep-link protocol list for the NSIS bundle only, if the CLI exposes a bundle-level override separate from the runtime plugin config. This was not found in 2.12.2.

Also drop the hook's legacy command-only deletion, or delete the whole key only when every value is Postal Snap's, so no skeleton is left. Verify on a Windows VM with a pre-existing client, then install, upgrade, and uninstall. Add a release-assets check that fails while the deep-link scheme is configured and the hook lacks backup/restore.

Evidence: static, from the CLI's embedded template (`strings` on `cli.darwin-arm64.node`) and the plugin source. A Windows installer run was not executed.

### 2. P2 — Body format, color, and failure refreshes still replace the account object

Locations: `src/components/settings/bodyFormatControl.tsx:23`, `src/components/settings/accountsTab.tsx:257`, `src/App.tsx:301-304`.

The fix merged owned fields for the identity, alias, and password saves only. Three sibling writers keep the defect class from earlier finding 4:

- The default body format save replaces the account with its response snapshot.
- The color save maps over `accounts` captured at render time, not current store state. It discards any account change made after that render, such as a name or Reply-To save that finished while the color request was in flight.
- On an `authFailed` or `offline` sync event, `App.tsx` replaces every account with a `listAccounts()` result. A list issued before an identity save commits and resolved after it erases the newer field in frontend state until the next refresh.

The Composer reads `replyTo` and the signature from this store (`src/components/Composer.tsx:238`), so a stale value can reach a new message. As before, the persisted database value is not lost.

Route these through the same owned-field merge (`color`, `defaultBodyFormat`, and `syncState`/`error` for the failure refresh). Or version account mutations so an older snapshot cannot replace a newer one. Extend `account-response-merge.spec.ts` with color-vs-Reply-To and failure-refresh-vs-name interleavings.

Evidence: control flow. No probe was written for these paths.

### 3. P3 — Immediate moves drop snoozes; deferred and queued moves keep them

Locations: `src-tauri/src/commands/messages.rs:927` (`move_message_inner`), `:1162` (bulk move without an undo token).

After a successful live move, both paths call `remove_message`, which cascades the snooze away. The same user action keeps the snooze when it goes through the undo window or the offline queue, because those replay through `remove_moved_messages`. A snoozed message opened from the Snoozed view and archived therefore keeps or loses its snooze depending on connectivity and the undo setting.

Either choice is defensible: an explicit move may reasonably end the snooze. But the behaviour should be one documented policy. Use `remove_moved_messages` on the live paths, or clear the snooze explicitly before every user-initiated move, including deferred ones.

## Fix-commit review notes (no action needed)

- Migration 41 is transactional, `CREATE TABLE IF NOT EXISTS`, and cascades on account and mailbox deletion. `foreign_keys` is on for both connections, so account removal and the existing compaction cover the stored Message-ID headers.
- Expired transfers are dropped using the same `strftime` format as `NOT_SNOOZED_SQL`. `snooze_message` stores that format.
- The transfer-landing query runs in the envelope write transaction, so a moved copy is never briefly visible before its snooze applies.
- The batch path falls back to per-operation replay only on a database error. That replay uses `dedupe_existing: true`, so the already-moved UIDs are not duplicated. An uncached destination now removes the source and drops the snooze rather than stalling the queue.
- `mailbox_id_for_name` and the new lookup use the same `name` column, so the landing and recording keys agree.
- The new E2E spec imports `/src/store.ts` via a runtime path; it relies on the Vite dev server that `run-e2e.js` uses.

## Verification

Logs are in `artifacts/audit-0.5.0-2026-10-17-post-fixes/`.

- `npm run test:all`: all 15 stages pass, including format, clippy, both typechecks, 692 frontend tests in 42 files, the Playwright suite, Rust tests, release assets, and the production build.
- `npm run test:mail-integration`: passed, 24 report entries (23 earlier plus the new batched-snooze scenario). The report names commit `5b3f823`.
- `npm run audit`, `npm run filters:check`, `npm run licenses`: passed.
- Morning browser probes (`artifacts/audit-0.5.0-2026-10-17/playwright.config.ts`): 4/4 pass.

## Remaining release gates

Resolve findings 1 and 2 before stable promotion; finding 3 needs a policy decision. `docs/RELEASE_CHECKLIST.md` remains authoritative. These are still unproven by this audit:

- A Windows install, upgrade, and uninstall with a pre-existing mail client.
- Live iCloud and Proton Bridge smoke tests.
- Hosted CI.
- Signed builds, notarization, and updater signatures.
- Clean install, `mailto:`, offline restart, and uninstall on every target.
