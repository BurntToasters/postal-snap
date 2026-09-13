import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assertTopChangelogVersion, topChangelogVersion } from "./changelog.js";
import { json } from "./json.js";
import { root } from "./paths.js";

test("topChangelogVersion reads the first Changes section", () => {
  const markdown = [
    "# Changelog",
    "",
    "## Changes in `v0.1.9:`",
    "",
    "- newest",
    "",
    "## Changes in `v0.1.8:`",
    "",
    "- older",
    "",
  ].join("\n");
  assert.equal(topChangelogVersion(markdown), "0.1.9");
  assert.equal(topChangelogVersion("# Changelog\n"), null);
});

test("assertTopChangelogVersion fails loudly on a version mismatch", () => {
  assert.equal(
    assertTopChangelogVersion("## Changes in `v0.2.0:`\n", "0.2.0"),
    "0.2.0",
  );
  assert.throws(
    () => assertTopChangelogVersion("## Changes in `v0.1.9:`\n", "0.2.0"),
    /top section is v0\.1\.9 but package\.json is v0\.2\.0/,
  );
  assert.throws(
    () => assertTopChangelogVersion("# Changelog\n", "0.2.0"),
    /has no "## Changes in/,
  );
  assert.throws(
    () => assertTopChangelogVersion("## Changes in `v0.2.0:`\n", ""),
    /package version is missing/,
  );
});

test("committed changelog top section matches package.json", async () => {
  const pkg = await json(join(root, "package.json"));
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  assert.equal(topChangelogVersion(changelog), pkg.version);
});
