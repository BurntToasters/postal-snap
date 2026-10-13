import assert from "node:assert/strict";
import test from "node:test";
import {
  betaManifestUploadArgs,
  runHardFinalize,
  selectBetaManifests,
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
