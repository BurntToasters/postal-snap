import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustVendoredImapCargoToml,
  adjustVendoredImapClientSource,
} from "./test-vendored-imap.js";

const SAMPLE_TOML = `[dev-dependencies.async-std]
version = "1.8.0"
features = [
    "std",
    "attributes",
]

[dev-dependencies.pretty_assertions]
version = "1.2"
`;

test("adjustVendoredImapCargoToml strips offline-only dev deps", () => {
  const adjusted = adjustVendoredImapCargoToml(SAMPLE_TOML);
  assert.ok(!adjusted.includes("pretty_assertions"));
  assert.match(adjusted, /default-features = false\nfeatures = \["std"\]/);
});

test("adjustVendoredImapCargoToml rejects unexpected manifest text", () => {
  assert.throws(
    () => adjustVendoredImapCargoToml('[package]\nname = "async-imap"\n'),
    /pretty_assertions/,
  );
});

test("adjustVendoredImapClientSource removes pretty_assertions import", () => {
  const source = "mod tests {\n    use pretty_assertions::assert_eq;\n}\n";
  assert.equal(adjustVendoredImapClientSource(source), "mod tests {\n}\n");
});

test("adjustVendoredImapClientSource rejects missing import", () => {
  assert.throws(
    () => adjustVendoredImapClientSource("fn main() {}\n"),
    /pretty_assertions/,
  );
});
