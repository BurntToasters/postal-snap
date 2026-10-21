# Dependency update safety

`npm run u` is a lockfile-only dependency proposal. It does not install npm packages, run npm lifecycle scripts, compile Rust, execute Cargo build scripts or procedural macros, format source files, or run tests.

The command does not update `node_modules` or bump the application version. It synchronizes the existing version from `package.json` into the Tauri manifests after updating the lockfiles. After reviewing the lockfile changes, an isolated development environment must run `npm ci --ignore-scripts` before starting the app; otherwise the installed JavaScript packages can be older than the lockfile and Tauri may reject mismatched plugin versions.

The command requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`, npm 12.0.1 or newer, and an already-installed Rust 1.97.1 toolchain. It performs these steps:

1. Resolve npm updates with `--package-lock-only`, `--ignore-scripts`, and a three-day minimum release age in a disposable npm cache.
2. Reject high-severity npm audit findings without populating the project `node_modules` directory.
3. Resolve Cargo updates through the local crates.io age-filter proxy in a disposable Cargo home.
4. Reject releases younger than 72 hours, unknown registries, unapproved Git revisions, concurrent lock edits, and unverifiable publication metadata.
5. Atomically install only the validated lockfile and remove temporary caches.

Both updaters serialize their own runs. Lock installation and rollback compare expected bytes, preserving a concurrent process's lockfile edit instead of overwriting it. Cargo resolution and validation failures leave the real lockfile untouched; rollback after installation restores the original only when the file still matches the exact candidate bytes written by the updater.

Review both lockfile diffs before committing. Local validation after a lockfile change is allowed: run `npm ci --ignore-scripts`, then the usual checks (`npm run test:all`, Cargo checks, and builds).

The hard rule is the three-day (72-hour) minimum release age for both npm and Cargo, applied to direct and transitive packages. It is the guard against newly published supply-chain attacks. Keep `min-release-age=3` and `ignore-scripts=true` in `.npmrc`, and do not lower the age or bypass the check except through the emergency override below.

The three-day delay reduces exposure to newly published supply-chain attacks; it cannot prove that an older package is benign. Emergency young-crate and Git overrides must name one exact version or revision and include a written reason.

An approved npm compatibility or security repair may use a one-command,
package-scoped young-release exception only when the requested package is
pinned to an exact version in both the command and `package.json`. Keep
`--min-release-age=3`, pass
`--min-release-age-exclude=<package>` only to that targeted
`npm install <package>@<version> --package-lock-only --ignore-scripts
--save-exact` invocation, and review the lock diff to confirm no other package
version changed. Record the exact publication time, 72-hour eligibility time,
and reason in the remediation note. Never persist the exclusion in `.npmrc`.

## Cargo source transition safety

Cargo dependency changes go through `scripts/cargo-safe-update.mjs`. The helper
uses a disposable Cargo home, checks every new crates.io package against the
72-hour publish-age rule, requires exact package overrides with a written reason
for emergency young crates or Git revisions, and installs a candidate lockfile
only after validation. Ordinary lock-only updates derive their baseline from
the current manifest and lock using `cargo metadata --locked`.

## Failure inventory for manifest source transitions

The helper originally derived its baseline by running `cargo metadata --locked`
on the edited manifest and current lockfile. When a dependency changes source,
such as crates.io to a pinned Git revision, Cargo rejects that baseline before
the helper can compare old and new package selections. Removing `--locked`
would let Cargo resolve the edited graph as its own baseline and hide the source
change.

The transition workflow must cover these failures:

- A source transition without an explicit old manifest must stop before any
  lockfile installation and leave the original lockfile byte-for-byte intact.
- A missing or mismatched baseline manifest must fail closed against the
  existing lockfile and workspace package identities.
- A candidate Git source without its exact commit override, or a young registry
  version without its exact version override, must be rejected without changing
  the real lockfile.
- A valid source transition must compare the intended candidate graph against
  metadata from a disposable copy containing the explicit old manifest and the
  original lockfile. The candidate graph must use the intended current manifest.
- The ordinary locked update path must keep working when no manifest transition
  needs review. Cargo must continue to run with `--locked` for baseline and
  final metadata; the helper must retain its lock snapshot and concurrent-edit
  protection.

Regression coverage is in `scripts/cargo/safe-update.test.mjs`. It exercises a
local Git source transition without external packages, baseline rejection,
normal locked updates, and lock preservation on policy denial.

For a reviewed manifest source transition, save the previous manifest from a
trusted revision and pass it explicitly:

```sh
git show <reviewed-commit>:src-tauri/Cargo.toml > /private/tmp/postal-snap-dependencies-baseline.Cargo.toml
node scripts/cargo-safe-update.mjs \
  --manifest-path src-tauri/Cargo.toml \
  --baseline-manifest-path /private/tmp/postal-snap-dependencies-baseline.Cargo.toml \
  --package <crate-name> \
  --allow-git <crate-name>@<full-commit> \
  --reason "<why this exact source revision is required>"
```

The helper copies the workspace and original lockfile, substitutes the explicit
baseline manifest only in that copy, and validates it with `cargo metadata
--locked`. Candidate resolution uses the current manifest and a separate
temporary lockfile. Baseline package identities must match the candidate
workspace. Missing, invalid, or mismatched baselines fail before installing a
lockfile. The helper never drops `--locked` to derive a baseline.
