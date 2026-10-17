# Postal Snap 0.5.0 audit — October 17, 2026

Audited `next-0.5.0` at `96a08cb615eb6e427a597639c7566ab8c66ba364`, compared with `v0.4.3`. The starting checkout was clean. The comparison contains 222 changed files, including substantial generated filter data. This audit changes no production source or existing tests. Its probes live under the ignored artifact directory; native probes run against a temporary source copy.

The audit found five actionable issues. Three have additional failing probes; two are established by production control flow. All are P2 correctness or installation issues. No new demonstrated sanitizer, SSRF, credential, or uncertain-SMTP bypass was found. This is a broad code and local verification audit, not certification of every execution path or platform.

## Findings

### 1. P2 — Batched move replay drops snoozes

Location: `src-tauri/src/commands.rs:1309`.

The new batch path deletes each source message and its queued operation after a successful remote move. Deleting the message cascades to `snoozed_messages`. Unlike the single-message path at line 1525, the batch path never captures or restores snoozes. Refreshing the destination recreates ordinary visible messages without their scheduled return time.

A concrete trigger is two unread snoozed messages matched by a new move filter. The filter scan in `src-tauri/src/db/outbox.rs` includes snoozed unread Inbox rows. Consecutive moves with matching source, destination, and UIDVALIDITY can share the batch when the server advertises MOVE. Neither message has to be opened or manually unsnoozed.

Preserve snooze metadata in both replay paths. Prefer a shared durable transfer mechanism so successful remote moves do not discard local intent. Add a TLS replay test with at least two snoozed messages; assert final snoozes without restoring them in the test. This finding is based on production control flow, not a newly executed batched-snooze TLS scenario. The batch path is new in 0.5.0; snooze preservation was also incomplete before the recent single-message repair.

### 2. P2 — Snooze restoration can hide the wrong mailbox copy

Location: `src-tauri/src/db/outbox.rs:574`.

`restore_snooze_for_message` searches the entire account by Message-ID and selects the greatest `received_at`, then UID. The caller knows the destination folder but does not pass it. Message-ID is shared by legitimate copies, and UIDs are mailbox-scoped. An existing copy in another folder can therefore win over the newly moved message.

The isolated database probe creates a destination copy with UID 1 and another-folder copy with UID 99, sharing the same Message-ID and date. Restoration snoozes row 3 instead of destination row 2. The moved message remains visible while an unrelated copy disappears from its folder.

Scope restoration to the verified destination identity. Do not compare UIDs across folders to choose a landing row. When destination identity cannot yet be established, retain pending restoration rather than guessing. Evidence: `native-probes.log`, test `audit_snooze_restore_must_target_destination`.

### 3. P2 — One failed destination refresh permanently loses a snooze

Locations: `src-tauri/src/commands.rs:1525` and `src-tauri/src/db/outbox.rs:581`.

Single-message replay captures the snooze only in memory, deletes its source row, ignores destination-refresh failure, and calls restoration once. When the destination row is not cached yet, restoration returns success without writing anything. Replay then retires the operation. A later successful sync has no durable snooze record to recover. A crash between source deletion and restoration has the same loss window.

The isolated database probe executes that storage sequence, then inserts the destination message as a later sync would. Expected snoozes: 1; actual: 0. It does not inject a network failure into a live actor; the caller's ignored refresh result establishes how this storage sequence is reached.

Persist the transfer intent before deleting the source, and retry restoration after destination refresh or restart. Messages without a Message-ID also need an explicit preservation policy. Evidence: `native-probes.log`, test `audit_snooze_survives_delayed_destination_refresh`.

The existing `greenmail_replayed_deferred_move_keeps_the_snooze` test is insufficient proof: it captures metadata itself, waits for the destination, and invokes `restore_snooze_for_message` itself at `src-tauri/src/commands/deferred_integration_tests.rs:522`. That can repair the behavior being tested. It covers only one move, so it also misses finding 1.

### 4. P2 — Overlapping identity saves replace newer account state with an older snapshot

Locations: `src/components/settings/useSettingsAccountManagement.ts:262`, `:298`, and the signature handler's equivalent account replacement.

Name, Reply-To, and signature saves have separate busy flags, so different fields can save concurrently. Every response replaces the whole account in the store. If the name response contains a snapshot taken before a Reply-To save but arrives afterward, it erases the newer Reply-To from frontend state. Input revision guards preserve individual editing controls; they do not protect the shared account object.

Four browser probes hold an already-created name response, complete a Reply-To save, then release the name response. All comfortable/compact and 100%/200% combinations reproduce the failure: expected `new-reply@example.test`, received an empty string. Composer initialization reads this stale account value in `src/components/Composer.tsx:238`. The probe establishes frontend state loss, not loss of the persisted database value or actual SMTP delivery.

Merge only fields owned by each response, or serialize/version all account mutations and refreshes. Cover interleaved saves of different fields, in addition to newer edits within one field. This race already exists in 0.4.3's `SettingsDialog`; it is an inherited defect retained through extraction and the recent save-race repair, not a newly introduced 0.5.0 regression.

Evidence: `account-response.spec.ts`, `browser-results.json`, and per-case traces, screenshots, and account snapshots.

### 5. P2 — Windows installer overwrites and then deletes a shared mailto registration

Location: `src-tauri/windows/installer-hooks.nsh:25` and `:36`.

The added preinstall hook unconditionally writes the user's shared `Software\Classes\mailto` command and icon. It neither checks nor saves an existing handler. The uninstall ownership check sees Postal Snap's newly written command and deletes the entire shared protocol key. Thus a previously registered command is not preserved across install/uninstall. The equality check protects only a handler written after Postal Snap installed; it cannot protect the registration overwritten during installation. Registration also happens before the binary is copied, so an interrupted installation can leave a command pointing to an incomplete install.

Register an application-specific ProgID and application capabilities, and remove only application-owned registration during uninstall. Microsoft documents `RegisteredApplications`, `Capabilities`, and `URLAssociations` for Default Programs registration: [Default Programs](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs). Do not equate writing the shared scheme command with completing that registration flow.

This is a static finding about the hook's writes and deletion. A Windows VM installation was not executed, and no claim is made that this overrides every modern Windows UserChoice setting. Validate with a pre-existing mail client, explicit user choice, interrupted install, upgrade, and uninstall. The release test currently asserts the presence of these registry commands rather than preservation of another client's registration.

## Coverage

| Area                  | Review and verification boundary                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database and upgrade  | Reviewed transactional migration dispatcher, schema 36–40, newer-schema rejection, deferred operation holds, read/write connections, cache accounting, clear/compaction, and snooze transfer. Native probes reproduce two persistence failures. No real user database was opened.                                                                                      |
| IMAP and sync         | Reviewed actor/watcher ownership, no-IDLE fallback, connection refusal, scoped sync, LIST-STATUS fallback, client ID, UIDVALIDITY checks, partial/full body paths, parse quarantine, queued flag dependencies, and batched move replay. Canonical TLS integration runs separately. Long sleep/network churn and large provider mailboxes remain unverified.            |
| Drafts and outbox     | Reviewed extracted persistence, send, and attachment hooks; active-send protection; unsigned queue versus signed MIME; send claims; explicit uncertain-send state; retry bookkeeping. Existing tests exercise composer replacement and queue behavior. Real provider delivery and native quit behavior remain separate gates.                                          |
| Security              | Inspected verified TLS/STARTTLS and Bridge pinning, sanitizer boundaries, received iframe restrictions, remote-image DNS/redirect controls, external-link confirmation, attachment ownership, MIME limits, IPC redaction, CSP, and direct/store permissions. Live configured dependency audits pass. This is not a penetration test or exhaustive hostile-input proof. |
| UI and accessibility  | Reviewed virtual-list focus/range retention, command palette scope, action matching, notices/undo sessions, view recovery, badge ordering, settings state, signature editor, and density tests. New browser probes cover both densities and 200% text. No manual screen-reader or native webview session was performed.                                                |
| Performance           | Reviewed virtualized mounting, prefetch index/order, bounded body batches, parser offloading, and reused database statements. Existing browser coverage includes 1,000-row artifacts. No long-session heap profile, very large real mailbox benchmark, or sustained native resource measurement was performed.                                                         |
| Release and platforms | Reviewed package quality gate, dependency repair documentation, capabilities, updater configuration, installer hook changes, and CI configuration. Ran configured security, filter, and license checks. No hosted CI result, cross-platform signed build, installer run, notarization, or real updater transaction is certified.                                       |

## Verification

Final command outcomes and artifact hashes are recorded in `artifacts/audit-0.5.0-2026-10-17/verification.json`.

- `npm run audit`: passed. Both npm scans report zero vulnerabilities; the configured Cargo audit passes against 679 locked crates. This respects the existing documented advisory exceptions; it does not mean the dependency graph has no acknowledged advisories.
- `npm run test:mail-integration`: passed, 23 report entries, pinned GreenMail 2.1.11 and compatibility fixture version 8. The copied report identifies the audited commit.
- `npm run filters:check`: passed, six official source files verified.
- `npm run licenses`: passed; 75 npm and 678 Cargo entries generated. The generator reports 48 Cargo packages without embedded license text; SPDX identifiers remain. This is not legal sign-off.
- Additional browser audit probes: four expected assertion failures establish finding 4.
- Additional isolated native probes: two expected assertion failures establish findings 2 and 3.
- `npm run test:all`: the authorized rerun passed all 15 stages, including 692 frontend tests across 42 files, 1,229 Playwright cases (zero unexpected, flaky, or skipped), Rust tests, release-asset tests, and production build. The first sandbox attempt encountered `listen EPERM` and was stopped. The full Playwright report is archived with the audit. Probe trace writes briefly triggered Vite reload notices during concurrent execution; the aggregate run still completed without failed or flaky cases.

The earlier October 16 report is historical. Current attachment-ID resolution, same-field signature edit preservation, no-IDLE session release, global partial-body accounting, undo-session holds, and dependency repairs were inspected rather than assuming those old findings still apply.

## Reproduction

Run browser probes separately from the full browser suite so generated trace HTML cannot trigger Vite reloads in another run:

```sh
POSTAL_SNAP_E2E_PORT=4199 npm run test:e2e -- \
  --config artifacts/audit-0.5.0-2026-10-17/playwright.config.ts
python3 artifacts/audit-0.5.0-2026-10-17/reproduce-native.py
```

Both commands are expected to fail their assertions on the audited commit. The native runner copies source to a temporary directory and retains that directory for inspection. All fixtures use synthetic mail. Keep the ignored artifact directory with this report when transferring the evidence.

## Remaining release gates

Resolve the findings and rerun relevant regression coverage before stable promotion. `docs/RELEASE_CHECKLIST.md` remains authoritative. Pending proof includes live iCloud and actual Proton Bridge smoke, target-native Windows/Linux execution, hosted CI, manual assistive technology, real 0.4.3 upgrade/recovery, prolonged sleep/reconnect behavior, signed builds on required architectures, Authenticode/Gatekeeper/notarization, updater signatures and manifests, entitlements, and clean install/update/mailto/offline restart/uninstall. Store-train certification is separate. Mocked UI tests and local TLS fixtures do not close these gaps.
