import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("pre-commit routes npm through cmd.exe on Windows", () => {
  const hook = readFileSync(
    new URL("./hooks/pre-commit", import.meta.url),
    "utf8",
  );
  assert.match(hook, /cmd\.exe \/\/d \/\/c npm\.cmd/);
  assert.match(hook, /npm\.cmd "\$@"/);
  assert.doesNotMatch(hook, /^npm run /m);
});
