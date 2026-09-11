import { join } from "node:path";
import { json } from "./lib/json.js";
import { process, root } from "./lib/paths.js";
import { validateManifest } from "./validate-updater-manifest.js";

const shapeOnly = process.argv.includes("--shape-only");
const expectedCurrent = process.argv.includes("--expected-version=current");
const pkg = await json(join(root, "package.json"));
const targets = [
  "windows-x86_64",
  "windows-aarch64",
  "darwin-x86_64",
  "darwin-aarch64",
  "linux-x86_64",
];
const optionalTargets = ["linux-aarch64"];
export function updaterManifestName(target, version) {
  const channel = String(version).includes("-") ? "-beta" : "";
  return `latest-${target}${channel}.json`;
}

async function main() {
  for (const target of [...targets, ...optionalTargets]) {
    const filename = updaterManifestName(target, pkg.version);
    const url = `https://github.com/BurntToasters/postal-snap/releases/latest/download/${filename}`;
    const response = await fetch(url);
    if (!response.ok) {
      if (
        response.status === 404 &&
        (shapeOnly || optionalTargets.includes(target))
      )
        continue;
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    const manifest = await response.json();
    validateManifest(manifest);
    if (expectedCurrent && manifest.version !== pkg.version)
      throw new Error(
        `${target} points to ${manifest.version}; expected ${pkg.version}`,
      );
  }
}

if (process.argv[1]?.endsWith("validate-updater-live.js")) {
  await main();
  console.log("Live updater manifests validated.");
}
