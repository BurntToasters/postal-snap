import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ensureReleaseDir,
  json,
  process,
  root,
  run,
  sha256,
} from "./_utils.js";
import { validateManifest } from "./validate-updater-manifest.js";

const directory = process.argv[2]
  ? resolve(root, process.argv[2])
  : await ensureReleaseDir();
const files = new Set(await readdir(directory));
const artifacts = [
  "Postal-Snap-Windows-x64.exe",
  "Postal-Snap-Windows-arm64.exe",
  "Postal-Snap-macOS.dmg",
  "Postal-Snap-macOS.zip",
  "Postal-Snap-Linux-x64.AppImage",
  "Postal-Snap-Linux-arm64.AppImage",
  "Postal-Snap-Linux-x64.flatpak",
  "Postal-Snap-Linux-arm64.flatpak",
];
const updaterPayloads = [
  "Postal-Snap-Windows-x64.nsis.zip",
  "Postal-Snap-Windows-arm64.nsis.zip",
  "Postal-Snap-macOS.app.tar.gz",
  "Postal-Snap-Linux-x64.AppImage.tar.gz",
  "Postal-Snap-Linux-arm64.AppImage.tar.gz",
];
const pkg = await json(join(root, "package.json"));
const tag = `v${pkg.version}`;
const channel = pkg.version.includes("-") ? "-beta" : "";
const manifests = [
  ["windows", "x86_64", "Postal-Snap-Windows-x64.nsis.zip"],
  ["windows", "aarch64", "Postal-Snap-Windows-arm64.nsis.zip"],
  ["darwin", "x86_64", "Postal-Snap-macOS.app.tar.gz"],
  ["darwin", "aarch64", "Postal-Snap-macOS.app.tar.gz"],
  ["linux", "x86_64", "Postal-Snap-Linux-x64.AppImage.tar.gz"],
  ["linux", "aarch64", "Postal-Snap-Linux-arm64.AppImage.tar.gz"],
].map(([platform, arch, payload]) => ({
  platform,
  arch,
  payload,
  name: `latest-${platform}${channel}-${arch}.json`,
}));
const required = [];
for (const name of [...artifacts, ...updaterPayloads]) {
  required.push(name, `${name}.sha256`, `${name}.asc`);
}
for (const name of updaterPayloads) required.push(`${name}.sig`);
for (const { name } of manifests) required.push(name);
const missing = required.filter((name) => !files.has(name));
if (missing.length)
  throw new Error(`Release directory is incomplete: ${missing.join(", ")}`);

for (const name of [...artifacts, ...updaterPayloads]) {
  const path = join(directory, name);
  const checksum = (await readFile(`${path}.sha256`, "utf8")).trim();
  const match = checksum.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
  if (!match || match[2] !== name)
    throw new Error(`Invalid SHA-256 file for ${name}`);
  if (match[1].toLowerCase() !== (await sha256(path)))
    throw new Error(`SHA-256 mismatch for ${name}`);
  await run("gpg", ["--batch", "--verify", `${path}.asc`, path]);
}

for (const name of updaterPayloads) {
  const signature = (
    await readFile(join(directory, `${name}.sig`), "utf8")
  ).trim();
  if (signature.length < 64)
    throw new Error(`Invalid embedded Tauri signature for ${name}`);
}

for (const { platform, arch, payload, name } of manifests) {
  const manifest = JSON.parse(await readFile(join(directory, name), "utf8"));
  validateManifest(manifest);
  const key = `${platform}-${arch}`;
  const platformEntry = manifest.platforms[key];
  const expectedUrl = `https://github.com/BurntToasters/postal-snap/releases/download/${tag}/${encodeURIComponent(payload)}`;
  const expectedSignature = (
    await readFile(join(directory, `${payload}.sig`), "utf8")
  ).trim();
  if (
    manifest.version !== pkg.version ||
    Object.keys(manifest.platforms).length !== 1 ||
    !platformEntry ||
    platformEntry.url !== expectedUrl ||
    platformEntry.signature !== expectedSignature
  ) {
    throw new Error(`Updater manifest does not match ${payload}: ${name}`);
  }
}

console.log(
  `Verified ${artifacts.length + updaterPayloads.length} release artifacts, checksums, GPG signatures, updater signatures, and ${manifests.length} manifests.`,
);
