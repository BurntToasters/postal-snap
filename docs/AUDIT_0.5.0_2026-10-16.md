# Postal Snap 0.5.0 audit — October 16, 2026

Audited `next-0.5.0` at `8d9d0ced1b710d902a31271e97bb68131d4d4f2a`, against `v0.4.3`. The checkout was clean. The comparison contains one feature commit, 185 changed files, 23,737 inserted lines, and 9,223 deleted lines. This audit changes no production code or existing tests.

The existing automated gates are strong, but this checkout is not ready for release approval. The live dependency audit fails, and additional probes reproduce attachment and signature failures that the existing suites do not catch. Six actionable findings follow. Findings 4 and 5 are established by tracing production control flow; their full native scenarios remain untested.

## Findings

### 1. P1 — The updater dependency graph fails the security gate

`src-tauri/Cargo.lock:4420` locks rustls 0.23.45. `src-tauri/Cargo.lock:7276` locks zip 4.6.1. `npm run audit` passes both npm audits with zero reported vulnerabilities, then fails Cargo audit with seven vulnerabilities:

- rustls: RUSTSEC-2026-0346, -0347, -0348, and -0349; the reported patched range is >=0.23.46.
- zip: RUSTSEC-2026-0367, -0368, and -0369; the reported patched range is >=9.0.0.

`cargo tree -i` traces both packages to tauri-plugin-updater 2.13.3. ZIP is target-dependent and requires `--target all` to appear from this macOS host. The updater's Windows ZIP path calls `ZipArchive::extract`. Its ordinary download path verifies the updater signature before installation, which materially limits exposure to arbitrary archives. This audit does not demonstrate an exploit against Postal Snap, and advisory severity must not be presented as proven application exploitability. The configured security gate nevertheless fails.

Review compatible updater/dependency changes and the existing 72-hour policy. Keep the advisory deny policy intact; regenerate notices after any lockfile repair. The seven changed direct npm package versions checked during this audit are all older than 72 hours and match their installed versions. Publication ages for every transitive dependency were not re-audited.

Evidence: `artifacts/audit-0.5.0/dependency-audit.log` and `dependency-ages.json`. The official [rustls advisory](https://rustsec.org/advisories/RUSTSEC-2026-0346) confirms the affected version and patched range for that advisory.

### 2. P1 — Save and Preview cannot resolve ordinary partial attachment IDs after downloading the full message

Locations: `src-tauri/src/mail/parse.rs:425`, `:577`, and `:837`; `src-tauri/src/commands/attachments.rs:46`, `:250`, and `:564`.

Partial parsing constructs attachment IDs using declared attachment size, normally zero when the MIME attachment has no `size` parameter. Full parsing uses decoded size. Size participates in the ID hash. Save, Preview, and Save chosen first upgrade the message to a full body, then search the new attachment list using the old ID supplied by the visible partial row. That lookup fails with `Attachment not found.` for the single-file Save path. The UI offers these operations directly on a partial message.

The isolated native probe parses the same synthetic attachment as a prefix and a full message. Its expected identity-preservation assertion fails:

```text
left:  "a460128d9ff0de88728aea90"
right: "032033afb5afbb3c58d24f57"
```

The existing mocked attachment test checks that IPC receives `partial-report`; it does not model the native ID change during the implicit upgrade. Explicitly downloading the full message first updates the UI IDs and provides a workaround.

Preserve attachment identity across upgrades, or resolve an old ID to a validated part before replacing metadata. Retain account/message ownership checks and legacy-ID compatibility. Add native integration coverage for Save/Preview directly from a partial row, including a MIME attachment without a declared size.

### 3. P2 — A completed signature save overwrites newer edits while the editor still displays them

Locations: `src/components/settings/useSettingsAccountManagement.ts:330` and `:338`; `src/components/settings/SignatureEditor.tsx:47`.

The editor stays editable during Save. Its response unconditionally replaces both signature input states with the submitted older value. The rich editor keeps its own document and does not reload from subsequent `html` props. The visible document can therefore contain newer text while the next Save submits older state. The dirty-form guard also compares the replaced state, so it can miss those newer edits.

The browser probe holds the first signature IPC response, changes the editor, releases that response, and presses Save again. All four comfortable/compact × 100%/200% variants fail:

```text
Expected: "New unsaved signature"
Received: "First saved signature"
```

Preserve edits newer than the submitted revision, or disable every signature editing path while saving. Test both successful and failed delayed responses. Keep the visible editor, submitted payload, and dirty-form state consistent.

Evidence: `artifacts/audit-0.5.0/browser-probes.json`; each result directory contains a trace, screenshot, and captured IPC payloads. This reproduces the real React behavior with mocked IPC; it does not depend on a native save dialog.

### 4. P2 — Hover/focus pauses the Undo notice but not the backend's 60-second commit deadline

Locations: `src/components/NoticeRegion.tsx:62`, `src-tauri/src/commands/messages.rs:28` and `:862`, `src-tauri/src/db/offline_ops.rs:192`, and `src-tauri/src/commands.rs:622`.

The frontend pauses its eight-second timeout while hovered or focused. The deferred move receives an absolute `not_before` timestamp 60 seconds ahead. The worker schedules replay at that deadline, regardless of notice interaction. After a sufficiently long hover or focus, Undo remains visible even though the online worker can already have moved the message. The next Undo reports that the move committed.

The existing hover test waits about 19 seconds before resuming the timer. It never crosses the backend deadline. Existing native tests explicitly confirm replay after `not_before` without a frontend commit.

Align the notice lifetime with the durable deadline. Preserve restart recovery without allowing a visible paused action to silently expire. Verify a focused Undo notice beyond 60 seconds against the real actor and TLS fixture. The complete combined scenario was not executed in this audit.

### 5. P2 — A watcher parks without dropping its connection when the server lacks IDLE

Location: `src-tauri/src/mail/watch.rs:315`.

After `connect_dedicated` succeeds, the no-IDLE branch awaits `park` while the authenticated `session` remains in scope. It is dropped only after parking ends and control continues or exits. Parking waits for account removal, credentials, server generation, or sleep changes. A server without IDLE therefore retains an unused second connection throughout that wait.

This wastes a server connection and can block the actor on a one-connection server if the watcher connects first. Connection-limit fallback handles a refused watcher connection, but does not release this successfully authenticated, unusable watcher session.

Drop the session before awaiting `park`. Verify both connection acquisition orders with a no-IDLE server and a strict connection cap. This is a production control-flow finding; the strict-cap native scenario was not executed.

### 6. P2 — Global cache usage omits stored partial bodies and their message count

Location: `src-tauri/src/db/files_cache.rs:169`.

Global usage sums only raw MIME and counts rows with nonempty raw MIME. Partial bodies deliberately store no raw MIME. Per-account usage correctly sums `body_bytes`. Settings can consequently report zero downloaded mail even when partial text/HTML occupies the database. This is a reporting defect; the per-account eviction budget still uses `body_bytes`.

The isolated database probe stores a partial body and compares the two APIs:

```text
global reports 0 bytes; account reports 16 bytes
```

Use consistent body accounting for global and account totals while retaining outbox accounting. Cover partial-only caches, mixed caches, and clearing downloads.

## Coverage and verification

| Area                    | Work performed and evidence boundary                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade and persistence | Reviewed migration ordering and new schema steps 36–39, deferred operation storage, partial-body storage/eviction, account cleanup, and settings persistence. Existing native migration tests pass. No upgrade of a real user's 0.4.3 database was performed.                                                                                                                                            |
| Mail lifecycle          | Reviewed watcher ownership, wake reasons, scoped sync, LIST-STATUS fallback, queued batch replay, source UID identity, body upgrade, and parse-quarantine paths. TLS fixtures exercise watcher append, batched moves, deferred cancellation/commit, interrupted-copy evidence, and answered-before-archive behavior.                                                                                     |
| Security                | Reviewed extracted TLS connection setup, certificate pinning, new rich-signature sanitization, attachment ownership/full-body boundaries, and capability separation. Existing security tests pass. Bundled filter provenance/checksum verification passes. No new sanitizer/SSRF bypass was demonstrated.                                                                                                |
| Draft/outbox            | Reviewed extracted send/attachment/persistence hooks and recovery identity. Existing composer replacement, send uncertainty, draft recovery, and outbox flows run in the full browser suite. No real SMTP delivery or provider archive certification was performed.                                                                                                                                      |
| UI/accessibility        | Full browser suite includes palette, notices, recovery, signature, badge, virtual-list, density, 200% text, forced-colors, and reduced-motion checks. New signature probes cover all four density/text combinations. No manual VoiceOver, NVDA, WKWebView, or WebView2 session was performed. New 0.5.0 specs generally run in Chromium; the selected WebKit project does not include every new feature. |
| Performance             | Reviewed virtual-list range/focus handling, prefetch index, and batched repair. Existing 1,000-row artifacts pass. A repeated simple-tag sanitizer probe measured 71/104/209 ms for 80/160/320 KB; this shape does not reproduce the historical quadratic risk. This is not a complete adversarial MIME or long-session memory benchmark.                                                                |
| Release/tooling         | Format, lint, clippy, policy, IPC, types, release-asset tests, and production build pass. IPC reports 150 commands and one explicit coverage exception. npm audits pass; Cargo audit fails as described above. No release was created or published.                                                                                                                                                      |

Results from this checkout:

- Existing frontend suite: **690 passed**, 42 files.
- Existing Playwright suite: **1,214 passed**, approximately four minutes; Chromium plus the configured selected WebKit flows.
- Existing Rust suite with authorized loopback fixtures: **569 passed, 14 ignored**.
- Cargo safe-update suite with authorized loopback access: **88 passed**.
- Full TLS mail integration: **20 report entries passed**, using pinned GreenMail 2.1.11 plus the synthetic compatibility fixtures. Protocol assertions include additional cases beyond the number of report entries.
- Additional audit probes: **four browser regressions fail**, **two native regressions fail**, and one sanitizer measurement probe passes. These expected failures establish findings; they are not product fixes.
- `npm run test:all` completed but returned failure inside the sandbox: Cargo safe-update and E2E could not bind loopback; native HTTP fixtures also failed there. Each affected suite passed separately with authorized access. The stalled sandbox E2E runner was stopped after the separate full run completed. There is no successful single aggregate `test:all` exit from this audit.

## Reproduce and retain evidence

Evidence directory: `artifacts/audit-0.5.0/` (ignored local artifacts). The tracked report does not embed credentials or real mail. Keep the evidence directory with the report when transferring this audit.

```sh
# Expected: four failed signature assertions, with traces and payloads.
POSTAL_SNAP_E2E_PORT=4198 npm run test:e2e -- \
  --config artifacts/audit-0.5.0/playwright.config.ts

# Expected: two failed assertions, one passing measurement probe.
# Source changes are applied only to a temporary copy.
python3 artifacts/audit-0.5.0/reproduce-native.py

# Current dependency gate is expected to fail.
npm run audit
```

The artifact directory also contains logs for the aggregate gate, authorized component reruns, dependency audit, filter check, native probes, and TLS integration. `mail-integration-results.json` identifies the audited commit and fixture versions. `native-probes.patch` contains only the isolated test additions.

An exploratory assertion that an existing partial message should upgrade when `keepAttachmentsOffline` becomes true was discarded as a product finding. Current settings copy explicitly promises downloads with **new mail**. Existing partial messages remain partial unless explicitly upgraded; changing that behavior is a separate product decision. The command-palette search-field exclusion is also intentional in current tests, although the failure inventory's introductory wording says “everywhere except” the composer editor. Clarify that documentation discrepancy.

## Remaining approval gates

Fix and re-audit the attachment and signature failures before stable promotion. Resolve the dependency audit without broadening advisory exceptions. Then close the Undo/watch scenarios with real actor-level regression coverage and repair cache reporting.

The authoritative release checklist still requires live iCloud smoke, actual Proton Bridge smoke, signed builds for every required architecture, Authenticode/Gatekeeper/notarization/updater verification, entitlements and manifest verification, and clean install/update/mailto/offline-restart/uninstall testing. Windows/Linux target execution, hosted CI, manual assistive-technology checks, real database upgrade/recovery, prolonged sleep/network churn, large real mailboxes, and long-session resource behavior are not established here. Store-train gates remain separate. Mocked UI success and local TLS fixtures do not replace these gates.
