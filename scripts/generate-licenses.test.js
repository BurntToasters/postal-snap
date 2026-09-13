import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectCargoLicenseRows,
  compileCargoLicenseEntries,
  compileCargoLicenseEntry,
  filterNotices,
  readLicenseTextsFromDirectory,
} from "./generate-cargo-licenses.js";
import {
  collectNpmLicenseRows,
  compileNpmLicenseEntries,
} from "./generate-npm-licenses.js";
import { json } from "./lib/json.js";
import { root } from "./lib/paths.js";

test("collectNpmLicenseRows lists dependencies and fails on missing metadata", () => {
  const rows = collectNpmLicenseRows({
    packages: {
      "": { name: "postal-snap", version: "0.1.9" },
      "node_modules/alpha": { version: "1.0.0", license: "MIT" },
      "node_modules/beta": { version: "2.0.0", license: "Apache-2.0" },
    },
  });
  assert.deepEqual(rows, ["alpha 1.0.0 — MIT", "beta 2.0.0 — Apache-2.0"]);
  assert.throws(
    () =>
      collectNpmLicenseRows({
        packages: {
          "": { name: "postal-snap", version: "0.1.9" },
          "node_modules/gamma": { version: "3.0.0" },
        },
      }),
    /gamma@3\.0\.0/,
  );
});

test("compileNpmLicenseEntries keeps production texts and skips the app package", () => {
  const licenses = compileNpmLicenseEntries({
    "postal-snap@0.1.10": {
      licenses: "MPL-2.0",
      licenseText: "app text",
    },
    "alpha@1.0.0": {
      licenses: ["MIT", "Apache-2.0"],
      repository: "https://example.test/alpha",
      licenseText: "alpha text",
    },
  });
  assert.deepEqual(Object.keys(licenses), ["alpha@1.0.0"]);
  assert.equal(licenses["alpha@1.0.0"].licenses, "MIT OR Apache-2.0");
  assert.equal(licenses["alpha@1.0.0"].licenseText, "alpha text");
  assert.throws(
    () =>
      compileNpmLicenseEntries({
        "beta@2.0.0": { licenses: "MIT" },
      }),
    /beta@2\.0\.0/,
  );
});

test("committed npm lockfile has license metadata for every dependency", async () => {
  const lock = await json(join(root, "package-lock.json"));
  const rows = collectNpmLicenseRows(lock);
  assert.ok(rows.length > 0);
});

test("collectCargoLicenseRows accepts license or license_file and fails on neither", () => {
  const rows = collectCargoLicenseRows([
    { name: "alpha", version: "1.0.0", license: "MIT" },
    { name: "beta", version: "2.0.0", license: null, license_file: "LICENSE" },
  ]);
  assert.deepEqual(rows, ["alpha 1.0.0 — MIT", "beta 2.0.0 — LICENSE"]);
  assert.throws(
    () => collectCargoLicenseRows([{ name: "gamma", version: "3.0.0" }]),
    /gamma@3\.0\.0/,
  );
  assert.throws(() => collectCargoLicenseRows([{}]), /unknown@unknown/);
});

test("compileCargoLicenseEntries reads packaged license text and skips the workspace crate", () => {
  const directory = mkdtempSync(join(tmpdir(), "postal-snap-licenses-"));
  writeFileSync(
    join(directory, "LICENSE"),
    "Permission is hereby granted to use this crate.",
  );
  const compiled = compileCargoLicenseEntry({
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
    repository: "https://example.test/alpha",
    manifest_path: join(directory, "Cargo.toml"),
  });
  assert.equal(compiled.licenseTextStatus, "bundled");
  assert.match(compiled.licenseText, /Permission is hereby granted/);
  assert.deepEqual(compiled.licenseReferences, []);

  const missingDir = mkdtempSync(join(tmpdir(), "postal-snap-licenses-empty-"));
  const missing = compileCargoLicenseEntry({
    name: "beta",
    version: "2.0.0",
    license: "Apache-2.0",
    manifest_path: join(missingDir, "Cargo.toml"),
  });
  assert.equal(missing.licenseTextStatus, "not-packaged");
  assert.equal(missing.licenseText, null);
  assert.equal(missing.licenseReferences[0].identifier, "Apache-2.0");

  const entries = compileCargoLicenseEntries(
    [
      {
        id: "workspace",
        name: "postal-snap",
        version: "0.1.10",
        license: "MPL-2.0",
      },
      {
        id: "dep",
        name: "alpha",
        version: "1.0.0",
        license: "MIT",
        manifest_path: join(directory, "Cargo.toml"),
      },
    ],
    new Set(["workspace", "dep"]),
    new Set(["workspace"]),
  );
  assert.deepEqual(Object.keys(entries), ["cargo:alpha@1.0.0"]);
});

test("readLicenseTextsFromDirectory ignores files outside the package directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "postal-snap-licenses-escape-"));
  mkdirSync(join(directory, "nested"));
  writeFileSync(join(directory, "secret.txt"), "ignore");
  assert.equal(
    readLicenseTextsFromDirectory(join(directory, "nested"), "../secret.txt"),
    null,
  );
});

test("generated notices carry filter attribution and every package ships them", async () => {
  for (const pattern of [
    /EasyList/,
    /EasyPrivacy/,
    /TweetFeed/,
    /LICENSE-CC-BY-SA-3\.0\.txt/,
    /LICENSE-CC0-1\.0\.txt/,
  ]) {
    assert.match(filterNotices, pattern);
  }

  const tauriConfig = await json(join(root, "src-tauri/tauri.conf.json"));
  assert.equal(
    tauriConfig.bundle.resources["../THIRD_PARTY_NOTICES.npm.txt"],
    "THIRD_PARTY_NOTICES.npm.txt",
  );
  assert.equal(
    tauriConfig.bundle.resources["../THIRD_PARTY_NOTICES.cargo.txt"],
    "THIRD_PARTY_NOTICES.cargo.txt",
  );
  assert.equal(
    tauriConfig.bundle.resources["../public/licenses.json"],
    "licenses.json",
  );
  assert.equal(
    tauriConfig.bundle.resources["../public/licenses-cargo.json"],
    "licenses-cargo.json",
  );

  const flatpak = await readFile(
    join(root, "packaging/flatpak/run.rosie.snap.yml"),
    "utf8",
  );
  assert.match(flatpak, /THIRD_PARTY_NOTICES\.npm\.txt/);
  assert.match(flatpak, /THIRD_PARTY_NOTICES\.cargo\.txt/);

  const msstore = await readFile(join(root, "scripts/msstore-pack.js"), "utf8");
  assert.match(msstore, /THIRD_PARTY_NOTICES\.npm\.txt/);
  assert.match(msstore, /THIRD_PARTY_NOTICES\.cargo\.txt/);

  const generated = await readFile(
    join(root, "THIRD_PARTY_NOTICES.cargo.txt"),
    "utf8",
  ).catch(() => null);
  if (generated) {
    assert.match(generated, /EasyList/);
    assert.match(generated, /EasyPrivacy/);
    assert.match(generated, /TweetFeed/);
  }
});
