import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactArch,
  artifactPlatform,
  ensureReleaseDir,
  json,
  process,
  root,
  run,
  writeJson,
  readFile,
} from "./_utils.js";
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

const repository = "BurntToasters/postal-snap";
const pkg = await json(join(root, "package.json"));
const tag = `v${pkg.version}`;
const directory = await ensureReleaseDir();
const prerelease = pkg.version.includes("-");

assertGitHubCliAuthenticated();

if (process.argv.includes("--sync-beta-manifests")) {
  let stableTag;
  try {
    stableTag = githubOutput([
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
  const betaFiles = (await readdir(directory))
    .filter((name) => /^latest-.+-beta-(x86_64|aarch64)\.json$/.test(name))
    .map((name) => join(directory, name));
  if (!betaFiles.length)
    throw new Error("No beta updater manifests are staged.");
  runGitHub([
    "release",
    "upload",
    stableTag,
    ...betaFiles,
    "--repo",
    repository,
    "--clobber",
  ]);
  process.exit(0);
}

const session = await verifiedReleaseSession();
const hardFinalize = process.argv.includes("--hard");
await verifyDraftReleaseCommit(repository, session);

const artifacts = await readdir(directory);
const updaterPayloads = artifacts.filter((name) =>
  /\.(nsis\.zip|app\.tar\.gz|AppImage\.tar\.gz)$/.test(name),
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
  }
}

const upload = (await readdir(directory))
  .filter((name) => name !== ".session.json")
  .map((name) => join(directory, name));
if (!upload.length) throw new Error("Nothing is staged in release/.");
runGitHub([
  "release",
  "upload",
  tag,
  ...upload,
  "--repo",
  repository,
  "--clobber",
]);
if (hardFinalize) {
  await run("node", ["scripts/verify-release-draft.js"]);
  runGitHub([
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    ...(prerelease ? ["--prerelease"] : ["--latest"]),
  ]);
  await verifyRemoteReleaseCommit(repository, session);
  if (prerelease)
    await run("node", ["scripts/finalize-release.js", "--sync-beta-manifests"]);
}
console.log(
  `Uploaded Postal Snap ${pkg.version} release assets${hardFinalize ? " and published the release" : " to the draft"}.`,
);
