# Dependency audit for 0.5.4

The baseline online audit is recorded in the local evidence at `artifacts/0.5.4/dependency-before.log` for commit `c84824a`. It found nine Rust advisories and one denied maintenance warning. This remediation preserves `scripts/audit-cargo.js` and the RustSec deny policy.

## Failure criteria

The dependency change must pass the existing publication-age, source and checksum policy, the online npm and RustSec gates, and license generation. The comparison includes the production npm dependency tree, TLS mail submission, upgrades of populated SQLite databases, persisted timestamp ordering and the vendored IMAP test suite. A change to the advisory allowlist or minimum package age would invalidate the comparison.

## Baseline

The starting online audit identifies `cookie 0.18.2` (fixed in 0.18.3), `lettre 0.11.23` (fixed in 0.11.24; six advisories), `libsqlite3-sys 0.38.2` (fixed in 0.39.0), and `url 2.5.8` (fixed in 2.5.9), plus denied `chrono 0.4.45` unmaintained warning.

The first sandboxed RustSec run could not lock its advisory cache. The permitted online rerun scanned the lockfile and produced the advisory findings. The initial Cargo policy check passed. License generation counted 703 Cargo entries, including 49 packages with SPDX metadata and no bundled license text.

## Results

The safe updater accepted the fixed and age-eligible updates. The lockfile now contains `lettre 0.11.24`, `url 2.5.9`, and the required transitive `form_urlencoded 1.2.3`; the updater recorded ages of 205h and 127h for the fixed direct packages. It then validated an explicit manifest transition from the trusted `c84824a` baseline: `rusqlite 0.40.2` to `0.41.1` and `libsqlite3-sys 0.38.2` to `0.39.1`, at 684h and 769h old. The lock entries include the checksums verified by `scripts/cargo-safe-update.mjs`. No advisory allowlist or age override changed.

The initial SQLite graph update used an unchanged copy of the starting manifest as its baseline.

```sh
git show c84824a:src-tauri/Cargo.toml > "$TMPDIR/postal-054-baseline.toml"
node scripts/cargo-safe-update.mjs --manifest-path src-tauri/Cargo.toml --baseline-manifest-path "$TMPDIR/postal-054-baseline.toml" --package rusqlite
```

`cargo check --locked --manifest-path src-tauri/Cargo.toml` passed after the rusqlite transition. The targeted intermediate online audit scanned 704 crate dependencies and was still red only for `cookie 0.18.2` and denied `chrono 0.4.45` unmaintained. `npm run check:cargo-update-policy` passed. `npm run licenses:cargo` passed, wrote 703 entries, and produced no tracked license-file diff; its existing 49-package missing-license-text warning remains.

### Cookie and the publication-age policy

The crates.io index records publication of `cookie 0.18.3` at `2026-11-23T07:45:48Z`. The safe updater correctly selected zero new versions when run before its 72-hour eligibility time. After `2026-11-26T07:45:48Z`, the same package-scoped command accepted 0.18.3 with SHA-256 `d55f2d6c30eeec7d5c6f98bd4395d4abb1895629eab97ee6522d340623615f8a`. [Crates.io index record](https://index.crates.io/co/ok/cookie).

### Timestamps and the IMAP fork

The starting all-features graph reached Chrono through the application, rusqlite's optional adapter and async-imap. Both published async-imap versions reviewed, 0.11.3 and 0.12.0, retain the mandatory dependency. Postal Snap now uses its existing `time 0.3.55` dependency, removes the unused rusqlite feature and uses `OffsetDateTime` in its existing IMAP fork. [Vendored patch notes](../../src-tauri/vendor/async-imap/POSTAL-SNAP.md).

The compatibility probe compared the two implementations on stored RFC 3339 timestamps, lexical queue ordering, offset-normalized seconds, fractional precision, UTC year boundaries, mail headers, INTERNALDATE variants, padded mbox separators and local quiet hours across daylight-saving changes. The migration keeps existing SQLite strings readable. Local probe inputs and outputs are under `artifacts/0.5.4/chrono/`.

### Inactive optional dependency in the lockfile

After the application migration, the all-features, all-targets build had no active Chrono dependency. The strict RustSec scan still found an optional dependency recorded under `serde_with` in the application lock. An age-eligible 3.25.0 upgrade in a disposable checkout retained that edge and reproduced the denied advisory.

The candidate selects a local patch of the published `serde_with 3.24.0`. The upstream archive SHA-256 is `df9adc193c780ef8f159aee8b61e2d5801aaa555e6eb0947fe45530ec506296f`. The patch removes the optional Chrono adapter and its feature references, documentation and tests. MIT and Apache-2.0 license files are byte-identical to the registry archive. The application keeps the upstream std, alloc and macro features. This creates a maintenance obligation when upgrading Tauri or serde_with. Recheck the upstream lock edge before carrying the patch forward. [Patch details](../../src-tauri/vendor/serde_with/POSTAL-SNAP.md).

The safe source transition removed Chrono and its redundant timezone packages from the application lock. The strict online audit subsequently scanned 701 entries and passed. The existing RustSec exceptions and publication-age rules remain in place.

### JavaScript dependencies

Targeted development-tool overrides update the glob and minimatch paths used by lint, license reporting and coverage. The production npm lock entries are unchanged. A clean install audited with zero vulnerabilities in both production and development. The starting lock's production signature check verified 75 signatures and 53 attestations. Full signature verification, required by Linux CI, failed because the registry returned plain text for the attestation of `typescript-eslint@8.72.2`. A fresh cache and the CI version of npm reproduced the failure. The final lock moves the 11 lint-tool entries to age-eligible 8.73.0 within the existing package range. With a fresh install, both npm 12.2.1 and 12.2.2 verified all 395 signatures and 178 attestations. The full vulnerability audit and lint also passed. [Linux workflow](../../.github/workflows/ci.yml).

The integrated notices contain 75 npm and 700 Cargo packages. Both upstream licenses are included for the local serde_with package. The same 49 Cargo packages as the baseline supply SPDX metadata without packaged license text. The local comparison is recorded in `artifacts/0.5.4/cargo-license-metadata-final.json`.
