import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { process, releaseDir } from "./_utils.js";

export function validateManifest(manifest) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? ""))
    throw new Error("Manifest version is not valid SemVer.");
  if (!manifest.platforms || typeof manifest.platforms !== "object")
    throw new Error("Manifest platforms object is required.");
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!/^(windows|darwin|linux)-(x86_64|aarch64)$/.test(platform))
      throw new Error(`Unsupported updater platform: ${platform}`);
    if (
      !entry.url?.startsWith(
        "https://github.com/BurntToasters/postal-snap/releases/download/",
      )
    )
      throw new Error(
        `${platform} must use the Postal Snap GitHub release host.`,
      );
    if (
      typeof entry.signature !== "string" ||
      entry.signature.trim().length < 40
    )
      throw new Error(`${platform} is missing an embedded updater signature.`);
  }
  return true;
}

if (process.argv[1]?.endsWith("validate-updater-manifest.js")) {
  let files = process.argv.slice(2);
  if (!files.length) {
    try {
      files = (await readdir(releaseDir))
        .filter((name) => /^latest-.+\.json$/.test(name))
        .map((name) => join(releaseDir, name));
    } catch {
      /* handled below */
    }
  }
  if (!files.length)
    throw new Error(
      "No updater manifests found. Pass manifest paths or stage them in release/.",
    );
  for (const file of files)
    validateManifest(JSON.parse(await readFile(file, "utf8")));
  console.log(`Validated ${files.length} updater manifest(s).`);
}
