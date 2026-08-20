import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { json, output, root, run } from "./_utils.js";

const pkg = await json(join(root, "package.json"));
const tag = `v${pkg.version}`;
const channel = pkg.version.includes("-") ? "-beta" : "";
const assets = JSON.parse(
  await output("gh", [
    "release",
    "view",
    tag,
    "--repo",
    "BurntToasters/postal-snap",
    "--json",
    "assets",
    "--jq",
    ".assets | map(.name)",
  ]),
);
const required = [
  "Postal-Snap-Windows-x64.exe",
  "Postal-Snap-Windows-arm64.exe",
  "Postal-Snap-macOS.dmg",
  "Postal-Snap-macOS.zip",
  "Postal-Snap-Linux-x64.AppImage",
  "Postal-Snap-Linux-arm64.AppImage",
  "Postal-Snap-Linux-x64.flatpak",
  "Postal-Snap-Linux-arm64.flatpak",
];
for (const artifact of [...required]) {
  required.push(`${artifact}.sha256`, `${artifact}.asc`);
}
for (const payload of [
  "Postal-Snap-Windows-x64.nsis.zip",
  "Postal-Snap-Windows-arm64.nsis.zip",
  "Postal-Snap-macOS.app.tar.gz",
  "Postal-Snap-Linux-x64.AppImage.tar.gz",
  "Postal-Snap-Linux-arm64.AppImage.tar.gz",
]) {
  required.push(
    payload,
    `${payload}.sig`,
    `${payload}.sha256`,
    `${payload}.asc`,
  );
}
for (const [platform, arch] of [
  ["windows", "x86_64"],
  ["windows", "aarch64"],
  ["darwin", "x86_64"],
  ["darwin", "aarch64"],
  ["linux", "x86_64"],
  ["linux", "aarch64"],
]) {
  required.push(`latest-${platform}${channel}-${arch}.json`);
}
const missing = required.filter((name) => !assets.includes(name));
if (missing.length)
  throw new Error(`Draft release is missing: ${missing.join(", ")}`);
const temporary = await mkdtemp(join(tmpdir(), "postal-snap-release-verify-"));
try {
  await run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    "BurntToasters/postal-snap",
    "--dir",
    temporary,
  ]);
  await run("node", ["scripts/verify-release-directory.js", temporary]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(`Draft ${tag} passed complete remote artifact verification.`);
