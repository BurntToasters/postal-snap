import { basename, join } from "node:path";
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

export function updaterManifestName(platform, arch, version) {
  const channel = String(version).includes("-") ? "-beta" : "";
  return `latest-${platform}${channel}-${arch}.json`;
}

function isOptionalTarget(platform, arch) {
  return optionalTargets.some(
    ([optionalPlatform, optionalArch]) =>
      optionalPlatform === platform && optionalArch === arch,
  );
}

export function shouldSkipMissingTarget(platform, arch, status) {
  return status === 404 && isOptionalTarget(platform, arch);
}

export function isDirectRun(argv1) {
  return basename(argv1 ?? "").toLowerCase() === "validate-updater-live.js";
}

async function main() {
  for (const [platform, arch] of [...targets, ...optionalTargets]) {
    const filename = updaterManifestName(platform, arch, pkg.version);
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
    validateManifest(manifest);
    if (expectedCurrent && manifest.version !== pkg.version)
      throw new Error(
        `${platform}-${arch} points to ${manifest.version}; expected ${pkg.version}`,
      );
  }
}

if (isDirectRun(process.argv[1])) {
  await main();
  console.log("Live updater manifests validated.");
}
