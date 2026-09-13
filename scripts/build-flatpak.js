import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureReleaseDir } from "./lib/json.js";
import { process, root } from "./lib/paths.js";
import { run, output } from "./lib/spawn.js";

// The binary is compiled on the host, then installed into the GNOME Platform
// runtime selected by packaging/flatpak/run.rosie.snap.yml. Confirm it starts
// inside bwrap on the signing host; an SDK rebuild is the fallback if host
// glibc/WebKit symbols do not match the runtime.

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
const lintExceptions = join(root, "packaging/flatpak/lint-exceptions.json");
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
const branch = "stable";
await writeFile(generatedManifest, manifest);
await runFlatpakBuilderLint(generatedManifest);
await validateAppStreamMetadata();
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

async function runFlatpakBuilderLint(manifestPath) {
  try {
    await run("flatpak", [
      "run",
      "--command=flatpak-builder-lint",
      "org.flatpak.Builder",
      "--exceptions",
      "--user-exceptions",
      lintExceptions,
      "manifest",
      manifestPath,
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "flatpak is required for the Flatpak release gate. Run `npm run setup:flatpak` on a Linux build host.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function validateAppStreamMetadata() {
  const available = await output("appstreamcli", ["--version"]).catch(
    () => null,
  );
  if (!available) {
    console.warn(
      "[build-flatpak] appstreamcli not found; skipping metainfo validation.",
    );
    return;
  }
  await run("appstreamcli", [
    "validate",
    join(root, "packaging/flatpak/run.rosie.snap.metainfo.xml"),
  ]);
}
