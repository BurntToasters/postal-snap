import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { json, root } from "./_utils.js";
import {
  cargoTomlPackageName,
  replaceCargoLockPackageVersion,
  replaceCargoTomlVersion,
} from "./sync-version.js";

test("replaceCargoTomlVersion updates the package version line", () => {
  const cargo = '[package]\nname = "postal-snap"\nversion = "0.1.1"\n';
  assert.equal(
    replaceCargoTomlVersion(cargo, "0.1.2"),
    '[package]\nname = "postal-snap"\nversion = "0.1.2"\n',
  );
});

test("replaceCargoLockPackageVersion updates only the named package", () => {
  const lock = `[[package]]
name = "other"
version = "0.1.1"

[[package]]
name = "postal-snap"
version = "0.1.1"
dependencies = [
 "tokio",
]
`;
  assert.equal(
    replaceCargoLockPackageVersion(lock, "postal-snap", "0.1.2"),
    `[[package]]
name = "other"
version = "0.1.1"

[[package]]
name = "postal-snap"
version = "0.1.2"
dependencies = [
 "tokio",
]
`,
  );
});

test("replaceCargoLockPackageVersion fails closed when the package is missing", () => {
  assert.throws(
    () =>
      replaceCargoLockPackageVersion(
        'version = "0.1.1"\n',
        "postal-snap",
        "0.1.2",
      ),
    /missing a \[\[package\]\] entry/,
  );
});

test("committed package versions stay aligned for locked cargo commands", async () => {
  const pkg = await json(join(root, "package.json"));
  const tauri = await json(join(root, "src-tauri/tauri.conf.json"));
  const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
  const lock = await readFile(join(root, "src-tauri/Cargo.lock"), "utf8");
  const packageName = cargoTomlPackageName(cargo);
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lockVersion = lock.match(
    new RegExp(
      `^\\[\\[package\\]\\]\\r?\\nname = "${packageName}"\\r?\\nversion = "([^"]+)"`,
      "m",
    ),
  )?.[1];

  assert.equal(tauri.version, pkg.version);
  assert.equal(cargoVersion, pkg.version);
  assert.equal(lockVersion, pkg.version);
});
