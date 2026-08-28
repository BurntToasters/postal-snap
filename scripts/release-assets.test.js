import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { artifactArch, artifactPlatform, root } from "./_utils.js";
import { validateManifest } from "./validate-updater-manifest.js";
import {
  remoteTagCommit,
  verifyDraftReleaseCommit,
  verifyRemoteReleaseCommit,
} from "./release-identity.js";

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

const sessionCommit = "c".repeat(40);
const releaseSession = {
  version: "0.1.0",
  tag: "v0.1.0",
  commit: sessionCommit,
};

test("draft finalize requires a draft without resolving git tag refs", async () => {
  const tagCalls = [];
  const execute = async (args) => {
    tagCalls.push(args.at(-1));
    throw new Error("gh: Not Found (HTTP 404)");
  };
  await assert.rejects(
    () => remoteTagCommit("owner/repo", "v0.1.0", execute),
    /Not Found/,
  );
  assert.equal(tagCalls.length, 1);
  assert.match(tagCalls[0], /\/git\/ref\/tags\//);

  await verifyDraftReleaseCommit("owner/repo", releaseSession, {
    listReleases: async () => [
      {
        tag_name: "v0.1.0",
        draft: true,
        target_commitish: sessionCommit,
      },
    ],
  });
});

test("draft finalize fails when no draft exists", async () => {
  await assert.rejects(
    () =>
      verifyDraftReleaseCommit("owner/repo", releaseSession, {
        listReleases: async () => [],
      }),
    /No draft release found for v0\.1\.0/,
  );
});

test("draft finalize refuses a published release for the same tag", async () => {
  await assert.rejects(
    () =>
      verifyDraftReleaseCommit("owner/repo", releaseSession, {
        listReleases: async () => [
          { tag_name: "v0.1.0", draft: false },
          {
            tag_name: "v0.1.0",
            draft: true,
            target_commitish: sessionCommit,
          },
        ],
      }),
    /already exists as published/,
  );
});

test("draft finalize accepts a leftover draft with a different target_commitish", async () => {
  const otherCommit = "d".repeat(40);
  await verifyDraftReleaseCommit("owner/repo", releaseSession, {
    listReleases: async () => [
      {
        tag_name: "v0.1.0",
        draft: true,
        target_commitish: otherCommit,
      },
    ],
  });
});

test("hard finalize still requires the published git tag to match the session commit", async () => {
  const execute = async (args) => {
    if (args.at(-1).includes("/git/ref/tags/")) {
      return { object: { type: "commit", sha: sessionCommit } };
    }
    throw new Error("unexpected gh api call");
  };
  await verifyRemoteReleaseCommit("owner/repo", releaseSession, execute);

  await assert.rejects(
    () =>
      verifyRemoteReleaseCommit("owner/repo", releaseSession, async () => ({
        object: { type: "commit", sha: "e".repeat(40) },
      })),
    /not release session commit/,
  );
});

test("finalize-release verifies drafts before upload and tags only after publish", async () => {
  const finalize = await readFile(
    join(root, "scripts/finalize-release.js"),
    "utf8",
  );
  const draftIndex = finalize.indexOf("await verifyDraftReleaseCommit");
  const uploadIndex = finalize.indexOf('runGitHub([\n  "release",\n  "upload"');
  const remoteIndex = finalize.indexOf("await verifyRemoteReleaseCommit");
  const publishIndex = finalize.indexOf('"--draft=false"');
  assert.ok(draftIndex >= 0);
  assert.ok(uploadIndex > draftIndex);
  assert.ok(remoteIndex > publishIndex);
  assert.ok(publishIndex > uploadIndex);
  assert.doesNotMatch(
    finalize.slice(draftIndex, uploadIndex),
    /verifyRemoteReleaseCommit/,
  );
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
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_ARTIFACT_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_PROFILE",
    "AZURE_ARTIFACT_SIGNING_PUBLISHER",
    "AZURE_ARTIFACT_SIGNING_PUBLISHER_DN",
    "SKIP_WIN_CODESIGN",
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
  assert.match(
    template,
    /TAURI_UPDATER_PUBLIC_KEY is optional; if set, it must match that committed key/,
  );
  assert.match(
    template,
    /private key and password are required for signed builds/,
  );
  assert.ok(!names.has("WINDOWS_CERTIFICATE_THUMBPRINT"));
  assert.ok(!names.has("WINDOWS_CERTIFICATE_PFX_BASE64"));
  assert.ok(!names.has("WINDOWS_CERTIFICATE_PASSWORD"));
  assert.ok(!names.has("WINDOWS_TIMESTAMP_URL"));
  assert.match(template, /npm run setup:win:artifact-signing/);
  assert.match(template, /AZURE_ARTIFACT_SIGNING_SIGNTOOL_PATH=/);
  assert.match(template, /AZURE_ARTIFACT_SIGNING_DLIB_PATH=/);
});

test("Windows release signing uses Azure Artifact Signing, not a local PFX", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const tauriBuild = await readFile(
    join(root, "scripts/tauri-build.js"),
    "utf8",
  );
  const setup = await readFile(
    join(root, "scripts/setup-windows-artifact-signing.ps1"),
    "utf8",
  );
  const sign = await readFile(
    join(root, "scripts/windows-artifact-sign.ps1"),
    "utf8",
  );
  const verify = await readFile(
    join(root, "scripts/verify-windows-authenticode.ps1"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["setup:win:artifact-signing"],
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows-artifact-signing.ps1",
  );
  assert.match(
    packageJson.scripts["build:win:x64:prepared"],
    /--require-windows-signing --target x86_64-pc-windows-msvc --bundles nsis/,
  );
  assert.doesNotMatch(tauriBuild, /WINDOWS_CERTIFICATE_THUMBPRINT/);
  assert.doesNotMatch(tauriBuild, /certificateThumbprint/);
  assert.match(tauriBuild, /windows-artifact-sign\.ps1/);
  assert.match(tauriBuild, /verify-windows-authenticode\.ps1/);
  assert.match(setup, /Microsoft\.Azure\.ArtifactSigningClientTools/);
  assert.doesNotMatch(setup, /WINDOWS_CERTIFICATE_/);
  assert.doesNotMatch(setup, /Import-PfxCertificate/);
  assert.match(sign, /Get-ArtifactSigningTools/);
  assert.match(sign, /timestamp\.acs\.microsoft\.com/);
  assert.doesNotMatch(sign, /WINDOWS_CERTIFICATE_/);
  assert.doesNotMatch(sign, /AllowSparseMsix/);
  assert.match(verify, /AZURE_ARTIFACT_SIGNING_PUBLISHER/);
  assert.doesNotMatch(verify, /zinnia_shell|ZinniaContextMenu/);

  const ci = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(
    ci,
    /Microsoft\.Azure\.ArtifactSigningClientTools|ArtifactSigningClientTools\.msi/,
  );
  assert.match(ci, /Azure Artifact Signing/);
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

test("vi.js is the IYERIS/Zinnia VM setup path used by r and b", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const vi = await readFile(join(root, "scripts/vi.js"), "utf8");
  const distTools = await readFile(join(root, "scripts/dist-tools.js"), "utf8");
  const tauriBuild = await readFile(
    join(root, "scripts/tauri-build.js"),
    "utf8",
  );
  assert.equal(packageJson.scripts.vi, "node scripts/vi.js");
  assert.match(packageJson.scripts.r, /npm run vi && npm run gitprune:force/);
  assert.match(packageJson.scripts.b, /npm run vi$/);
  assert.match(vi, /git", \["fetch", "origin"\]/);
  assert.match(vi, /reset", "--hard", "@\{u\}"/);
  assert.match(vi, /clean", "-fd"/);
  assert.match(vi, /npm", \["ci", "--ignore-scripts"\]/);
  assert.match(vi, /VM Setup Complete/);
  assert.doesNotMatch(vi, /writeJson\(packagePath/);
  assert.match(distTools, /rmRetry\(/);
  assert.match(tauriBuild, /rmRetry\(/);
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
