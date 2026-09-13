import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactArch,
  artifactPlatform,
  isLinuxAppImage,
} from "./lib/artifacts.js";
import { ensureReleaseDir, json, writeJson } from "./lib/json.js";
import { basename, process, readFile, root } from "./lib/paths.js";
import { rmRetry, run } from "./lib/spawn.js";
import {
  assertGitHubCliAuthenticated,
  githubOutput,
  runGitHub,
} from "./github-cli.js";
import { validateManifest } from "./validate-updater-manifest.js";
import {
  verifiedReleaseSession,
  verifyDraftReleaseCommit,
  verifyRemoteReleaseCommit,
} from "./release-identity.js";

export const repository = "BurntToasters/postal-snap";
export const BETA_MANIFEST_PATTERN = /^latest-.+-beta-(x86_64|aarch64)\.json$/;

export function selectBetaManifests(names) {
  return (Array.isArray(names) ? names : [])
    .filter((name) => BETA_MANIFEST_PATTERN.test(name))
    .sort();
}

export function betaManifestUploadArgs(stableTag, files) {
  return [
    "release",
    "upload",
    stableTag,
    ...files,
    "--repo",
    repository,
    "--clobber",
  ];
}

// Beta manifests are uploaded while the beta release is still a draft so a
// failed sync aborts before publication. The post-publish reconcile keeps the
// stable endpoint current if the stable release moved during publication.
// Intended tradeoff: if publication then fails, beta clients can see the
// uploaded manifests 404 until the next publish; that brief window is accepted.
export async function runHardFinalize({
  prerelease,
  verifyDraft,
  syncBetaManifests,
  publish,
  verifyRemote,
  reconcileBetaManifests,
} = {}) {
  await verifyDraft();
  if (prerelease) await syncBetaManifests();
  await publish();
  await verifyRemote();
  if (prerelease) await reconcileBetaManifests();
}

function resolveLatestStableTag() {
  try {
    return githubOutput([
      "api",
      `repos/${repository}/releases/latest`,
      "--jq",
      ".tag_name",
    ]);
  } catch {
    throw new Error(
      "Beta updater manifests require an existing stable release. Publish the initial stable release first.",
    );
  }
}

export async function syncLocalBetaManifests(directory) {
  const stableTag = resolveLatestStableTag();
  const files = selectBetaManifests(await readdir(directory)).map((name) =>
    join(directory, name),
  );
  if (!files.length) {
    throw new Error("No beta updater manifests are staged in release/.");
  }
  console.log(
    "Syncing beta manifests to the latest stable release before publish...",
  );
  runGitHub(betaManifestUploadArgs(stableTag, files));
  for (const filePath of files) {
    console.log(`  ~ synced ${basename(filePath)} to latest stable release`);
  }
}

async function syncRemoteBetaManifests(tag) {
  const stableTag = resolveLatestStableTag();
  const remoteNames = githubOutput([
    "release",
    "view",
    tag,
    "--repo",
    repository,
    "--json",
    "assets",
    "--jq",
    '[.assets[].name | select(test("^latest-.+-beta-(x86_64|aarch64)\\\\.json$"))] | .[]',
  ])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!remoteNames.length)
    throw new Error(
      "No beta updater manifests are on the published beta release.",
    );
  const staging = await mkdtemp(join(tmpdir(), "postal-snap-beta-manifests-"));
  try {
    for (const name of remoteNames) {
      runGitHub([
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--pattern",
        name,
        "--dir",
        staging,
        "--clobber",
      ]);
    }
    const betaFiles = selectBetaManifests(await readdir(staging)).map((name) =>
      join(staging, name),
    );
    if (!betaFiles.length)
      throw new Error("Downloaded beta updater manifests were empty.");
    console.log(
      "[1/1] Uploading beta manifests to the latest stable release...",
    );
    runGitHub(betaManifestUploadArgs(stableTag, betaFiles));
    for (const filePath of betaFiles) {
      console.log(`  ~ synced ${basename(filePath)} to latest stable release`);
    }
  } finally {
    await rmRetry(staging, { recursive: true });
  }
  console.log("Done: beta manifests synced to latest stable release.\n");
}

async function main() {
  const pkg = await json(join(root, "package.json"));
  const tag = `v${pkg.version}`;
  const directory = await ensureReleaseDir();
  const prerelease = pkg.version.includes("-");

  console.log(`\nPostal Snap ${pkg.version} — release pipeline\n`);
  assertGitHubCliAuthenticated();

  if (process.argv.includes("--sync-beta-manifests")) {
    await syncRemoteBetaManifests(tag);
    return;
  }

  const session = await verifiedReleaseSession();
  const hardFinalize = process.argv.includes("--hard");
  console.log("[1/3] Verifying draft...");
  await verifyDraftReleaseCommit(repository, session);

  console.log("[2/3] Generating updater manifests...");
  const artifacts = await readdir(directory);
  const updaterPayloads = artifacts.filter(
    (name) =>
      /\.app\.tar\.gz$/.test(name) ||
      (/^Postal-Snap-Windows-(x64|arm64)\.exe$/.test(name) &&
        artifacts.includes(`${name}.sig`)) ||
      (isLinuxAppImage(name) && artifacts.includes(`${name}.sig`)),
  );
  for (const payload of updaterPayloads) {
    const signaturePath = join(directory, `${payload}.sig`);
    let signature;
    try {
      signature = (await readFile(signaturePath, "utf8")).trim();
    } catch {
      throw new Error(`Missing embedded Tauri signature for ${payload}`);
    }
    const platform = artifactPlatform(payload);
    const detectedArch = artifactArch(payload);
    const arches =
      detectedArch === "universal" ? ["x86_64", "aarch64"] : [detectedArch];
    for (const arch of arches) {
      if (!platform || !arch) continue;
      const filename = `latest-${platform}${prerelease ? "-beta" : ""}-${arch}.json`;
      const manifest = {
        version: pkg.version,
        notes: `Postal Snap ${pkg.version}`,
        pub_date: new Date().toISOString(),
        platforms: {
          [`${platform}-${arch}`]: {
            signature,
            url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(payload)}`,
          },
        },
      };
      validateManifest(manifest);
      await writeJson(join(directory, filename), manifest);
      console.log(`  + ${filename}`);
    }
  }

  const upload = (await readdir(directory))
    .filter((name) => name !== ".session.json")
    .map((name) => join(directory, name));
  if (!upload.length) throw new Error("Nothing is staged in release/.");
  console.log("[3/3] Uploading to GitHub...");
  runGitHub([
    "release",
    "upload",
    tag,
    ...upload,
    "--repo",
    repository,
    "--clobber",
  ]);
  for (const filePath of upload) console.log(`  ^ ${basename(filePath)}`);

  if (hardFinalize) {
    await runHardFinalize({
      prerelease,
      verifyDraft: () => run("node", ["scripts/verify-release-draft.js"]),
      syncBetaManifests: () => syncLocalBetaManifests(directory),
      publish: () =>
        runGitHub([
          "release",
          "edit",
          tag,
          "--repo",
          repository,
          "--draft=false",
          ...(prerelease ? ["--prerelease"] : ["--latest"]),
        ]),
      verifyRemote: () => verifyRemoteReleaseCommit(repository, session),
      reconcileBetaManifests: () =>
        run("node", ["scripts/finalize-release.js", "--sync-beta-manifests"]),
    });
  }
  console.log(
    `\nDone — ${tag} uploaded as ${hardFinalize ? "published" : "draft"}.\n`,
  );
}

export function isDirectExecution(argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return basename(entry).toLowerCase() === "finalize-release.js";
}

if (isDirectExecution()) {
  await main();
}
