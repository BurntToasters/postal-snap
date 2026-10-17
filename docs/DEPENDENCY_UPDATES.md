# Dependency update safety

`npm run u` is a lockfile-only dependency proposal. It does not install npm packages, run npm lifecycle scripts, compile Rust, execute Cargo build scripts or procedural macros, format source files, or run tests.

The command does not update `node_modules` or bump the application version. It synchronizes the existing version from `package.json` into the Tauri manifests after updating the lockfiles. After reviewing the lockfile changes, an isolated development environment must run `npm ci --ignore-scripts` before starting the app; otherwise the installed JavaScript packages can be older than the lockfile and Tauri may reject mismatched plugin versions.

The command requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`, npm 12.0.1 or newer, and an already-installed Rust 1.97.1 toolchain. It performs these steps:

1. Resolve npm updates with `--package-lock-only`, `--ignore-scripts`, and a three-day minimum release age in a disposable npm cache.
2. Reject high-severity npm audit findings without populating the project `node_modules` directory.
3. Resolve Cargo updates through the local crates.io age-filter proxy in a disposable Cargo home.
4. Reject releases younger than 72 hours, unknown registries, unapproved Git revisions, concurrent lock edits, and unverifiable publication metadata.
5. Atomically install only the validated lockfile and remove temporary caches.

Both updaters serialize their own runs. npm rollback and final Cargo lock installation compare expected bytes, preserving a concurrent process's lockfile edit instead of overwriting it.

Review both lockfile diffs before committing. Local validation after a lockfile change is allowed: run `npm ci --ignore-scripts`, then the usual checks (`npm run test:all`, Cargo checks, and builds).

The hard rule is the three-day (72-hour) minimum release age for both npm and Cargo, applied to direct and transitive packages. It is the guard against newly published supply-chain attacks. Keep `min-release-age=3` and `ignore-scripts=true` in `.npmrc`, and do not lower the age or bypass the check except through the emergency override below.

The three-day delay reduces exposure to newly published supply-chain attacks; it cannot prove that an older package is benign. Emergency young-crate and Git overrides must name one exact version or revision and include a written reason.
