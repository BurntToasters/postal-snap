import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactArch,
  artifactPlatform,
  basename,
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

console.log(`\nPostal Snap ${pkg.version} — release pipeline\n`);
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
  console.log("[1/1] Uploading beta manifests to the latest stable release...");
  runGitHub([
    "release",
    "upload",
    stableTag,
    ...betaFiles,
    "--repo",
    repository,
    "--clobber",
  ]);
  for (const filePath of betaFiles) {
    console.log(`  ~ synced ${basename(filePath)} to latest stable release`);
  }
  console.log("Done: beta manifests synced to latest stable release.\n");
  process.exit(0);
}

const session = await verifiedReleaseSession();
const hardFinalize = process.argv.includes("--hard");
console.log("[1/3] Verifying draft...");
await verifyDraftReleaseCommit(repository, session);

console.log("[2/3] Generating updater manifests...");
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
  `\nDone — ${tag} uploaded as ${hardFinalize ? "published" : "draft"}.\n`,
);
