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

test("format:check excludes shared lint-comments.mjs tooling like IYERIS", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["format", "format:check"]) {
    const script = packageJson.scripts[name];
    assert.match(script, /scripts\/\*\*\/\*\.js/);
    assert.doesNotMatch(script, /\.mjs/);
  }
  assert.match(packageJson.scripts.lint, /lint:comments/);
  assert.match(packageJson.scripts["lint:comments"], /lint-comments\.mjs/);
});
