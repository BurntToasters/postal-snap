import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("mac SSH keychain unlock follows Zinnia SSH_USER_PWD and never prompts security", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/mac-keychain-ssh.sh"),
    "utf8",
  );
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  const envExample = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  assert.match(scripts["mac:ssh:keychain"], /mac-keychain-ssh\.sh/);
  assert.match(scripts["release:mac:ssh"], /mac:ssh:keychain/);
  assert.match(envExample, /^SSH_USER_PWD=/m);
  assert.doesNotMatch(envExample, /^MAC_KEYCHAIN_PASSWORD=/m);
  assert.match(script, /SSH_USER_PWD/);
  assert.match(script, /unlock-keychain -p "\$KEYCHAIN_PASSWORD"/);
  assert.match(script, /set-keychain-settings -lut 21600/);
  assert.doesNotMatch(script, /unlock-keychain "\$HOME/);
});
