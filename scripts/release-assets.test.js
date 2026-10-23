import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { artifactArch, artifactPlatform } from "./lib/artifacts.js";
import { root } from "./lib/paths.js";
import { isSemVer } from "./lib/versions.js";
import { validateManifest } from "./validate-updater-manifest.js";
import {
  isDirectRun,
  shouldSkipMissingTarget,
  updaterManifestNames,
  validateLiveManifest,
} from "./validate-updater-live.js";
import {
  assertReleaseWorktreeClean,
  remoteTagCommit,
  verifyDraftReleaseCommit,
  verifyRemoteReleaseCommit,
} from "./release-identity.js";

test("release continuation rejects modified source after preparation", async () => {
  await assert.rejects(
    assertReleaseWorktreeClean(async () => " M src/components/Composer.tsx"),
    /clean worktree/i,
  );
  await assert.doesNotReject(assertReleaseWorktreeClean(async () => ""));
});

test("release preparation retires the dirty worktree override", async () => {
  const originalOverride = process.env.ALLOW_DIRTY_RELEASE;
  process.env.ALLOW_DIRTY_RELEASE = "1";
  try {
    await assert.rejects(
      assertReleaseWorktreeClean(async () => " M src/components/Composer.tsx"),
      /clean worktree/i,
    );
  } finally {
    if (originalOverride === undefined) delete process.env.ALLOW_DIRTY_RELEASE;
    else process.env.ALLOW_DIRTY_RELEASE = originalOverride;
  }

  const prepare = await readFile(
    join(root, "scripts/prerelease-prepare.js"),
    "utf8",
  );
  assert.match(prepare, /assertReleaseWorktreeClean\(\)/);
  assert.doesNotMatch(prepare, /ALLOW_DIRTY_RELEASE/);

  const template = await readFile(join(root, ".env.example"), "utf8");
  assert.doesNotMatch(template, /ALLOW_DIRTY_RELEASE/);
});

test("release session digest binds every generated direct-bundle resource", async () => {
  const { RELEASE_SESSION_BUNDLE_INPUTS, releaseBundleResourcesSha256 } =
    await import("./release-identity.js");
  const config = JSON.parse(
    await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const configuredInputs = Object.keys(config.bundle.resources)
    .filter(
      (path) =>
        path.startsWith("../public/licenses") ||
        path.startsWith("../THIRD_PARTY_NOTICES."),
    )
    .map((path) => path.slice(3))
    .sort();
  assert.deepEqual([...RELEASE_SESSION_BUNDLE_INPUTS].sort(), configuredInputs);

  const directory = await mkdtemp(
    join(tmpdir(), "postal-snap-release-inputs-"),
  );
  try {
    const contents = new Map([
      ["public/licenses.json", "npm licenses v1"],
      ["public/licenses-cargo.json", "cargo licenses v1"],
      ["THIRD_PARTY_NOTICES.npm.txt", "npm notices v1"],
      ["THIRD_PARTY_NOTICES.cargo.txt", "cargo notices v1"],
    ]);
    for (const [path, value] of contents) {
      const absolute = join(directory, path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, value);
    }

    const initial = await releaseBundleResourcesSha256(directory);
    await writeFile(join(directory, "public/licenses.json"), "npm licenses v2");
    const changed = await releaseBundleResourcesSha256(directory);
    assert.match(initial, /^[a-f0-9]{64}$/);
    assert.notEqual(changed, initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release session digest reports a missing generated bundle input", async () => {
  const { releaseBundleResourcesSha256 } =
    await import("./release-identity.js");
  const directory = await mkdtemp(
    join(tmpdir(), "postal-snap-release-inputs-"),
  );
  try {
    await mkdir(join(directory, "public"), { recursive: true });
    await writeFile(join(directory, "public/licenses.json"), "npm licenses");
    await assert.rejects(
      releaseBundleResourcesSha256(directory),
      /public\/licenses-cargo\.json.*npm run licenses/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact platform and architecture mapping", () => {
  assert.equal(artifactPlatform("Postal-Snap-Windows-x64.nsis.zip"), "windows");
  assert.equal(artifactArch("Postal-Snap-Linux-arm64.AppImage"), "aarch64");
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

test("signed manifest accepts the platform-beta key", () => {
  assert.equal(
    validateManifest({
      version: "0.4.3",
      platforms: {
        "darwin-beta": {
          signature: "a".repeat(80),
          url: "https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/payload.zip",
        },
      },
    }),
    true,
  );
  assert.throws(() =>
    validateManifest({
      version: "0.4.3",
      platforms: { "darwin-nightly": { signature: "a".repeat(80), url: "x" } },
    }),
  );
});

const goodEntry = (overrides = {}) => ({
  signature: "a".repeat(80),
  url: "https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/Postal-Snap-Windows-x64.exe",
  ...overrides,
});

const goodManifest = (overrides = {}) => ({
  version: "0.4.3",
  platforms: { "windows-x86_64": goodEntry() },
  ...overrides,
});

test("updater manifest rejects malformed manifest and entry types", () => {
  for (const manifest of [null, undefined, "v0.4.3", 42, ["windows-x86_64"]]) {
    assert.throws(() => validateManifest(manifest), /object/i);
  }
  for (const platforms of [null, "windows-x86_64", 42, ["windows-x86_64"]]) {
    assert.throws(() => validateManifest({ version: "0.4.3", platforms }));
  }
  assert.throws(() => validateManifest({ version: "0.4.3" }));
  for (const entry of [null, "https://x", 42, [], {}]) {
    assert.throws(() =>
      validateManifest({
        version: "0.4.3",
        platforms: { "windows-x86_64": entry },
      }),
    );
  }
  assert.throws(() =>
    validateManifest({
      version: "0.4.3",
      platforms: { "windows-x86_64": { signature: "a".repeat(80) } },
    }),
  );
  assert.throws(() =>
    validateManifest({
      version: "0.4.3",
      platforms: {
        "windows-x86_64": goodEntry({ url: 42 }),
      },
    }),
  );
  assert.throws(() =>
    validateManifest({
      version: "0.4.3",
      platforms: {
        "windows-x86_64": goodEntry({ signature: 42 }),
      },
    }),
  );
  assert.throws(() =>
    validateManifest({
      version: "0.4.3",
      platforms: {
        "windows-x86_64": goodEntry({ signature: "short" }),
      },
    }),
  );
});

test("updater manifest rejects empty platform maps", () => {
  assert.throws(
    () => validateManifest({ version: "0.4.3", platforms: {} }),
    /platform/i,
  );
});

test("updater manifest rejects invalid SemVer", () => {
  for (const version of [
    "",
    "1.2",
    "v0.4.3",
    "0.4.3.1",
    "0.4.3-",
    " 0.4.3",
    "0.4.3 ",
    "0.4.3+build",
    "latest",
    null,
    42,
  ]) {
    assert.throws(() => validateManifest(goodManifest({ version })), /SemVer/);
  }
  assert.equal(
    validateManifest(goodManifest({ version: "0.4.4-beta.1" })),
    true,
  );
});

test("updater manifest rejects unsupported targets", () => {
  for (const key of [
    "win32-x86_64",
    "darwin-arm64",
    "windows-x64",
    "linux",
    "",
    "windows-x86_64-beta",
    "darwin-nightly",
    "WINDOWS-X86_64",
  ]) {
    assert.throws(
      () =>
        validateManifest(goodManifest({ platforms: { [key]: goodEntry() } })),
      /[Uu]nsupported/,
    );
  }
});

test("updater manifest rejects incomplete GitHub release URLs", () => {
  for (const url of [
    "https://github.com/BurntToasters/postal-snap/releases/download/",
    "https://github.com/BurntToasters/postal-snap/releases/download",
    "https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3",
    "https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/",
    "https://github.com/BurntToasters/postal-snap/releases/tag/v0.4.3",
    "http://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/a.zip",
    "https://evil.example/a",
    "https://github.com/other/repo/releases/download/v0.4.3/a.zip",
    "https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/a.zip?x=1",
  ]) {
    assert.throws(
      () =>
        validateManifest(
          goodManifest({ platforms: { "windows-x86_64": goodEntry({ url }) } }),
        ),
      /GitHub release/,
    );
  }
});

test("updater manifest keeps stable and beta shapes, not signature content", () => {
  assert.equal(validateManifest(goodManifest()), true);
  const betaEntry = goodEntry({
    url: "https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/Postal-Snap-Windows-x64.exe",
  });
  assert.equal(
    validateManifest(
      goodManifest({
        platforms: {
          "windows-x86_64": betaEntry,
          "windows-beta": { ...betaEntry },
        },
      }),
    ),
    true,
  );
  // Structural validation accepts any well-formed signature; content equality
  // with the payload stays with the dedicated Tauri signature verifier.
  assert.equal(
    validateManifest(
      goodManifest({
        platforms: {
          "windows-x86_64": goodEntry({ signature: "b".repeat(80) }),
        },
      }),
    ),
    true,
  );
});

test("isSemVer accepts strict release versions only", () => {
  assert.equal(isSemVer("0.4.3"), true);
  assert.equal(isSemVer("0.4.4-beta.1"), true);
  assert.equal(isSemVer("10.20.30-rc.1"), true);
  for (const bad of [
    "",
    "1.2",
    "v0.4.3",
    "0.4.3.1",
    "0.4.3-",
    "0.4.3+build",
    "latest",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isSemVer(bad), false);
  }
});

test("live validation requires the expected platform and arch key", () => {
  const manifest = goodManifest();
  assert.equal(
    validateLiveManifest(manifest, {
      platform: "windows",
      arch: "x86_64",
      filename: "latest-windows-x86_64.json",
    }),
    true,
  );
  assert.throws(
    () =>
      validateLiveManifest(manifest, {
        platform: "darwin",
        arch: "aarch64",
        filename: "latest-darwin-aarch64.json",
      }),
    /darwin-aarch64/,
  );
  assert.throws(
    () =>
      validateLiveManifest(goodManifest({ version: "not-semver" }), {
        platform: "windows",
        arch: "x86_64",
        filename: "latest-windows-x86_64.json",
      }),
    /SemVer/,
  );
});

test("live validation requires the beta alias on beta manifests", () => {
  const entry = goodEntry();
  const beta = goodManifest({
    platforms: { "windows-x86_64": entry, "windows-beta": { ...entry } },
  });
  assert.equal(
    validateLiveManifest(beta, {
      platform: "windows",
      arch: "x86_64",
      filename: "latest-windows-beta-x86_64.json",
    }),
    true,
  );
  assert.throws(
    () =>
      validateLiveManifest(goodManifest(), {
        platform: "windows",
        arch: "x86_64",
        filename: "latest-windows-beta-x86_64.json",
      }),
    /windows-beta/,
  );
  assert.throws(
    () =>
      validateLiveManifest(
        goodManifest({
          platforms: {
            "windows-x86_64": entry,
            "windows-beta": goodEntry({
              url: "https://github.com/BurntToasters/postal-snap/releases/download/v0.4.3/other.exe",
            }),
          },
        }),
        {
          platform: "windows",
          arch: "x86_64",
          filename: "latest-windows-beta-x86_64.json",
        },
      ),
    /windows-beta/,
  );
});

test("live updater validation requires both manifests for stable", () => {
  assert.deepEqual(updaterManifestNames("windows", "x86_64", "0.1.9"), [
    "latest-windows-x86_64.json",
    "latest-windows-beta-x86_64.json",
  ]);
  assert.deepEqual(updaterManifestNames("darwin", "aarch64", "0.1.9-beta.1"), [
    "latest-darwin-beta-aarch64.json",
  ]);
});

test("live updater validation fails on missing required manifests", () => {
  assert.equal(shouldSkipMissingTarget("windows", "x86_64", 404), false);
  assert.equal(shouldSkipMissingTarget("linux", "x86_64", 404), false);
  assert.equal(shouldSkipMissingTarget("windows", "x86_64", 500), false);
  assert.equal(shouldSkipMissingTarget("linux", "aarch64", 500), false);
  assert.equal(shouldSkipMissingTarget("linux", "aarch64", 404), true);
});

test("live updater validation runs when the entry path casing differs", () => {
  assert.equal(isDirectRun("/repo/scripts/validate-updater-live.js"), true);
  assert.equal(isDirectRun("/repo/scripts/VALIDATE-UPDATER-LIVE.JS"), true);
  assert.equal(isDirectRun("/repo/scripts/Validate-Updater-Live.Js"), true);
  assert.equal(
    isDirectRun("/repo/scripts/validate-updater-live.test.js"),
    false,
  );
  assert.equal(isDirectRun(undefined), false);
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

test("draft finalize resolves the tag and checks it against the session", async () => {
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
    resolveTag: async (_repository, tag) => {
      tagCalls.push(tag);
      const error = new Error("gh: Not Found (HTTP 404)");
      error.statusCode = 404;
      throw error;
    },
  });
  assert.equal(tagCalls.at(-1), "v0.1.0");
  assert.equal(tagCalls.length, 2);
});

test("draft finalize rejects a tag that points at another commit", async () => {
  await assert.rejects(
    () =>
      verifyDraftReleaseCommit("owner/repo", releaseSession, {
        listReleases: async () => [
          {
            tag_name: "v0.1.0",
            draft: true,
            target_commitish: sessionCommit,
          },
        ],
        resolveTag: async () => "d".repeat(40),
      }),
    /not release session commit/,
  );
});

test("draft target_commitish is ignored when the tag already exists", async () => {
  await verifyDraftReleaseCommit("owner/repo", releaseSession, {
    listReleases: async () => [
      {
        tag_name: "v0.1.0",
        draft: true,
        target_commitish: "main",
      },
    ],
    resolveTag: async () => sessionCommit,
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

test("draft finalize restores an untagged leftover draft tag", async () => {
  const patches = [];
  await verifyDraftReleaseCommit("owner/repo", releaseSession, {
    listReleases: async () => [
      {
        id: 99,
        tag_name: "untagged-ff961747ae9f0e6a3461",
        draft: true,
        name: "0.1.0",
        target_commitish: sessionCommit,
      },
    ],
    request: async (method, endpoint, body) => {
      patches.push({ method, endpoint, body });
      return {
        id: 99,
        tag_name: body.tag_name,
        draft: true,
        target_commitish: sessionCommit,
      };
    },
    resolveTag: async () => sessionCommit,
  });
  assert.deepEqual(patches, [
    {
      method: "PATCH",
      endpoint: "repos/owner/repo/releases/99",
      body: { tag_name: "v0.1.0", draft: true },
    },
  ]);
});

test("draft finalize refuses a missing tag when its target commit differs", async () => {
  const otherCommit = "d".repeat(40);
  const patches = [];
  await assert.rejects(
    () =>
      verifyDraftReleaseCommit("owner/repo", releaseSession, {
        listReleases: async () => [
          {
            id: 99,
            tag_name: "untagged-ff961747ae9f0e6a3461",
            draft: true,
            name: "0.1.0",
            target_commitish: otherCommit,
          },
        ],
        request: async (...args) => patches.push(args),
        resolveTag: async () => {
          const error = new Error("gh: Not Found (HTTP 404)");
          error.statusCode = 404;
          throw error;
        },
      }),
    /draft target_commitish.*not release session commit/i,
  );
  assert.deepEqual(patches, []);
});

test("draft finalize does not treat non-404 tag lookup failures as absence", async () => {
  const error = new Error("gh: HTTP 403");
  error.statusCode = 403;
  await assert.rejects(
    () =>
      verifyDraftReleaseCommit("owner/repo", releaseSession, {
        listReleases: async () => [
          {
            tag_name: "v0.1.0",
            draft: true,
            target_commitish: sessionCommit,
          },
        ],
        resolveTag: async () => {
          throw error;
        },
      }),
    (failure) => failure === error,
  );
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

test("finalize-release uses draft identity before upload and strict identity after publish", async () => {
  const finalize = await readFile(
    join(root, "scripts/finalize-release.js"),
    "utf8",
  );
  const draftIndex = finalize.indexOf("await verifyDraftReleaseCommit");
  const uploadIndex = finalize.indexOf(
    'runGitHub([\n    "release",\n    "upload",',
  );
  const hardIndex = finalize.indexOf("await runHardFinalize({");
  const publishIndex = finalize.indexOf(
    "publish: () => runGitHub(publishArgs(",
  );
  assert.match(finalize, /export function publishArgs[\s\S]*?"--draft=false"/);
  assert.ok(draftIndex >= 0);
  assert.ok(uploadIndex > draftIndex);
  assert.doesNotMatch(
    finalize.slice(draftIndex, uploadIndex),
    /verifyRemoteReleaseCommit/,
  );
  assert.match(
    finalize.slice(draftIndex, uploadIndex),
    /verifyDraftReleaseCommit/,
  );
  assert.ok(hardIndex > uploadIndex);
  assert.ok(publishIndex > hardIndex);
  assert.match(
    finalize,
    /syncBetaManifests: \(\) => syncLocalBetaManifests\(directory\)/,
  );
  assert.match(
    finalize,
    /reconcileBetaManifests: async \(\) => \{\s*try \{\s*await run\(\s*"node",\s*\[\s*"scripts\/finalize-release\.js",\s*"--sync-beta-manifests"/,
  );

  const hardFinalize = finalize.slice(
    finalize.indexOf("export async function runHardFinalize"),
  );
  const verifyStep = hardFinalize.indexOf("await verifyDraft()");
  const draftIdentityStep = hardFinalize.indexOf("await verifyDraftIdentity()");
  const syncStep = hardFinalize.indexOf("await syncBetaManifests()");
  const publishStep = hardFinalize.indexOf("await publish()");
  const strictStep = hardFinalize.indexOf("await verifyPublished()");
  const reconcileStep = hardFinalize.indexOf("await reconcileBetaManifests()");
  assert.ok(verifyStep >= 0);
  assert.ok(draftIdentityStep > verifyStep);
  assert.ok(syncStep > draftIdentityStep);
  assert.ok(publishStep > syncStep);
  assert.ok(strictStep > publishStep);
  assert.ok(reconcileStep > strictStep);
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
  assert.ok(!directCapability.permissions.includes("process:allow-restart"));
  assert.ok(!directCapability.permissions.includes("process:default"));
  assert.ok(!directCapability.permissions.includes("notification:default"));
  assert.ok(!directCapability.permissions.includes("deep-link:allow-register"));
  assert.ok(!storeCapability.permissions.includes("updater:default"));
  assert.ok(!storeCapability.permissions.includes("process:default"));
  assert.ok(!storeCapability.permissions.includes("process:allow-restart"));
  for (const capability of [directCapability, storeCapability]) {
    assert.deepEqual(capability.windows, ["main"]);
    for (const action of [
      "start-dragging",
      "minimize",
      "toggle-maximize",
      "set-fullscreen",
      "close",
    ]) {
      assert.ok(
        capability.permissions.includes(`core:window:allow-${action}`),
        `Missing caption permission: ${action}`,
      );
    }
    assert.ok(!capability.permissions.includes("core:window:allow-destroy"));
  }
  assert.equal(mas.app.macOSPrivateApi, false);
  assert.equal(msstore.app.macOSPrivateApi, false);
  assert.equal(flatpak.app.macOSPrivateApi, false);
  assert.equal(mas.app.windows[0].transparent, false);
  assert.equal(direct.app.macOSPrivateApi, false);
  const directOverlay = await readJson("src-tauri/tauri.direct.conf.json");
  assert.equal(directOverlay.app.macOSPrivateApi, false);
  assert.equal(direct.bundle.createUpdaterArtifacts, true);
  assert.equal(mas.bundle.createUpdaterArtifacts, false);
  assert.equal(msstore.bundle.createUpdaterArtifacts, false);
  assert.equal(flatpak.bundle.createUpdaterArtifacts, false);
  assert.equal(mas.plugins.updater, null);
  assert.equal(msstore.plugins.updater, null);
  assert.equal(flatpak.plugins.updater, null);
});

test("flatpak sideload bundle exports stable without a linted branch field", async () => {
  const manifest = await readFile(
    join(root, "packaging/flatpak/run.rosie.snap.yml"),
    "utf8",
  );
  const [script, setup, ci] = await Promise.all([
    readFile(join(root, "scripts/build-flatpak.js"), "utf8"),
    readFile(join(root, "scripts/setup-flatpak.js"), "utf8"),
    readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
  ]);
  assert.doesNotMatch(manifest, /^branch:/m);
  assert.match(manifest, /org\.freedesktop\.Notifications/);
  assert.match(manifest, /^runtime-version:\s*"50"$/m);
  assert.match(manifest, /run\.rosie\.snap\.metainfo\.xml/);
  assert.match(script, /const branch = "stable";/);
  assert.match(script, /function withSideloadBranch/);
  assert.match(script, /`--default-branch=\$\{branch\}`/);
  assert.match(script, /await runFlatpakBuilderLint\(sourceManifest\)/);
  assert.doesNotMatch(script, /runFlatpakBuilderLint\(generatedManifest\)/);
  assert.match(script, /"run\.rosie\.snap",\s*branch/);
  assert.match(script, /org\.flatpak\.Builder\/\/stable/);
  assert.match(script, /--command=\$\{flatpakBuilderCommand\}/);
  assert.doesNotMatch(script, /run\("flatpak-builder"/);
  assert.match(setup, /org\.flatpak\.Builder\/\/stable/);
  assert.match(setup, /--command=\$\{FLATPAK_BUILDER_COMMAND\}/);
  assert.doesNotMatch(setup, /output\("flatpak-builder"/);
  assert.match(ci, /org\.flatpak\.Builder\/\/stable/);
  const metainfo = await readFile(
    join(root, "packaging/flatpak/run.rosie.snap.metainfo.xml"),
    "utf8",
  );
  assert.match(metainfo, /<id>run\.rosie\.snap<\/id>/);
  assert.match(metainfo, /MPL-2\.0/);
  assert.match(metainfo, /<developer id="run\.rosie">/);
  assert.match(metainfo, /<release version="[^"]+" date="\d{4}-\d{2}-\d{2}"/);
  const lintExceptions = JSON.parse(
    await readFile(
      join(root, "packaging/flatpak/lint-exceptions.json"),
      "utf8",
    ),
  );
  assert.deepEqual(lintExceptions, {
    "run.rosie.snap": ["appid-url-not-reachable"],
  });
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
  assert.equal(
    config.bundle.resources["../public/licenses.json"],
    "licenses.json",
  );
  assert.equal(
    config.bundle.resources["../public/licenses-cargo.json"],
    "licenses-cargo.json",
  );
  assert.equal(config.bundle.resources["../LICENSE"], "LICENSE");
  assert.equal(
    config.bundle.resources["filters/LICENSE-CC-BY-SA-3.0.txt"],
    "LICENSE-CC-BY-SA-3.0.txt",
  );
  assert.equal(
    config.bundle.resources["filters/LICENSE-CC0-1.0.txt"],
    "LICENSE-CC0-1.0.txt",
  );
  assert.equal(
    config.bundle.windows.webviewInstallMode?.type,
    "embedBootstrapper",
  );
  assert.notEqual(config.bundle.windows.webviewInstallMode?.type, "skip");
  assert.match(config.bundle.windows.signCommand, /windows-artifact-sign\.ps1/);
  assert.match(config.bundle.windows.signCommand, /-NonInteractive/);
  assert.equal(config.bundle.publisher, "Postal Snap");
  assert.equal(
    config.bundle.homepage,
    "https://github.com/BurntToasters/postal-snap",
  );
  assert.equal(
    config.bundle.windows.nsis.installerHooks,
    "windows/installer-hooks.nsh",
  );
  const hooks = await readFile(
    join(root, "src-tauri/windows/installer-hooks.nsh"),
    "utf8",
  );
  assert.match(hooks, /NSIS_HOOK_PREINSTALL/);
  assert.match(hooks, /NSIS_HOOK_PREUNINSTALL/);
  assert.match(hooks, /NSIS_HOOK_POSTINSTALL/);
  assert.match(hooks, /NSIS_HOOK_POSTUNINSTALL/);
  assert.match(hooks, /POSTAL_SNAP_MIN_WINDOWS_BUILD 19045/);
  assert.match(hooks, /--cleanup-credentials/);
  assert.match(
    hooks,
    /!define POSTAL_SNAP_MAILTO_DEFAULT "URL:run\.rosie\.snap protocol"/,
  );
  // Returns one macro body, failing if it is missing.
  const macroBody = (name) => {
    const begin = hooks.indexOf(`!macro ${name}\n`);
    assert.ok(begin >= 0, `${name} must exist`);
    return hooks.slice(begin, hooks.indexOf("!macroend", begin));
  };
  const backup = macroBody("POSTAL_SNAP_BACKUP_MAILTO");
  const restore = macroBody("POSTAL_SNAP_RESTORE_MAILTO");
  const preinstall = macroBody("NSIS_HOOK_PREINSTALL");
  const postinstall = macroBody("NSIS_HOOK_POSTINSTALL");
  const preuninstall = macroBody("NSIS_HOOK_PREUNINSTALL");
  const postuninstall = macroBody("NSIS_HOOK_POSTUNINSTALL");
  // Default apps registration uses an app-specific ProgID and capabilities.
  assert.match(
    postinstall,
    /WriteRegStr HKCU "Software\\Classes\\\$\{POSTAL_SNAP_PROGID\}\\shell\\open\\command" "" '"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe" "%1"'/,
  );
  assert.match(
    postinstall,
    /WriteRegStr HKCU "\$\{POSTAL_SNAP_CAPS_KEY\}\\URLAssociations" "mailto" "\$\{POSTAL_SNAP_PROGID\}"/,
  );
  assert.match(
    postinstall,
    /WriteRegStr HKCU "\$\{POSTAL_SNAP_REGISTERED_APPS\}" "\$\{POSTAL_SNAP_APP_NAME\}" "\$\{POSTAL_SNAP_CAPS_KEY\}"/,
  );
  assert.match(postinstall, /ApplicationName/);
  assert.match(postinstall, /ApplicationIcon/);
  // Backup runs in PREINSTALL and only for a handler that is not ours.
  assert.match(preinstall, /!insertmacro POSTAL_SNAP_BACKUP_MAILTO/);
  assert.match(
    backup,
    /ReadRegStr \$R0 HKCU "\$\{POSTAL_SNAP_LEGACY_MAILTO\}\\shell\\open\\command"/,
  );
  // "Ours" is decided by the command alone, from any install folder.
  assert.match(
    hooks,
    /!define POSTAL_SNAP_COMMAND_SUFFIX '\$\{MAINBINARYNAME\}\.exe" "%1"'/,
  );
  const ours = macroBody("POSTAL_SNAP_IS_OURS_COMMAND");
  assert.match(ours, /StrCpy \$R6 \$R0 "" "-\$R7"/);
  assert.match(ours, /\$\{OrIf\} \$R6 == '\$\{POSTAL_SNAP_COMMAND_SUFFIX\}'/);
  assert.match(ours, /StrCpy \$R8 "1"/);
  assert.doesNotMatch(ours, /POSTAL_SNAP_MAILTO_DEFAULT/);
  assert.match(backup, /!insertmacro POSTAL_SNAP_IS_OURS_COMMAND/);
  assert.match(backup, /AndIf\} \$R8 != "1"/);
  // The default value must not decide ownership; a command-only rewrite is another client.
  assert.doesNotMatch(backup, /POSTAL_SNAP_MAILTO_DEFAULT/);
  assert.doesNotMatch(preuninstall, /POSTAL_SNAP_MAILTO_DEFAULT/);
  assert.match(
    preuninstall,
    /!insertmacro POSTAL_SNAP_IS_OURS_COMMAND\n\s+\$\{If\} \$R8 == "1"/,
  );
  assert.match(
    backup,
    /WriteRegStr HKCU "\$\{POSTAL_SNAP_BACKUP_KEY\}" "Captured" "1"/,
  );
  // Restore runs after Tauri's writes and only when a backup was captured.
  assert.match(postinstall, /!insertmacro POSTAL_SNAP_RESTORE_MAILTO/);
  assert.match(
    restore,
    /ReadRegStr \$R0 HKCU "\$\{POSTAL_SNAP_BACKUP_KEY\}" "Captured"/,
  );
  assert.match(restore, /\$\{If\} \$R0 == "1"/);
  // Shared key writes live only in the restore path, so no other code can clobber another client.
  assert.match(
    restore,
    /WriteRegStr HKCU "\$\{POSTAL_SNAP_LEGACY_MAILTO\}" "" \$R1/,
  );
  const outsideRestore = hooks.replace(restore, "");
  assert.doesNotMatch(
    outsideRestore,
    /WriteRegStr HKCU "\$\{POSTAL_SNAP_LEGACY_MAILTO\}/,
  );
  assert.doesNotMatch(
    backup,
    /WriteRegStr HKCU "\$\{POSTAL_SNAP_LEGACY_MAILTO\}/,
  );
  // No partial delete of the shared command, which left stale skeletons.
  assert.doesNotMatch(
    hooks,
    /DeleteRegKey HKCU "\$\{POSTAL_SNAP_LEGACY_MAILTO\}\\shell/,
  );
  assert.doesNotMatch(hooks, /DeleteRegKey HKCU "Software\\Classes\\mailto"/);
  assert.doesNotMatch(
    preinstall + postinstall + backup,
    /DeleteRegKey HKCU "\$\{POSTAL_SNAP_BACKUP_KEY\}"/,
  );
  // Uninstall removals of app-owned keys must sit behind the upgrade guard.
  const guard = preuninstall.indexOf("${If} $UpdateMode <> 1");
  const removal = preuninstall.indexOf(
    'DeleteRegKey HKCU "Software\\Classes\\${POSTAL_SNAP_PROGID}"',
  );
  assert.ok(guard >= 0 && removal > guard, "ProgID removal must be guarded");
  assert.match(preuninstall, /DeleteRegKey HKCU "\$\{POSTAL_SNAP_CAPS_KEY\}"/);
  assert.match(
    preuninstall,
    /DeleteRegValue HKCU "\$\{POSTAL_SNAP_REGISTERED_APPS\}" "\$\{POSTAL_SNAP_APP_NAME\}"/,
  );
  // Backup key is removed on a real uninstall only, after any restore.
  const backupRemoval = preuninstall.indexOf(
    'DeleteRegKey HKCU "${POSTAL_SNAP_BACKUP_KEY}"',
  );
  assert.ok(backupRemoval > guard, "backup key removal must be guarded");
  assert.ok(
    preuninstall.indexOf("!insertmacro POSTAL_SNAP_RESTORE_MAILTO") <
      backupRemoval,
    "restore must run before the backup key is removed",
  );
  // Skeleton from 0.5.0 prerelease hooks is removed after Tauri's own delete.
  assert.match(postuninstall, /\$\{If\} \$UpdateMode <> 1/);
  assert.match(
    postuninstall,
    /ReadRegStr \$R0 HKCU "\$\{POSTAL_SNAP_LEGACY_MAILTO\}\\shell\\open\\command"/,
  );
  assert.match(
    postuninstall,
    /\$\{AndIf\} \$R1 == "\$\{POSTAL_SNAP_MAILTO_DEFAULT\}"/,
  );
  assert.match(
    postuninstall,
    /DeleteRegKey HKCU "\$\{POSTAL_SNAP_LEGACY_MAILTO\}"\n/,
  );
  // A deep-link scheme makes Tauri write the shared key, so the hook must back it up and restore it.
  const schemes = config.plugins?.["deep-link"]?.desktop?.schemes ?? [];
  if (schemes.includes("mailto")) {
    assert.match(
      hooks,
      /!insertmacro POSTAL_SNAP_BACKUP_MAILTO/,
      "mailto deep-link scheme requires the backup hook",
    );
    assert.match(
      hooks,
      /!insertmacro POSTAL_SNAP_RESTORE_MAILTO/,
      "mailto deep-link scheme requires the restore hook",
    );
  }
});

test("secret scanning ignores only TweetFeed IOC snapshots", async () => {
  const scanning = await readFile(
    join(root, ".github/secret_scanning.yml"),
    "utf8",
  );
  assert.match(scanning, /tweetfeed-urls\.txt/);
  assert.match(scanning, /tweetfeed-domains\.txt/);
  assert.doesNotMatch(scanning, /easylist|easyprivacy|settings\.json/);
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
    "SSH_USER_PWD",
    "POSTAL_SNAP_TEST_ICLOUD_EMAIL",
    "POSTAL_SNAP_TEST_ICLOUD_PASSWORD",
  ]) {
    assert.ok(names.has(name), `${name} is missing from .env.example`);
  }
  assert.ok(!names.has("GH_TOKEN"));
  assert.ok(!names.has("ALLOW_DIRTY_RELEASE"));
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
  const signingEnv = await readFile(
    join(root, "scripts/tauri-signing-env.js"),
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
  assert.match(packageJson.scripts["tauri:dev"], /tauri\.direct\.conf\.json/);
  assert.doesNotMatch(tauriBuild, /macOSPrivateApi/);
  assert.match(
    packageJson.scripts["build:win:x64:prepared"],
    /--require-windows-signing --target x86_64-pc-windows-msvc --bundles nsis/,
  );
  assert.doesNotMatch(tauriBuild, /WINDOWS_CERTIFICATE_THUMBPRINT/);
  assert.doesNotMatch(tauriBuild, /certificateThumbprint/);
  assert.match(tauriBuild, /windows-artifact-sign\.ps1/);
  assert.match(tauriBuild, /verify-windows-authenticode\.ps1/);
  assert.match(tauriBuild, /Postal-Snap-Windows-\$\{arch\}\.exe\.sig/);
  assert.match(tauriBuild, /Postal-Snap-Linux-\$\{arch\}\.AppImage\.sig/);
  assert.match(tauriBuild, /includeStderr: true/);
  assert.match(tauriBuild, /inspectCodesignDisplay/);
  assert.doesNotMatch(tauriBuild, /AppImage\.tar\.gz/);
  assert.doesNotMatch(tauriBuild, /Compress-Archive/);
  assert.match(signingEnv, /notarytool", "submit"/);
  assert.match(tauriBuild, /notarytoolSubmitArgs/);
  assert.match(
    tauriBuild,
    /APPLE_ID\/APPLE_PASSWORD\/APPLE_TEAM_ID for notarization/,
  );
  assert.match(signingEnv, /"--apple-id"/);
  assert.match(signingEnv, /"--password"/);
  assert.match(signingEnv, /ALLOW_UNSIGNED_WINDOWS/);
  assert.match(
    signingEnv,
    /SKIP_WIN_CODESIGN=1 is not allowed for signed Windows release builds/,
  );
  assert.match(tauriBuild, /stapler", "staple"/);
  assert.match(tauriBuild, /signer", "sign"/);
  assert.match(tauriBuild, /macosBundleExecutablePath/);
  assert.match(tauriBuild, /Print:CFBundleExecutable/);
  assert.match(tauriBuild, /lipo/);
  assert.match(signingEnv, /Hardened Runtime/);
  assert.match(signingEnv, /Authority=Developer ID Application:/);
  assert.match(signingEnv, /TeamIdentifier/);
  assert.match(setup, /Microsoft\.Azure\.ArtifactSigningClientTools/);
  assert.doesNotMatch(setup, /WINDOWS_CERTIFICATE_/);
  assert.doesNotMatch(setup, /Import-PfxCertificate/);
  assert.match(sign, /Get-ArtifactSigningTools/);
  assert.match(sign, /timestamp\.acs\.microsoft\.com/);
  assert.doesNotMatch(sign, /WINDOWS_CERTIFICATE_/);
  assert.doesNotMatch(sign, /AllowSparseMsix/);
  assert.match(verify, /AZURE_ARTIFACT_SIGNING_PUBLISHER/);
  assert.match(verify, /POSTAL_SNAP_INSTALLED_EXE/);
  assert.doesNotMatch(verify, /zinnia_shell|ZinniaContextMenu/);
  assert.match(verify, /artifactSigningPublicTrustEku/);
  assert.match(verify, /1\.3\.6\.1\.4\.1\.311\.97\.1\.0/);
  assert.doesNotMatch(verify, /nsis\.zip|Expand-Archive/);
  assert.match(sign, /1\.3\.6\.1\.4\.1\.311\.97\.1\.0/);
  assert.match(tauriBuild, /NO_STRIP/);
  assert.doesNotMatch(tauriBuild, /nsis\.zip/i);

  const ci = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(
    ci,
    /Microsoft\.Azure\.ArtifactSigningClientTools|ArtifactSigningClientTools\.msi/,
  );
  assert.match(ci, /Azure Artifact Signing/);
});

test("MAS uploads keep Apple passwords in the environment", async () => {
  const [buildMas, masArgs, docs] = await Promise.all([
    readFile(join(root, "scripts/build-mas.js"), "utf8"),
    readFile(join(root, "scripts/build-mas-args.js"), "utf8"),
    readFile(join(root, "docs/RELEASING.md"), "utf8"),
  ]);
  assert.match(masArgs, /@env:APPLE_PASSWORD/);
  assert.doesNotMatch(buildMas, /"--password"/);
  assert.match(docs, /APPLE_ID.*APPLE_PASSWORD.*APPLE_TEAM_ID/);
  assert.match(docs, /mac-keychain-ssh/);
});

test("release docs match current automation behavior", async () => {
  const docs = await readFile(join(root, "docs/RELEASING.md"), "utf8");
  assert.doesNotMatch(docs, /test:all[^\n]*still install/);
  assert.match(docs, /setup:e2e/);
  assert.match(docs, /ALLOW_UNSIGNED_WINDOWS/);
  assert.match(docs, /GPG_KEY_ID/);
  assert.match(docs, /setup-macos-ci-keychain/);
  assert.match(docs, /build:linux/);
});

test("release verification covers generated manifests after finalization", async () => {
  const verifier = await readFile(
    join(root, "scripts/verify-release-directory.js"),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.ok(
    verifier.includes("updaterManifestNames(platform, arch, pkg.version)"),
  );
  assert.ok(verifier.includes("beta ? 2 : 1"));
  assert.ok(verifier.includes("verifyTauriSignatureFile"));
  assert.ok(verifier.includes("gpgVerifyStatusArgs"));
  assert.ok(verifier.includes("assertGpgSignatureFingerprint"));
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
  assert.ok(finalizer.includes('"--pattern"'));
  assert.match(finalizer, /latest-.+-beta-/);
  const remoteVerifier = await readFile(
    join(root, "scripts/verify-release-draft.js"),
    "utf8",
  );
  assert.ok(remoteVerifier.includes('"download"'));
  assert.ok(remoteVerifier.includes("verify-release-directory.js"));
  assert.match(finalizer, /isLinuxAppImage/);
  assert.doesNotMatch(finalizer, /AppImage\.tar\.gz/);
  assert.ok(verifier.includes("Postal-Snap-Linux-x64.AppImage"));
  assert.doesNotMatch(verifier, /AppImage\.tar\.gz/);
  assert.doesNotMatch(remoteVerifier, /AppImage\.tar\.gz/);
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

test("release builds keep host build dependencies unstripped", async () => {
  const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
  assert.match(cargo, /\[profile\.release\][\s\S]*?^strip = true$/m);
  assert.match(
    cargo,
    /\[profile\.release\.build-override\]\s*\r?\nstrip = false/,
  );
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
  assert.equal(packageJson.scripts["test:e2e"], "node scripts/run-e2e.js");
  assert.equal(
    packageJson.scripts["test:cov"],
    "node scripts/headless-coverage.js",
  );
  assert.equal(
    packageJson.scripts["test:release-assets"],
    "node scripts/run-release-asset-tests.js",
  );
  const { collectReleaseAssetTestFiles } =
    await import("./run-release-asset-tests.js");
  const releaseTestFiles = collectReleaseAssetTestFiles(join(root, "scripts"));
  assert.ok(
    releaseTestFiles.some((path) => path.endsWith("release-assets.test.js")),
  );
  assert.ok(releaseTestFiles.some((path) => path.endsWith("utils.test.js")));
  assert.ok(
    !releaseTestFiles.some((path) => path.endsWith("safe-update.test.mjs")),
    "cargo-safe-update tests stay on test:cargo-safe-update only",
  );

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
  assert.match(testAll, /env\.SKIP_E2E/);
  assert.match(testAll, /POSTAL SNAP TEST SUITE/);
  assert.match(
    packageJson.scripts["prerelease:prepare"],
    /^node scripts\/release-warning\.js &&/,
  );

  const ci = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npx playwright install --with-deps chromium/);
  assert.match(ci, /npm run test:cov/);
  assert.match(ci, /npm run check:cargo-update-policy/);
  assert.match(ci, /npm run test:cargo-safe-update/);
  assert.match(ci, /test-linux:/);
  assert.match(ci, /name: compile-\$\{\{ matrix\.name \}\}/);
  assert.match(ci, /name: linux\s*\n\s*os: ubuntu-24\.04/);
  assert.match(ci, /name: macos\s*\n\s*os: macos-15/);
  assert.match(ci, /name: windows\s*\n\s*os: windows-2022/);
  assert.match(
    ci,
    /npm ci --ignore-scripts\s*\n\s*- run: npm run licenses\s*\n\s*- run: cargo check --locked/,
  );
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
    "node scripts/run-linux-release.js",
  );
  assert.equal(
    packageJson.scripts["release:linux:resume"],
    "node scripts/run-linux-release.js --resume",
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
    "node --test scripts/cargo/safe-update.test.mjs scripts/cargo/check-update-policy.test.mjs",
  );
  assert.equal(
    packageJson.scripts["check:cargo-update-policy"],
    "node scripts/check-cargo-update-policy.mjs",
  );
  assert.match(packageJson.scripts["u"], /cargo-safe-update\.mjs/);
  assert.match(packageJson.scripts["u"], /sync-version/);

  const testAll = await readFile(join(root, "scripts/test-all.js"), "utf8");
  assert.ok(testAll.includes('["run", "check:cargo-update-policy"]'));
  assert.ok(testAll.includes('["run", "test:cargo-safe-update"]'));
});

test("MSIX manifest declares the WebView2 runtime dependency", async () => {
  const pack = await readFile(join(root, "scripts/msstore-pack.js"), "utf8");
  assert.match(pack, /Microsoft\.Win32WebView2/);
});

test("Linux release paths run the baseline and WebKit preflight", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.match(
    packageJson.scripts["preflight:linux"],
    /--env-file-if-exists=\.env/,
    "Linux preflight must load the optional release environment override",
  );
  for (const name of [
    "build:linux:x64:prepared",
    "build:linux:arm64:prepared",
    "flatpak:bundle",
    "flatpak:bundle:arm64",
  ]) {
    assert.match(
      packageJson.scripts[name],
      /npm run preflight:linux &&/,
      `${name} must run the Linux release preflight`,
    );
  }
  const { assertLinuxBuildBaseline } = await import("./linux-preflight.js");
  assert.deepEqual(assertLinuxBuildBaseline({ platform: "darwin" }), {
    skipped: true,
  });
  const baseline = assertLinuxBuildBaseline({
    platform: "linux",
    glibcVersion: "2.39",
    webkitVersion: "2.52.6",
  });
  assert.equal(baseline.glibcVersion, "2.39");
  assert.throws(
    () =>
      assertLinuxBuildBaseline({
        platform: "linux",
        glibcVersion: "2.40",
        webkitVersion: "2.52.6",
      }),
    /glibc 2\.40 is newer than the 2\.39 baseline/,
  );
  assert.throws(
    () =>
      assertLinuxBuildBaseline({
        platform: "linux",
        glibcVersion: "2.35",
        webkitVersion: "2.52.5",
      }),
    /below the 2\.52\.6 security floor/,
  );
  const allowed = assertLinuxBuildBaseline({
    platform: "linux",
    glibcVersion: "2.40",
    webkitVersion: "2.52.6",
    allowNewerGlibc: true,
  });
  assert.equal(allowed.glibcVersion, "2.40");
});

test("platform CI runs Clippy and Cargo update integration tests on Windows and macOS", async () => {
  const ci = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  const compile = ci.split("\n  compile:\n")[1].split("\n  flatpak-lint:")[0];
  assert.match(compile, /components: clippy/);
  assert.match(
    compile,
    /- if: matrix\.name != 'linux'\s*\n\s*run: npm run lint:rust/,
  );
  assert.match(
    compile,
    /- if: matrix\.name != 'linux'\s*\n\s*run: npm run test:cargo-safe-update/,
  );
});
