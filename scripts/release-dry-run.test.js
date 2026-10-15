import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDryRun } from "./release-dry-run.js";

test("release dry run passes every scenario offline with a fake gh", async (t) => {
  if (process.platform === "win32") return t.skip("fake gh is a POSIX script");
  const outDir = await mkdtemp(join(tmpdir(), "postal-snap-dry-out-"));
  try {
    const summary = await runDryRun({ outDir });
    for (const s of summary.scenarios) {
      for (const c of s.checks) assert.ok(c.ok, `${s.id}: ${c.name}`);
    }
    assert.equal(summary.scenarios.length, 5);
    const saved = JSON.parse(
      await readFile(join(outDir, "summary.json"), "utf8"),
    );
    assert.equal(saved.ok, true);
    // Repeatable: a second run writes identical call logs.
    const again = await mkdtemp(join(tmpdir(), "postal-snap-dry-out-"));
    await runDryRun({ outDir: again });
    const a = await readFile(
      join(outDir, "stable-with-newer-beta", "gh-calls.json"),
      "utf8",
    );
    const b = await readFile(
      join(again, "stable-with-newer-beta", "gh-calls.json"),
      "utf8",
    );
    assert.equal(a, b);
    await rm(again, { recursive: true, force: true });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
