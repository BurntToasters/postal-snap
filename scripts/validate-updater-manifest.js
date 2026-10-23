import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { process, releaseDir } from "./lib/paths.js";
import { isSemVer } from "./lib/versions.js";

const SUPPORTED_PLATFORM_PATTERN =
  /^(windows|darwin|linux)-(x86_64|aarch64|beta)$/;
const GITHUB_RELEASE_FILE_PATTERN =
  /^https:\/\/github\.com\/BurntToasters\/postal-snap\/releases\/download\/[^/?#]+\/[^/?#]+$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateManifest(manifest) {
  if (!isPlainObject(manifest))
    throw new Error("Updater manifest must be an object.");
  if (!isSemVer(manifest.version))
    throw new Error("Manifest version is not valid SemVer.");
  if (!isPlainObject(manifest.platforms))
    throw new Error("Manifest platforms object is required.");
  const keys = Object.keys(manifest.platforms);
  if (!keys.length)
    throw new Error("Manifest platforms must list at least one target.");
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!SUPPORTED_PLATFORM_PATTERN.test(platform))
      throw new Error(`Unsupported updater platform: ${platform}`);
    if (!isPlainObject(entry))
      throw new Error(`${platform} entry must be an object.`);
    if (
      typeof entry.url !== "string" ||
      !GITHUB_RELEASE_FILE_PATTERN.test(entry.url)
    )
      throw new Error(
        `${platform} must use a complete Postal Snap GitHub release URL.`,
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
