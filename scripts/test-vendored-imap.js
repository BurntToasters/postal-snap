import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { join, process, root } from "./lib/paths.js";
import { rmRetry, run } from "./lib/spawn.js";

const vendoredCrate = join(root, "src-tauri/vendor/async-imap");
const workspaceLock = join(root, "src-tauri/Cargo.lock");
const stableTargetDir = join(root, "src-tauri/target/vendored-imap-tests");

const PRETTY_ASSERTIONS_DEV_BLOCK = `[dev-dependencies.pretty_assertions]
version = "1.2"
`;

const DEV_ASYNC_STD_FEATURES = `version = "1.8.0"
features = [
    "std",
    "attributes",
]`;

const DEV_ASYNC_STD_OFFLINE = `version = "1.8.0"
default-features = false
features = ["std"]`;

const PRETTY_ASSERTIONS_USE = "    use pretty_assertions::assert_eq;\n";

/** @param {string} text */
export function adjustVendoredImapCargoToml(text) {
  if (!text.includes(PRETTY_ASSERTIONS_DEV_BLOCK)) {
    throw new Error(
      "vendored async-imap Cargo.toml no longer contains the expected pretty_assertions dev-dependency block",
    );
  }
  if (!text.includes(DEV_ASYNC_STD_FEATURES)) {
    throw new Error(
      "vendored async-imap Cargo.toml no longer contains the expected dev-dependencies.async-std feature list",
    );
  }
  let next = text.replace(PRETTY_ASSERTIONS_DEV_BLOCK, "");
  next = next.replace(DEV_ASYNC_STD_FEATURES, DEV_ASYNC_STD_OFFLINE);
  if (next.includes(PRETTY_ASSERTIONS_DEV_BLOCK)) {
    throw new Error(
      "pretty_assertions dev-dependency block was not fully removed",
    );
  }
  if (next.includes(DEV_ASYNC_STD_FEATURES)) {
    throw new Error(
      "dev-dependencies.async-std block was not adjusted for standalone lib tests",
    );
  }
  return next;
}

/** @param {string} text */
export function adjustVendoredImapClientSource(text) {
  if (!text.includes(PRETTY_ASSERTIONS_USE)) {
    throw new Error(
      "vendored async-imap src/client.rs no longer imports pretty_assertions in tests",
    );
  }
  return text.replace(PRETTY_ASSERTIONS_USE, "");
}

async function prepareScratchCrate(scratchRoot) {
  const crateDir = join(scratchRoot, "crate");
  await cp(vendoredCrate, crateDir, { recursive: true, force: true });
  await cp(workspaceLock, join(crateDir, "Cargo.lock"), { force: true });

  const tomlPath = join(crateDir, "Cargo.toml");
  const clientPath = join(crateDir, "src/client.rs");
  await writeFile(
    tomlPath,
    adjustVendoredImapCargoToml(await readFile(tomlPath, "utf8")),
  );
  await writeFile(
    clientPath,
    adjustVendoredImapClientSource(await readFile(clientPath, "utf8")),
  );
  return crateDir;
}

/**
 * Uses the copied workspace Cargo.lock for shared dependency versions; cargo may
 * extend that lock with scratch-only dev-deps. Set CARGO_NET_OFFLINE=true to
 * require an already-populated cache (no `--offline` flag here).
 *
 * @param {string} crateDir
 */
async function runVendoredImapLibTests(crateDir) {
  await run(
    "cargo",
    [
      "test",
      "--no-default-features",
      "--features",
      "runtime-tokio",
      "--lib",
      "--target-dir",
      stableTargetDir,
    ],
    { cwd: crateDir },
  );
}

export async function runVendoredImapGate() {
  const scratchRoot = await mkdtemp(
    join(tmpdir(), "postal-snap-vendored-imap-"),
  );
  try {
    const crateDir = await prepareScratchCrate(scratchRoot);
    await runVendoredImapLibTests(crateDir);
  } finally {
    await rmRetry(scratchRoot, { recursive: true });
  }
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  runVendoredImapGate().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
