import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { artifactArch, artifactPlatform, root } from "./_utils.js";
import { validateManifest } from "./validate-updater-manifest.js";
import { remoteTagCommit } from "./release-identity.js";

test("artifact platform and architecture mapping", () => {
  assert.equal(artifactPlatform("Postal-Snap-Windows-x64.nsis.zip"), "windows");
  assert.equal(
    artifactArch("Postal-Snap-Linux-arm64.AppImage.tar.gz"),
    "aarch64",
  );
  assert.equal(artifactArch("Postal-Snap-macOS.app.tar.gz"), "universal");
});

test("signed GitHub updater manifest shape", () => {
  assert.equal(
    validateManifest({
      version: "0.1.0-beta.1",
      platforms: {
        "windows-x86_64": {
          signature: "a".repeat(80),
          url: "https://github.com/BurntToasters/postal-snap/releases/download/v0.1.0-beta.1/payload.zip",
        },
      },
    }),
    true,
  );
});

test("annotated release tags resolve to their commit", async () => {
  const calls = [];
  const execute = async (args) => {
    calls.push(args.at(-1));
    if (args.at(-1).includes("/git/ref/tags/"))
      return { object: { type: "tag", sha: "a".repeat(40) } };
    return {
      object: { type: "commit", sha: "b".repeat(40) },
    };
  };
  assert.equal(
    await remoteTagCommit("owner/repo", "v0.1.0", execute),
    "b".repeat(40),
  );
  assert.equal(calls.length, 2);
});

test("direct and Store builds keep separate capabilities", async () => {
  const readJson = async (path) =>
    JSON.parse(await readFile(join(root, path), "utf8"));
  const direct = await readJson("src-tauri/tauri.conf.json");
  const mas = await readJson("src-tauri/tauri.mas.conf.json");
  const msstore = await readJson("src-tauri/tauri.msstore.conf.json");
  const flatpak = await readJson("src-tauri/tauri.flatpak.conf.json");
  const directCapability = await readJson(
    "src-tauri/capabilities/direct/default.json",
  );
  const storeCapability = await readJson(
    "src-tauri/capabilities/store/store.json",
  );

  assert.deepEqual(direct.app.security.capabilities, ["default"]);
  assert.deepEqual(mas.app.security.capabilities, ["store"]);
  assert.deepEqual(msstore.app.security.capabilities, ["store"]);
  assert.deepEqual(flatpak.app.security.capabilities, ["store"]);
  assert.ok(directCapability.permissions.includes("updater:default"));
  assert.ok(directCapability.permissions.includes("process:default"));
  assert.ok(!storeCapability.permissions.includes("updater:default"));
  assert.ok(!storeCapability.permissions.includes("process:default"));
  assert.equal(mas.bundle.createUpdaterArtifacts, false);
  assert.equal(msstore.bundle.createUpdaterArtifacts, false);
  assert.equal(flatpak.bundle.createUpdaterArtifacts, false);
  assert.equal(mas.plugins.updater, null);
  assert.equal(msstore.plugins.updater, null);
  assert.equal(flatpak.plugins.updater, null);
});

test("direct updater is GitHub-only and notices are bundled", async () => {
  const config = JSON.parse(
    await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const serialized = JSON.stringify(config);
  assert.ok(serialized.includes("github.com/BurntToasters/postal-snap"));
  assert.ok(!serialized.includes("prod.rosie.run"));
  assert.equal(
    config.bundle.resources["../THIRD_PARTY_NOTICES.npm.txt"],
    "THIRD_PARTY_NOTICES.npm.txt",
  );
  assert.equal(
    config.bundle.resources["../THIRD_PARTY_NOTICES.cargo.txt"],
    "THIRD_PARTY_NOTICES.cargo.txt",
  );
});

test("release environment template covers every supported credential path", async () => {
  const template = await readFile(join(root, ".env.example"), "utf8");
  const names = new Set(
    template
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter(Boolean),
  );
  for (const name of [
    "GPG_KEY_ID",
    "GPG_PASSPHRASE",
    "GPG_PRIVATE_KEY_BASE64",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_UPDATER_PUBLIC_KEY",
    "WINDOWS_CERTIFICATE_THUMBPRINT",
    "WINDOWS_TIMESTAMP_URL",
    "WINDOWS_CERTIFICATE_PFX_BASE64",
    "WINDOWS_CERTIFICATE_PASSWORD",
    "MSSTORE_IDENTITY_NAME",
    "MSSTORE_PUBLISHER",
    "MSSTORE_PUBLISHER_DISPLAY_NAME",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_INSTALLER_IDENTITY",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_PATH",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "MAS_PROVISIONING_PROFILE",
    "MAS_BUILD_NUMBER",
    "APPLE_CERTIFICATE_P12_BASE64",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_KEYCHAIN_PASSWORD",
    "MAC_KEYCHAIN_PASSWORD",
    "POSTAL_SNAP_TEST_ICLOUD_EMAIL",
    "POSTAL_SNAP_TEST_ICLOUD_PASSWORD",
    "ALLOW_DIRTY_RELEASE",
  ]) {
    assert.ok(names.has(name), `${name} is missing from .env.example`);
  }
  assert.ok(!names.has("GH_TOKEN"));
  assert.ok(template.includes("gh auth login"));
});

test("release verification covers generated manifests after finalization", async () => {
  const verifier = await readFile(
    join(root, "scripts/verify-release-directory.js"),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.ok(verifier.includes("latest-${platform}${channel}-${arch}.json"));
  assert.ok(verifier.includes("platformEntry.signature !== expectedSignature"));
  assert.match(
    packageJson.scripts["release:finalize:hard"],
    /finalize-release\.js --hard/,
  );
  const finalizer = await readFile(
    join(root, "scripts/finalize-release.js"),
    "utf8",
  );
  assert.ok(finalizer.includes("verify-release-draft.js"));
  const remoteVerifier = await readFile(
    join(root, "scripts/verify-release-draft.js"),
    "utf8",
  );
  assert.ok(remoteVerifier.includes('"download"'));
  assert.ok(remoteVerifier.includes("verify-release-directory.js"));
});

test("per-platform continue uploads without requiring the complete artifact set", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  for (const name of [
    "release:win:continue",
    "release:mac:continue",
    "release:linux:x64:continue",
    "release:linux:arm64:continue",
  ]) {
    const script = packageJson.scripts[name];
    assert.match(script, /npm run release:finalize(?:\s|$)/);
    assert.doesNotMatch(
      script,
      /npm run release:verify:(?:local|draft)/,
      `${name} must not require every architecture on the first signing host`,
    );
  }
  assert.equal(
    packageJson.scripts["release:linux:x64:continue"],
    "npm run release:session:verify && npm run release:wait-draft && npm run rust:target:linux:x64 && npm run build:linux:x64:prepared && npm run flatpak:clean && npm run flatpak:bundle && npm run release:sign:gpg && npm run release:finalize",
  );
  assert.equal(
    packageJson.scripts["release:linux:arm64:continue"],
    "npm run release:session:verify && npm run release:wait-draft && npm run rust:target:linux:arm64 && npm run build:linux:arm64:prepared && npm run flatpak:clean && npm run flatpak:bundle:arm64 && npm run release:sign:gpg && npm run release:finalize",
  );
});

test("rust:update passes clippy and rustfmt as one --component value", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const rustUpdate = packageJson.scripts["rust:update"];
  assert.equal(
    rustUpdate,
    "rustup toolchain install 1.97.1 --profile minimal --component cargo,clippy,rustfmt",
  );

  for (const [name, script] of Object.entries(packageJson.scripts)) {
    const argv = String(script).split(/\s+/);
    if (argv[0] !== "rustup") continue;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] !== "--component" && argv[index] !== "-c") continue;
      const value = argv[index + 1];
      assert.ok(
        value && !value.startsWith("-"),
        `${name} must pass a value to --component`,
      );
      const next = argv[index + 2];
      assert.ok(
        next === undefined || next.startsWith("-"),
        `${name} must not pass extra rustup components as positional args`,
      );
    }
  }
});

test("test:all still includes Playwright e2e unless SKIP_E2E is set", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(packageJson.scripts["test:all"], "node scripts/test-all.js");
  assert.equal(packageJson.scripts["test:e2e"], "playwright test");

  const { qualityGateSteps } = await import("./test-all.js");
  assert.deepEqual(
    qualityGateSteps({}).find((args) => args.includes("test:e2e")),
    ["run", "test:e2e"],
  );
  assert.ok(
    !qualityGateSteps({ SKIP_E2E: "1" }).some((args) =>
      args.includes("test:e2e"),
    ),
  );

  const testAll = await readFile(join(root, "scripts/test-all.js"), "utf8");
  assert.doesNotMatch(testAll, /process\.platform/);

  const ci = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npx playwright install --with-deps chromium/);
  assert.match(ci, /npm run test:e2e/);
  assert.match(ci, /npm run check:cargo-update-policy/);
  assert.match(ci, /npm run test:cargo-safe-update/);
});

test("workspace:prepare sets SKIP_E2E for every platform release", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["workspace:prepare"],
    "npm run workspace:bootstrap && npm run licenses && cross-env SKIP_E2E=1 npm run test:all",
  );
  assert.match(
    packageJson.scripts["release:prepare"],
    /^npm run workspace:prepare &&/,
  );
  assert.ok(packageJson.devDependencies["cross-env"]);

  for (const name of [
    "release:win",
    "release:mac",
    "release:linux:x64",
    "release:linux:arm64",
  ]) {
    assert.match(
      packageJson.scripts[name],
      /npm run release:prepare &&/,
      `${name} must run the shared quality gate`,
    );
  }
  assert.equal(
    packageJson.scripts["release:linux"],
    "npm run release:linux:x64",
  );
  assert.equal(
    packageJson.scripts["release:linux:resume"],
    "npm run release:linux:x64:resume",
  );

  for (const [name, script] of Object.entries(packageJson.scripts)) {
    if (!name.startsWith("release:")) continue;
    if (!/(?:continue|resume)$/.test(name)) continue;
    assert.doesNotMatch(
      script,
      /npm run (?:test:all|test:e2e|workspace:prepare|release:prepare)(?:\s|&|$)/,
      `${name} must not re-run the quality gate or Playwright`,
    );
  }
});

test("test-all and package.json include cargo safe update and policy check", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["test:cargo-safe-update"],
    "node --test scripts/cargo-safe-update.test.mjs scripts/check-cargo-update-policy.test.mjs",
  );
  assert.equal(
    packageJson.scripts["check:cargo-update-policy"],
    "node scripts/check-cargo-update-policy.mjs",
  );
  assert.match(packageJson.scripts["u"], /cargo-safe-update\.mjs/);

  const testAll = await readFile(join(root, "scripts/test-all.js"), "utf8");
  assert.ok(testAll.includes('["run", "check:cargo-update-policy"]'));
  assert.ok(testAll.includes('["run", "test:cargo-safe-update"]'));
});
