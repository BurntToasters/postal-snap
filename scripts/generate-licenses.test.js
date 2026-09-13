import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { collectCargoLicenseRows } from "./generate-cargo-licenses.js";
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
