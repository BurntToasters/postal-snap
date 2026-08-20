import { join } from "node:path";
import { json, process, root } from "./_utils.js";
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
  "linux-aarch64",
];
for (const target of targets) {
  const url = `https://github.com/BurntToasters/postal-snap/releases/latest/download/latest-${target}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    if (shapeOnly && response.status === 404) continue;
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const manifest = await response.json();
  validateManifest(manifest);
  if (expectedCurrent && manifest.version !== pkg.version)
    throw new Error(
      `${target} points to ${manifest.version}; expected ${pkg.version}`,
    );
}
console.log("Live updater manifests validated.");
