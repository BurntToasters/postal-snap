import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry, root, run } from "./_utils.js";

const iconsDir = join(root, "src-tauri/icons");
const desktopSource = join(iconsDir, "app-icon.png");
const macosSource = join(iconsDir, "app-icon-macos.png");

await run("npm", ["run", "tauri", "--", "icon", desktopSource]);

const staging = await mkdtemp(join(tmpdir(), "postal-snap-macos-icon-"));
try {
  await run("npm", [
    "run",
    "tauri",
    "--",
    "icon",
    macosSource,
    "--output",
    staging,
  ]);
  await cp(join(staging, "icon.icns"), join(iconsDir, "icon.icns"));
} finally {
  await rmRetry(staging, { recursive: true });
}
