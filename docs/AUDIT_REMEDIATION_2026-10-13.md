# October 13 audit remediation

This records the continued remediation of the October 13 audit, including the changes already present when the continuation began. It is not a release approval. The original audit is preserved under `artifacts/codebase-audit-2026-10-13/`.

## Numbered findings

| Finding                             | Current implementation                                                                                                                                                                           | Remaining boundary                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Notification ordering            | Inbox arrival IDs replace sender-controlled dates when selecting a new unread message.                                                                                                           | Alerts still summarize one newest unread arrival per pass.                                                                                                               |
| 2. Skipped filter rules             | A durable per-account watermark is recorded before sync. Failed passes, interrupted passes, incomplete rule application, and full 100-message batches retain it.                                 | Rules still operate on unread Inbox messages.                                                                                                                            |
| 3. Lost edits on quit               | Native Quit routes through the composer flush. Failed or timed-out saves keep the window open. Repeated Quit shares one operation; edits during the final save trigger another save before exit. | Native OS termination and forced process kills cannot promise a final save. Signed desktop close/menu behavior remains a manual gate.                                    |
| 4. Hidden recipients                | Nonempty Cc/Bcc fields stay visible; toggles show recipient counts.                                                                                                                              | Both densities and 100%/200% text are covered by browser tests.                                                                                                          |
| 5. Prose-dependent errors           | Sync authentication, reader body states, and archive follow-up decisions use explicit failure kinds. Typed mail errors preserve their category when converted to IPC errors.                     | Schema 35 stores known outbox reasons as codes. Unknown legacy details remain readable; legacy IPC prose conversion stays at compatibility boundaries.                   |
| 6. Blocking database access         | Whole database operations use a shared Tokio blocking-work boundary, covering query execution and contended locks.                                                                               | The app uses a multithread runtime. Synchronous current-thread callers run inline; this interface does not promise cooperative scheduling in a current-thread embedding. |
| 7. Empty UID ranges                 | Catch-up searches existing UIDs and fetches bounded chunks of those IDs.                                                                                                                         | Real-provider behavior still needs the signing-host smoke tests.                                                                                                         |
| 8. Older server mail                | After local pagination is exhausted, the list offers Download older mail.                                                                                                                        | Mocked tests cover invocation and exhaustion; native integration covers protocol operations separately.                                                                  |
| 9. Compaction failures              | Account removal reports deferred cleanup. Reset and cache clearing surface failure. Failed compaction creates a startup retry marker.                                                            | Filesystem failure can also prevent writing the marker; no secure-erasure guarantee is made while cleanup remains pending.                                               |
| 10. Risky attachments               | Expanded extension checks inspect the stored attachment filename as well as the chosen filename.                                                                                                 | Native file dialogs and platform quarantine metadata need packaged-app checks.                                                                                           |
| 11. Sanitizer serializer dependency | A fixed regression pins escaping of tag-like text inside attributes.                                                                                                                             | DOMPurify and the iframe sandbox remain required defenses.                                                                                                               |
| 12. SMTP pre-transfer failures      | Definite pre-transfer client errors are classified as not sent. Network uncertainty remains non-retryable without user action.                                                                   | Live provider failures remain separate from local TLS fixtures.                                                                                                          |

## Lower-priority findings

Implemented: obsolete archive-undo state removed; `list_all_mailboxes` documentation corrected; new OAuth sign-in refused without the optional Cargo feature; App Nap suppression scoped to work; server search yields between mailboxes; native shortcut guard includes plain text inputs; list columns are stored and refreshed during writes. Alias updates and their derived list columns now commit in one transaction.

The browser suite includes a focused WebKit project for reader, print, typing, quit, recipients, older-mail, manual-image, outbox-reason, and native-command flows. CI rejects flaky results even when retries pass. The HTML report and per-test IPC attachments provide repeatable browser evidence.

`npm run check:ipc-contract` compares native registrations with mock registrations and rejects stale mocks, missing mocks, and stale exceptions. It checks command names, not payload types or native behavior. The only coverage exception is feature-disabled OAuth sign-in. New browser flows cover single/all file saving, attached-message forwarding, single-message copy, cache erasure confirmation, saved-account connection tests, and the native transparency preference. Mocks verify frontend behavior and command ownership arguments; they do not prove native dialogs, TLS, or filesystem behavior.

Mailbox paging and search now live in `useMailboxMessages`; composer autosave, explicit save, replacement saves, and quit flushing live in `useComposerDraftPersistence`; remote-image loading lives in `useRemoteImages`. The migration driver runs a table of version-specific functions inside one transaction. Existing SQL, ordering, attachment references, and rollback behavior are preserved.

At the maintainer's request, remote images load only after an explicit per-message click. Remembered sender addresses no longer trigger network requests. The Always load control and allow-list editor are removed; old `imageSenders` settings are retained for compatibility and ignored by the reader. Automatic loading stays parked until trustworthy sender authentication exists.

Schema 35 adds `outbox.reason_code`. It converts exact known legacy guidance to codes without changing delivery state, MIME, schedule, or attachment ownership. Unknown legacy details are preserved. New delivery decisions use `OutboxReason`; the frontend catalog renders recognized codes. Legacy IPC still exposes compatible detail text. Older builds refuse this newer schema rather than attempting a destructive downgrade.

Further decomposition and conversion of noncritical legacy string errors can continue incrementally. They are not used to decide authentication parking, reader body failure states, archive follow-up outcomes, or new outbox delivery reasons.

## Additional screenshot finding

At 200% text, the compact mailbox title/count could overlap Select and More actions. The heading now wraps its text and action groups when needed; long titles can break within the available width. Geometry assertions and screenshots cover comfortable/compact density, 100%/200% text, and right/bottom/hidden pane modes in Chromium and WebKit. The mailbox and reader bars share their natural height and shrink after live settings changes. Measurements are scheduled outside ResizeObserver callbacks to prevent observer-loop errors. The reader toolbar's translucent sticky scroll edge is intentional and remains unchanged.

## Repeatable verification

```sh
npm run test:all
npm run test:mail-integration
npm run check:ipc-contract
```

Install the pinned Chromium and WebKit browsers with `npm run setup:e2e` before the browser gate. The mail integration command uses local GreenMail 2.1.11 TLS and compatibility fixtures, not real mailbox credentials. Its report is `artifacts/mail-integration/results.json`.

The continuation's final gate log, regression failure logs, hashes, and validation record are saved under `artifacts/codebase-audit-2026-10-13/continuation/`. Browser artifacts are in `playwright-report/` and `test-results/`.

Online npm audits and the configured RustSec audit passed during this continuation. Release gates remain authoritative in `docs/RELEASE_CHECKLIST.md`: real iCloud/Bridge accounts, signed artifacts on every required platform, installation/update behavior, and native accessibility checks remain unverified.
