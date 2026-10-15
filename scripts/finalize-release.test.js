import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  betaManifestUploadArgs,
  buildUpdaterManifests,
  fetchAllReleases,
  parseFromTag,
  reconcileNewerPrereleaseFor,
  syncRemoteBetaManifests,
  runHardFinalize,
  selectBetaManifests,
  selectNewerPrerelease,
} from "./finalize-release.js";

test("selectBetaManifests keeps only beta updater manifests", () => {
  assert.deepEqual(
    selectBetaManifests([
      "latest-windows-x86_64.json",
      "latest-windows-beta-x86_64.json",
      "Postal-Snap-Windows-x64.exe",
      "latest-darwin-beta-aarch64.json",
      "latest-linux-beta-x86_64.txt",
    ]),
    ["latest-darwin-beta-aarch64.json", "latest-windows-beta-x86_64.json"],
  );
  assert.deepEqual(selectBetaManifests(undefined), []);
});

test("betaManifestUploadArgs clobbers into the stable release", () => {
  assert.deepEqual(betaManifestUploadArgs("v0.1.8", ["a.json", "b.json"]), [
    "release",
    "upload",
    "v0.1.8",
    "a.json",
    "b.json",
    "--repo",
    "BurntToasters/postal-snap",
    "--clobber",
  ]);
});

test("runHardFinalize syncs beta manifests before publishing", async () => {
  const calls = [];
  await runHardFinalize({
    prerelease: true,
    verifyDraft: async () => calls.push("verifyDraft"),
    verifyDraftIdentity: async () => calls.push("verifyDraftIdentity"),
    syncBetaManifests: async () => calls.push("syncBeta"),
    publish: async () => calls.push("publish"),
    verifyPublished: async () => calls.push("verifyPublished"),
    reconcileBetaManifests: async () => calls.push("reconcile"),
  });
  assert.deepEqual(calls, [
    "verifyDraft",
    "verifyDraftIdentity",
    "syncBeta",
    "verifyDraftIdentity",
    "publish",
    "verifyPublished",
    "reconcile",
  ]);
});

test("a failed pre-publish beta sync can never leave a published release", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      runHardFinalize({
        prerelease: true,
        verifyDraft: async () => calls.push("verifyDraft"),
        verifyDraftIdentity: async () => calls.push("verifyDraftIdentity"),
        syncBetaManifests: async () => {
          calls.push("syncBeta");
          throw new Error("sync failed");
        },
        publish: async () => calls.push("publish"),
        verifyPublished: async () => calls.push("verifyPublished"),
        reconcileBetaManifests: async () => calls.push("reconcile"),
      }),
    /sync failed/,
  );
  assert.deepEqual(calls, ["verifyDraft", "verifyDraftIdentity", "syncBeta"]);
});

test("a pre-publish tag mismatch prevents release publication", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      runHardFinalize({
        prerelease: false,
        verifyDraft: async () => calls.push("verifyDraft"),
        verifyDraftIdentity: async () => {
          calls.push("verifyDraftIdentity");
          throw new Error("tag commit mismatch");
        },
        syncBetaManifests: async () => calls.push("syncBeta"),
        publish: async () => calls.push("publish"),
        verifyPublished: async () => calls.push("verifyPublished"),
        reconcileBetaManifests: async () => calls.push("reconcile"),
      }),
    /tag commit mismatch/,
  );
  assert.deepEqual(calls, ["verifyDraft", "verifyDraftIdentity"]);
});

test("a draft identity mismatch prevents beta-manifest mutation", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      runHardFinalize({
        prerelease: true,
        verifyDraft: async () => calls.push("verifyDraft"),
        verifyDraftIdentity: async () => {
          calls.push("verifyDraftIdentity");
          throw new Error("draft identity mismatch");
        },
        syncBetaManifests: async () => calls.push("syncBeta"),
        publish: async () => calls.push("publish"),
        verifyPublished: async () => calls.push("verifyPublished"),
        reconcileBetaManifests: async () => calls.push("reconcile"),
      }),
    /draft identity mismatch/,
  );
  assert.deepEqual(calls, ["verifyDraft", "verifyDraftIdentity"]);
});

test("stable finalize never touches beta manifests", async () => {
  const calls = [];
  await runHardFinalize({
    prerelease: false,
    verifyDraft: async () => calls.push("verifyDraft"),
    verifyDraftIdentity: async () => calls.push("verifyDraftIdentity"),
    syncBetaManifests: async () => calls.push("syncBeta"),
    publish: async () => calls.push("publish"),
    verifyPublished: async () => calls.push("verifyPublished"),
    reconcileBetaManifests: async () => calls.push("reconcile"),
  });
  assert.deepEqual(calls, [
    "verifyDraft",
    "verifyDraftIdentity",
    "publish",
    "verifyPublished",
  ]);
});

const sig = "s".repeat(80);
const build = (version) =>
  buildUpdaterManifests({
    version,
    tag: `v${version}`,
    platform: "darwin",
    arch: "aarch64",
    payload: "Postal-Snap-macOS.app.tar.gz",
    signature: sig,
  });

test("stable versions emit stable and beta manifests", () => {
  const out = build("0.4.3");
  assert.deepEqual(
    out.map((m) => m.filename),
    ["latest-darwin-aarch64.json", "latest-darwin-beta-aarch64.json"],
  );
  assert.deepEqual(Object.keys(out[0].manifest.platforms), ["darwin-aarch64"]);
});

test("beta versions emit only beta manifests", () => {
  const out = build("0.4.4-beta.1");
  assert.deepEqual(
    out.map((m) => m.filename),
    ["latest-darwin-beta-aarch64.json"],
  );
});

test("beta manifests carry both platform keys with the same payload", () => {
  for (const version of ["0.4.3", "0.4.4-beta.1"]) {
    const beta = build(version).find((m) => m.filename.includes("-beta-"));
    const { platforms } = beta.manifest;
    assert.deepEqual(Object.keys(platforms).sort(), [
      "darwin-aarch64",
      "darwin-beta",
    ]);
    assert.deepEqual(platforms["darwin-beta"], platforms["darwin-aarch64"]);
    assert.equal(
      platforms["darwin-beta"].url,
      `https://github.com/BurntToasters/postal-snap/releases/download/v${version}/Postal-Snap-macOS.app.tar.gz`,
    );
    assert.equal(platforms["darwin-beta"].signature, sig);
  }
});

test("selectNewerPrerelease picks the newest published newer prerelease", () => {
  const releases = [
    { tag_name: "v0.4.4-beta.1", prerelease: true, draft: false },
    { tag_name: "v0.4.4-beta.2", prerelease: true, draft: false },
    { tag_name: "v0.4.4-beta.3", prerelease: true, draft: true },
    { tag_name: "v0.4.2-beta.9", prerelease: true, draft: false },
    { tag_name: "v0.4.3", prerelease: false, draft: false },
  ];
  assert.equal(selectNewerPrerelease(releases, "0.4.3"), "v0.4.4-beta.2");
  assert.equal(
    selectNewerPrerelease(
      [
        { tag_name: "v0.4.4-beta.10", prerelease: true, draft: false },
        ...releases,
      ],
      "0.4.3",
    ),
    "v0.4.4-beta.10",
  );
});

test("selectNewerPrerelease ignores drafts, older, and same-core betas", () => {
  assert.equal(
    selectNewerPrerelease(
      [
        { tag_name: "v0.4.4-beta.1", prerelease: true, draft: true },
        { tag_name: "v0.4.3-beta.5", prerelease: true, draft: false },
        { tag_name: "v0.4.2-beta.1", prerelease: true, draft: false },
      ],
      "0.4.3",
    ),
    null,
  );
  assert.equal(selectNewerPrerelease(undefined, "0.4.3"), null);
});

test("stable hard finalize reconciles newer prerelease after verify", async () => {
  const calls = [];
  await runHardFinalize({
    prerelease: false,
    verifyDraft: async () => calls.push("verifyDraft"),
    verifyDraftIdentity: async () => calls.push("verifyDraftIdentity"),
    syncBetaManifests: async () => calls.push("syncBeta"),
    publish: async () => calls.push("publish"),
    verifyPublished: async () => calls.push("verifyPublished"),
    reconcileBetaManifests: async () => calls.push("reconcile"),
    reconcileNewerPrerelease: async () => calls.push("reconcileNewer"),
  });
  assert.deepEqual(calls, [
    "verifyDraft",
    "verifyDraftIdentity",
    "publish",
    "verifyPublished",
    "reconcileNewer",
  ]);
});

test("beta hard finalize does not run the stable prerelease reconcile", async () => {
  const calls = [];
  await runHardFinalize({
    prerelease: true,
    verifyDraft: async () => {},
    verifyDraftIdentity: async () => {},
    syncBetaManifests: async () => {},
    publish: async () => {},
    verifyPublished: async () => {},
    reconcileBetaManifests: async () => calls.push("reconcile"),
    reconcileNewerPrerelease: async () => calls.push("reconcileNewer"),
  });
  assert.deepEqual(calls, ["reconcile"]);
});

const rel = (tag, extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes("-"),
  ...extra,
});
const SIG = "s".repeat(60);
const betaManifest = (version) => ({
  version,
  notes: "n",
  pub_date: "2026-01-01T00:00:00Z",
  platforms: {
    "linux-beta": {
      signature: SIG,
      url: "https://github.com/BurntToasters/postal-snap/releases/download/x/a",
    },
  },
});

test("fetchAllReleases walks every page and stops on a short page", async () => {
  const pages = [
    Array.from({ length: 100 }, (_, i) => rel(`v0.1.${i}`)),
    Array.from({ length: 100 }, (_, i) => rel(`v0.2.${i}`)),
    [rel("v0.5.0-beta.2")],
  ];
  const seen = [];
  const all = await fetchAllReleases(async (n) => {
    seen.push(n);
    return pages[n - 1] ?? [];
  });
  assert.equal(all.length, 201);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(selectNewerPrerelease(all, "0.4.3"), "v0.5.0-beta.2");
});

test("fetchAllReleases handles an exact-full last page and bad payloads", async () => {
  const full = Array.from({ length: 100 }, (_, i) => rel(`v0.1.${i}`));
  const seen = [];
  const all = await fetchAllReleases(async (n) => {
    seen.push(n);
    return n === 1 ? full : [];
  });
  assert.equal(all.length, 100);
  assert.deepEqual(seen, [1, 2]);
  await assert.rejects(
    fetchAllReleases(async () => ({ message: "x" })),
    /unexpected/i,
  );
});

test("reconcile api failure after publish warns and does not throw", async () => {
  let synced = false;
  const warnings = [];
  const result = await reconcileNewerPrereleaseFor({
    version: "0.4.3",
    warn: (m) => warnings.push(m),
    fetchReleases: async () => {
      throw new Error("gh api failed with status 1:\nHTTP 502\n  at x");
    },
    sync: async () => {
      synced = true;
    },
  });
  assert.equal(synced, false);
  assert.equal(result.synced, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /0\.4\.3 is published/);
  assert.match(warnings[0], /release:sync-beta-manifests -- --from/);
  assert.doesNotMatch(warnings[0], /\n\s+at /);
});

test("reconcile sync failure warns with the exact tag to recover", async () => {
  const warnings = [];
  await reconcileNewerPrereleaseFor({
    version: "0.4.3",
    warn: (m) => warnings.push(m),
    fetchReleases: async () => [rel("v0.5.0-beta.2")],
    sync: async () => {
      throw new Error("boom\nsecond line");
    },
  });
  assert.match(warnings[0], /--from v0\.5\.0-beta\.2/);
});

test("beta manifests lacking the platform-beta key are skipped with a warning", async () => {
  const legacy = betaManifest("0.5.0-beta.2");
  legacy.platforms = { "linux-x86_64": legacy.platforms["linux-beta"] };
  const f = fakeGh({ files: { "latest-linux-beta-x86_64.json": legacy } });
  await assert.rejects(
    syncRemoteBetaManifests("v0.5.0-beta.2", f.deps),
    (e) => e.skipBeta === true && /linux-beta/.test(e.message),
  );
  assert.equal(
    f.calls.some((c) => c[1] === "upload"),
    false,
  );
  const warnings = [];
  const result = await reconcileNewerPrereleaseFor({
    version: "0.4.3",
    warn: (m) => warnings.push(m),
    fetchReleases: async () => [rel("v0.5.0-beta.2")],
    sync: (tag) => syncRemoteBetaManifests(tag, f.deps),
  });
  assert.equal(result.synced, null);
  assert.match(warnings[0], /stay live/);
  assert.doesNotMatch(warnings[0], /Recover with/);
});

test("reconcile does nothing without a newer prerelease", async () => {
  let synced = false;
  await reconcileNewerPrereleaseFor({
    version: "0.4.3",
    fetchReleases: async () => [
      rel("v0.4.2"),
      rel("v0.4.3"),
      rel("v0.4.4-beta.1", { draft: true }),
    ],
    sync: async () => {
      synced = true;
    },
  });
  assert.equal(synced, false);
});

function fakeGh({ files, stable = "v0.4.3" }) {
  const calls = [];
  return {
    calls,
    deps: {
      output(args) {
        calls.push(args);
        if (args[0] === "api") return stable;
        return Object.keys(files).join("\n");
      },
      async run(args) {
        calls.push(args);
        if (args[1] === "download") {
          const name = args[args.indexOf("--pattern") + 1];
          await writeFile(
            join(args[args.indexOf("--dir") + 1], name),
            JSON.stringify(files[name]),
          );
        }
      },
    },
  };
}

test("beta sync uploads valid matching manifests to the latest stable", async () => {
  const f = fakeGh({
    files: { "latest-linux-beta-x86_64.json": betaManifest("0.5.0-beta.2") },
  });
  await syncRemoteBetaManifests("v0.5.0-beta.2", f.deps);
  const upload = f.calls.find((c) => c[1] === "upload");
  assert.equal(upload[2], "v0.4.3");
});

test("beta sync refuses wrong-version or invalid manifests before upload", async () => {
  for (const manifest of [
    betaManifest("0.5.0-beta.1"),
    {
      ...betaManifest("0.5.0-beta.2"),
      platforms: {
        "linux-beta": { url: "https://evil.example/a", signature: SIG },
      },
    },
  ]) {
    const f = fakeGh({ files: { "latest-linux-beta-x86_64.json": manifest } });
    await assert.rejects(syncRemoteBetaManifests("v0.5.0-beta.2", f.deps));
    assert.equal(
      f.calls.some((c) => c[1] === "upload"),
      false,
    );
  }
});

test("beta sync never targets the release being published or a stable tag", async () => {
  const f = fakeGh({
    files: { "latest-linux-beta-x86_64.json": betaManifest("0.5.0-beta.2") },
    stable: "v0.5.0-beta.2",
  });
  await assert.rejects(
    syncRemoteBetaManifests("v0.5.0-beta.2", f.deps),
    /stable/i,
  );
  await assert.rejects(
    syncRemoteBetaManifests("v0.4.3", fakeGh({ files: {} }).deps),
    /prerelease/i,
  );
  assert.equal(
    f.calls.some((c) => c[1] === "upload"),
    false,
  );
});

test("parseFromTag accepts only prerelease tags", () => {
  assert.equal(parseFromTag(["--sync-beta-manifests"]), null);
  assert.equal(parseFromTag(["--from", "v0.5.0-beta.2"]), "v0.5.0-beta.2");
  for (const bad of ["v0.4.3", "../x", "v0.5.0-beta.1;rm"]) {
    assert.throws(() => parseFromTag(["--from", bad]));
  }
  assert.throws(() => parseFromTag(["--from"]));
});
