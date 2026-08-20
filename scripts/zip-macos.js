import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureReleaseDir, newestMatching, root, run } from "./_utils.js";

const app = await newestMatching(
  join(root, "src-tauri/target/universal-apple-darwin/release/bundle/macos"),
  (path) => path.endsWith("Postal Snap.app/Contents/Info.plist"),
);
if (!app)
  throw new Error(
    "Universal Postal Snap.app not found. Run build:mac:universal first.",
  );
const appPath = app.slice(0, -"/Contents/Info.plist".length);
const release = await ensureReleaseDir();
const destination = join(release, "Postal-Snap-macOS.zip");
await run("ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  appPath,
  destination,
]);
const dmg = await newestMatching(
  join(root, "src-tauri/target/universal-apple-darwin/release/bundle"),
  (path) => path.endsWith(".dmg"),
);
if (dmg) await copyFile(dmg, join(release, "Postal-Snap-macOS.dmg"));
