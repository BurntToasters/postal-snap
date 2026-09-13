import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  collectCargoLicenseRows,
  filterNotices,
} from "./generate-cargo-licenses.js";
import { collectNpmLicenseRows } from "./generate-npm-licenses.js";
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
