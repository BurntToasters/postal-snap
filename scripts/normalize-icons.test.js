import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("icons:normalize keeps desktop and padded macOS sources distinct", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/normalize-icons.js"),
    "utf8",
  );
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  assert.equal(scripts["icons:normalize"], "node scripts/normalize-icons.js");
  assert.match(script, /app-icon\.png/);
  assert.match(script, /app-icon-macos\.png/);
  assert.match(script, /icon\.icns/);
  assert.doesNotMatch(script, /icon\.svg/);
  assert.ok(existsSync(path.join(repoRoot, "src-tauri/icons/app-icon.png")));
  assert.ok(
    existsSync(path.join(repoRoot, "src-tauri/icons/app-icon-macos.png")),
  );
});
