import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureReleaseDir, process, root, run } from "./_utils.js";

const arch = process.argv.includes("--arm64")
  ? "aarch64"
  : process.arch === "arm64"
    ? "aarch64"
    : "x86_64";
const rustTarget =
  arch === "aarch64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
const generatedManifest = join(
  root,
  "packaging/flatpak/run.rosie.snap.generated.yml",
);
await run("node", [
  "scripts/tauri-build.js",
  "--target",
  rustTarget,
  "--no-bundle",
  "--features",
  "flatpak",
  "--config",
  "src-tauri/tauri.flatpak.conf.json",
  "--",
  "--no-default-features",
]);
const manifest = (
  await readFile(join(root, "packaging/flatpak/run.rosie.snap.yml"), "utf8")
).replace(
  "../../src-tauri/target/release/postal-snap",
  `../../src-tauri/target/${rustTarget}/release/postal-snap`,
);
const branch = manifest.match(/^branch:\s*["']?([^\s#"']+)/m)?.[1];
if (!branch) {
  throw new Error(
    "Flatpak manifest must set branch so build-bundle matches the exported ref.",
  );
}
await writeFile(generatedManifest, manifest);
await mkdir(join(root, "flatpak-build"), { recursive: true });
try {
  await run("flatpak-builder", [
    `--arch=${arch}`,
    "--force-clean",
    "--repo=flatpak-repo",
    "flatpak-build",
    generatedManifest,
  ]);
  const release = await ensureReleaseDir();
  await run("flatpak", [
    "build-bundle",
    `--arch=${arch}`,
    "flatpak-repo",
    join(
      release,
      `Postal-Snap-Linux-${arch === "aarch64" ? "arm64" : "x64"}.flatpak`,
    ),
    "run.rosie.snap",
    branch,
  ]);
} finally {
  await rm(generatedManifest, { force: true });
}
