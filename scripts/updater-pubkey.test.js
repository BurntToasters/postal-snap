import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { json, root } from "./_utils.js";
import {
  PLACEHOLDER_UPDATER_PUBLIC_KEY,
  isMinisignPublicKey,
  isPlaceholderUpdaterPublicKey,
  resolveUpdaterPublicKey,
} from "./updater-pubkey.js";
import {
  applyApplePasswordCompatibility,
  assertAppleSigningIdentityAvailable,
} from "./tauri-signing-env.js";

const realKey =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdFQjRGQUVGRDc4MEZFRTgKUldUby9vRFg3L3EwZm9CaWhVc2pFY3VyOVhwTFRWMVlScHpLc1M2RXAzVWJXTjdlcTl5NWtTKzgK";

test("committed updater pubkey is a real minisign key", async () => {
  const config = await json(join(root, "src-tauri/tauri.conf.json"));
  const pubkey = config.plugins?.updater?.pubkey;
  assert.equal(isPlaceholderUpdaterPublicKey(pubkey), false);
  assert.equal(isMinisignPublicKey(pubkey), true);
  assert.notEqual(pubkey, PLACEHOLDER_UPDATER_PUBLIC_KEY);
});

test("signed builds reject a placeholder updater pubkey", () => {
  assert.throws(
    () =>
      resolveUpdaterPublicKey({
        committed: PLACEHOLDER_UPDATER_PUBLIC_KEY,
        fromEnv: PLACEHOLDER_UPDATER_PUBLIC_KEY,
        requireSigning: true,
      }),
    /still a placeholder/,
  );
  assert.throws(
    () =>
      resolveUpdaterPublicKey({
        committed: PLACEHOLDER_UPDATER_PUBLIC_KEY,
        fromEnv: "",
        requireSigning: true,
      }),
    /placeholder/,
  );
  assert.throws(
    () =>
      resolveUpdaterPublicKey({
        committed: PLACEHOLDER_UPDATER_PUBLIC_KEY,
        fromEnv: realKey,
        requireSigning: true,
      }),
    /does not match|placeholder/,
  );
});

test("signed builds use the committed key when TAURI_UPDATER_PUBLIC_KEY is unset", () => {
  assert.equal(
    resolveUpdaterPublicKey({
      committed: realKey,
      fromEnv: "",
      requireSigning: true,
    }),
    realKey,
  );
  assert.equal(
    resolveUpdaterPublicKey({
      committed: realKey,
      fromEnv: undefined,
      requireSigning: true,
    }),
    realKey,
  );
});

test("signed builds require the env pubkey to match tauri.conf.json when set", () => {
  assert.equal(
    resolveUpdaterPublicKey({
      committed: realKey,
      fromEnv: `  ${realKey}  `,
      requireSigning: true,
    }),
    realKey,
  );
  assert.throws(
    () =>
      resolveUpdaterPublicKey({
        committed: realKey,
        fromEnv:
          "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZDNzY0QzNGQTREMDVENjMKUldSalhkQ2tQMHgyL0Q1MzVEckJXU05jS0ZMa2lqOGdGZnoxTHpYL1J5Y2JhdFVwNzY1bmFreEIK",
        requireSigning: true,
      }),
    /does not match/,
  );
});

test("unsigned builds use the committed key instead of the placeholder", () => {
  assert.equal(
    resolveUpdaterPublicKey({
      committed: realKey,
      fromEnv: undefined,
      requireSigning: false,
    }),
    realKey,
  );
  assert.throws(
    () =>
      resolveUpdaterPublicKey({
        committed: PLACEHOLDER_UPDATER_PUBLIC_KEY,
        fromEnv: undefined,
        requireSigning: false,
      }),
    /real Tauri updater public key/,
  );
  assert.throws(
    () =>
      resolveUpdaterPublicKey({
        committed: realKey,
        fromEnv:
          "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZDNzY0QzNGQTREMDVENjMKUldSalhkQ2tQMHgyL0Q1MzVEckJXU05jS0ZMa2lqOGdGZnoxTHpYL1J5Y2JhdFVwNzY1bmFreEIK",
        requireSigning: false,
      }),
    /does not match/,
  );
});

test("Apple app-specific password is accepted as APPLE_PASSWORD", () => {
  const env = { APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop" };
  applyApplePasswordCompatibility(env);
  assert.equal(env.APPLE_PASSWORD, "abcd-efgh-ijkl-mnop");
  const alreadySet = {
    APPLE_PASSWORD: "keep-me",
    APPLE_APP_SPECIFIC_PASSWORD: "ignore-me",
  };
  applyApplePasswordCompatibility(alreadySet);
  assert.equal(alreadySet.APPLE_PASSWORD, "keep-me");
});

test("macOS signing identity must exist in the keychain listing", () => {
  const listing = `  1) ABCDEF123456 "Developer ID Application: Example (TEAMID)"`;
  assert.doesNotThrow(() =>
    assertAppleSigningIdentityAvailable(
      "Developer ID Application: Example (TEAMID)",
      listing,
    ),
  );
  assert.throws(
    () =>
      assertAppleSigningIdentityAvailable(
        "Developer ID Application: Example (TEAMID)",
        "     0 valid identities found",
      ),
    /mac:ssh:keychain/,
  );
});

test("tauri-build never falls back to the placeholder pubkey", async () => {
  const source = await readFile(join(root, "scripts/tauri-build.js"), "utf8");
  assert.match(source, /resolveUpdaterPublicKey/);
  assert.doesNotMatch(source, /process\.env\.TAURI_UPDATER_PUBLIC_KEY \?\?/);
  assert.doesNotMatch(source, /"POSTAL_SNAP_UPDATER_PUBLIC_KEY"/);
});

test("signed tauri-build does not require TAURI_UPDATER_PUBLIC_KEY in the environment", async () => {
  const source = await readFile(join(root, "scripts/tauri-build.js"), "utf8");
  const signingEnv = source.slice(
    source.indexOf("if (requireTauriSigning)"),
    source.indexOf("if (requireWindowsSigning)"),
  );
  assert.match(signingEnv, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(signingEnv, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.doesNotMatch(signingEnv, /TAURI_UPDATER_PUBLIC_KEY/);
});

test("prerelease-prepare refuses a placeholder updater pubkey", async () => {
  const source = await readFile(
    join(root, "scripts/prerelease-prepare.js"),
    "utf8",
  );
  assert.match(source, /resolveUpdaterPublicKey/);
  assert.match(source, /requireSigning:\s*true/);
});
