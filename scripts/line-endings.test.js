import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("gitattributes forces LF so Windows prettier --check matches CI", () => {
  const attributes = readFileSync(
    new URL("../.gitattributes", import.meta.url),
    "utf8",
  );
  assert.match(attributes, /^\*\s+text=auto\s+eol=lf\s*$/m);
  assert.doesNotMatch(attributes, /\.(?:png|ico|icns)\s+text\b/);
});

test("prettier pins LF without changing quote or semicolon style", () => {
  const prettier = JSON.parse(
    readFileSync(new URL("../.prettierrc", import.meta.url), "utf8"),
  );
  assert.equal(prettier.endOfLine, "lf");
  assert.equal(prettier.singleQuote, undefined);
});
