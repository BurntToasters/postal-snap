import { basename, join } from "node:path";
import { updaterManifestNames } from "./lib/artifacts.js";
import { json } from "./lib/json.js";
import { process, root } from "./lib/paths.js";
import { validateManifest } from "./validate-updater-manifest.js";

const expectedCurrent = process.argv.includes("--expected-version=current");
const pkg = await json(join(root, "package.json"));
const targets = [
  ["windows", "x86_64"],
  ["windows", "aarch64"],
  ["darwin", "x86_64"],
  ["darwin", "aarch64"],
  ["linux", "x86_64"],
];
const optionalTargets = [["linux", "aarch64"]];

export { updaterManifestNames };

function isOptionalTarget(platform, arch) {
  return optionalTargets.some(
    ([optionalPlatform, optionalArch]) =>
      optionalPlatform === platform && optionalArch === arch,
  );
}

export function shouldSkipMissingTarget(platform, arch, status) {
  return status === 404 && isOptionalTarget(platform, arch);
}

export function isBetaManifestName(filename) {
  return String(filename ?? "").includes("-beta-");
}

// Filename-aware shape check: the manifest must carry the expected
// platform-arch key, and beta manifests must also carry the matching
// platform-beta alias with the same payload. Signature content stays with
// the dedicated Tauri verifier; this only checks presence and alias parity.
export function validateLiveManifest(manifest, { platform, arch, filename }) {
  validateManifest(manifest);
  const key = `${platform}-${arch}`;
  const entry = manifest.platforms[key];
  if (!entry)
    throw new Error(
      `${filename} is missing the expected updater entry: ${key}`,
    );
  if (isBetaManifestName(filename)) {
    const aliasKey = `${platform}-beta`;
    const alias = manifest.platforms[aliasKey];
    if (
      !alias ||
      alias.url !== entry.url ||
      alias.signature !== entry.signature
    )
      throw new Error(
        `${filename} is missing the matching updater entry: ${aliasKey}`,
      );
  }
  return true;
}

export function isDirectRun(argv1) {
  return basename(argv1 ?? "").toLowerCase() === "validate-updater-live.js";
}

async function main() {
  for (const [platform, arch] of [...targets, ...optionalTargets]) {
    for (const filename of updaterManifestNames(platform, arch, pkg.version)) {
      const url = `https://github.com/BurntToasters/postal-snap/releases/latest/download/${filename}`;
      const response = await fetch(url);
      if (!response.ok) {
        if (shouldSkipMissingTarget(platform, arch, response.status)) {
          console.log(
            `Skipping optional updater manifest ${filename} (HTTP ${response.status}).`,
          );
          continue;
        }
        throw new Error(
          `Missing updater manifest ${filename}: ${url} returned HTTP ${response.status}`,
        );
      }
      const manifest = await response.json();
      validateLiveManifest(manifest, { platform, arch, filename });
      if (expectedCurrent && manifest.version !== pkg.version)
        throw new Error(
          `${filename} points to ${manifest.version}; expected ${pkg.version}`,
        );
    }
  }
}

if (isDirectRun(process.argv[1])) {
  await main();
  console.log("Live updater manifests validated.");
}
