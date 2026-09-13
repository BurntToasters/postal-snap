import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { process } from "./lib/paths.js";
import { output } from "./lib/spawn.js";
import { compareVersions } from "./lib/versions.js";

// Release AppImages must be built on the oldest supported base system so the
// glibc floor stays low, and they bundle the build host's WebKitGTK. Both
// baselines are release gates; see docs/RELEASING.md.
export const LINUX_GLIBC_BASELINE = "2.39";
export const LINUX_WEBKIT2GTK_FLOOR = "2.52.6";

export function assertLinuxBuildBaseline({
  platform = process.platform,
  glibcVersion,
  webkitVersion,
  allowNewerGlibc = false,
} = {}) {
  if (platform !== "linux") return { skipped: true };
  const problems = [];
  if (
    glibcVersion &&
    compareVersions(glibcVersion, LINUX_GLIBC_BASELINE) > 0 &&
    !allowNewerGlibc
  ) {
    problems.push(
      `host glibc ${glibcVersion} is newer than the ${LINUX_GLIBC_BASELINE} baseline (Ubuntu 24.04.4). Build inside the pinned container image, or set POSTAL_SNAP_ALLOW_NEWER_GLIBC=1 for a deliberate newer-host build.`,
    );
  }
  if (
    webkitVersion &&
    compareVersions(webkitVersion, LINUX_WEBKIT2GTK_FLOOR) < 0
  ) {
    problems.push(
      `webkit2gtk-4.1 ${webkitVersion} is below the ${LINUX_WEBKIT2GTK_FLOOR} security floor (WSA-2026-0005). Upgrade WebKitGTK before bundling the AppImage.`,
    );
  }
  if (problems.length) {
    throw new Error(
      `Linux release preflight failed:\n- ${problems.join("\n- ")}`,
    );
  }
  return {
    skipped: false,
    glibcVersion: glibcVersion ?? null,
    webkitVersion: webkitVersion ?? null,
  };
}

export async function main() {
  if (process.platform !== "linux") {
    console.log(
      "[linux-preflight] Not a Linux host; skipping release preflight.",
    );
    return;
  }
  const glibcVersion =
    process.report?.getReport?.().header?.glibcVersionRuntime ?? null;
  if (!glibcVersion) {
    console.warn(
      "[linux-preflight] Could not read the host glibc version; verify the pinned container baseline manually.",
    );
  }
  let webkitVersion;
  try {
    webkitVersion = (
      await output("pkg-config", ["--modversion", "webkit2gtk-4.1"])
    ).trim();
  } catch {
    throw new Error(
      "pkg-config webkit2gtk-4.1 is required. Install libwebkit2gtk-4.1-dev inside the pinned build container before bundling.",
    );
  }
  assertLinuxBuildBaseline({
    platform: process.platform,
    glibcVersion,
    webkitVersion,
    allowNewerGlibc: process.env.POSTAL_SNAP_ALLOW_NEWER_GLIBC === "1",
  });
  console.log(
    `[linux-preflight] glibc ${glibcVersion ?? "unknown"} and webkit2gtk-4.1 ${webkitVersion} satisfy the release baseline.`,
  );
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  await main();
}
