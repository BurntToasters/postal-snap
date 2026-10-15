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
  githubJson,
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

function parseSemver(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    String(value ?? ""),
  );
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error("Invalid SemVer for comparison.");
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) {
    return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i];
    const r = y.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) < Number(r) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// Newest published prerelease tag above the stable version, else null.
export function selectNewerPrerelease(releases, stableVersion) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || !release.prerelease) continue;
    const version = String(release.tag_name ?? "").replace(/^v/, "");
    if (!parseSemver(version) || !version.includes("-")) continue;
    if (compareSemver(version, stableVersion) <= 0) continue;
    if (!best || compareSemver(version, best.version) > 0) {
      best = { version, tag: release.tag_name };
    }
  }
  return best?.tag ?? null;
}

// Page through /releases; one page of 100 misses older-listed prereleases.
export async function fetchAllReleases(
  fetchPage,
  { perPage = 100, maxPages = 50 } = {},
) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await fetchPage(page);
    if (!Array.isArray(items)) {
      throw new Error("GitHub returned an unexpected releases response.");
    }
    all.push(...items);
    if (items.length < perPage) break;
  }
  return all;
}

const PRERELEASE_TAG = /^v\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;

// `--from <tag>` picks the beta release to copy manifests from.
export function parseFromTag(argv) {
  const index = argv.indexOf("--from");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || !PRERELEASE_TAG.test(value)) {
    throw new Error("--from needs a prerelease tag such as v0.5.0-beta.2.");
  }
  return value;
}

export function recoveryHint(tag) {
  return `Recover with: npm run release:sync-beta-manifests -- --from ${tag}`;
}

// Runs after publish: never fails the release; warns with a recovery step.
export async function reconcileNewerPrereleaseFor({
  version,
  fetchReleases,
  sync,
  warn = console.warn,
}) {
  let tagName = null;
  try {
    tagName = selectNewerPrerelease(await fetchReleases(), version);
    if (tagName) await sync(tagName);
    return { synced: tagName, warning: null };
  } catch (error) {
    const reason = String(error?.message ?? error).split("\n")[0];
    const warning = error?.skipBeta
      ? `Release ${version} is published. Skipped beta sync: ${reason}\nThe stable release's own beta manifests stay live.`
      : `Release ${version} is published, but the beta feed was not reconciled: ${reason}\n${recoveryHint(tagName ?? "<newest-beta-tag>")}`;
    warn(`WARNING: ${warning}`);
    return { synced: null, warning };
  }
}

// Stable manifests plus beta copies (two keys); beta versions emit beta only.
export function buildUpdaterManifests({
  version,
  tag,
  platform,
  arch,
  payload,
  signature,
  pubDate = new Date().toISOString(),
}) {
  const entry = {
    signature,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(payload)}`,
  };
  const make = (platforms) => ({
    version,
    notes: `Postal Snap ${version}`,
    pub_date: pubDate,
    platforms,
  });
  const out = [];
  if (!version.includes("-")) {
    out.push({
      filename: `latest-${platform}-${arch}.json`,
      manifest: make({ [`${platform}-${arch}`]: entry }),
    });
  }
  out.push({
    filename: `latest-${platform}-beta-${arch}.json`,
    manifest: make({
      [`${platform}-beta`]: { ...entry },
      [`${platform}-${arch}`]: { ...entry },
    }),
  });
  return out;
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
  verifyDraftIdentity,
  syncBetaManifests,
  publish,
  verifyPublished,
  reconcileBetaManifests,
  reconcileNewerPrerelease,
} = {}) {
  await verifyDraft();
  await verifyDraftIdentity();
  if (prerelease) {
    await syncBetaManifests();
    await verifyDraftIdentity();
  }
  await publish();
  await verifyPublished();
  if (prerelease) await reconcileBetaManifests();
  else if (reconcileNewerPrerelease) await reconcileNewerPrerelease();
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

const ghDeps = { output: githubOutput, run: runGitHub };

export async function syncRemoteBetaManifests(tag, deps = ghDeps) {
  const { output, run: gh } = { ...ghDeps, ...deps };
  const version = tag.replace(/^v/, "");
  if (!PRERELEASE_TAG.test(tag)) {
    throw new Error(`${tag} is not a prerelease tag; refusing beta sync.`);
  }
  const stableTag = output([
    "api",
    `repos/${repository}/releases/latest`,
    "--jq",
    ".tag_name",
  ]);
  if (!stableTag || stableTag === tag || stableTag.includes("-")) {
    throw new Error(
      "Beta manifests must be uploaded to the latest stable release, which was not found.",
    );
  }
  const remoteNames = output([
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
      await gh([
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
    for (const filePath of betaFiles) {
      const manifest = JSON.parse(await readFile(filePath, "utf8"));
      validateManifest(manifest);
      const platform = /^latest-(.+)-beta-(?:x86_64|aarch64)\.json$/.exec(
        basename(filePath),
      )?.[1];
      if (!platform || !manifest.platforms?.[`${platform}-beta`]) {
        const error = new Error(
          `${basename(filePath)} lacks the ${platform}-beta key (older tooling); not syncing ${tag}.`,
        );
        error.skipBeta = true;
        throw error;
      }
      if (manifest.version !== version) {
        throw new Error(
          `${basename(filePath)} is version ${manifest.version}, expected ${version}.`,
        );
      }
    }
    console.log(
      "[1/1] Uploading beta manifests to the latest stable release...",
    );
    await gh(betaManifestUploadArgs(stableTag, betaFiles));
    for (const filePath of betaFiles) {
      console.log(`  ~ synced ${basename(filePath)} to latest stable release`);
    }
  } finally {
    await rmRetry(staging, { recursive: true });
  }
  console.log("Done: beta manifests synced to latest stable release.\n");
}

export function fetchReleasesFromGitHub() {
  return fetchAllReleases((page) => {
    const items = githubJson([
      "api",
      `repos/${repository}/releases?per_page=100&page=${page}`,
    ]);
    return items;
  });
}

// Updater manifests for one signed payload, validated; null if unsupported.
export function manifestsForPayload({
  version,
  tag,
  payload,
  signature,
  pubDate,
}) {
  const platform = artifactPlatform(payload);
  const detectedArch = artifactArch(payload);
  const arches =
    detectedArch === "universal" ? ["x86_64", "aarch64"] : [detectedArch];
  const out = [];
  for (const arch of arches) {
    if (!platform || !arch) continue;
    for (const built of buildUpdaterManifests({
      version,
      tag,
      platform,
      arch,
      payload,
      signature,
      ...(pubDate ? { pubDate } : {}),
    })) {
      validateManifest(built.manifest);
      out.push(built);
    }
  }
  return out;
}

export function publishArgs(tag, prerelease) {
  return [
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    ...(prerelease ? ["--prerelease"] : ["--latest"]),
  ];
}

async function main() {
  const pkg = await json(join(root, "package.json"));
  const tag = `v${pkg.version}`;
  const directory = await ensureReleaseDir();
  const prerelease = pkg.version.includes("-");

  console.log(`\nPostal Snap ${pkg.version} — release pipeline\n`);
  assertGitHubCliAuthenticated();

  if (process.argv.includes("--sync-beta-manifests")) {
    await syncRemoteBetaManifests(parseFromTag(process.argv) ?? tag);
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
    for (const { filename, manifest } of manifestsForPayload({
      version: pkg.version,
      tag,
      payload,
      signature,
    })) {
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
      verifyDraftIdentity: () => verifyDraftReleaseCommit(repository, session),
      syncBetaManifests: () => syncLocalBetaManifests(directory),
      publish: () => runGitHub(publishArgs(tag, prerelease)),
      verifyPublished: () => verifyRemoteReleaseCommit(repository, session),
      reconcileBetaManifests: async () => {
        try {
          await run("node", [
            "scripts/finalize-release.js",
            "--sync-beta-manifests",
          ]);
        } catch (error) {
          throw new Error(
            `Release ${pkg.version} is published, but the beta feed was not synced.\n${recoveryHint(tag)}`,
            { cause: error },
          );
        }
      },
      reconcileNewerPrerelease: () =>
        reconcileNewerPrereleaseFor({
          version: pkg.version,
          fetchReleases: fetchReleasesFromGitHub,
          sync: syncRemoteBetaManifests,
        }),
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
