import { rm } from "node:fs/promises";
import { join } from "node:path";
import { process, root } from "./_utils.js";

const action = process.argv[2];
const targets = {
  clean: ["dist"],
  "clean-release": ["release/.session.json"],
  "clean-release-artifacts": ["release"],
  "clean-all": ["dist", "release", "msstore", "flatpak-build", "flatpak-repo"],
  "clean-flatpak": ["flatpak-build", "flatpak-repo"],
}[action];
if (!targets) throw new Error(`Unknown cleanup action: ${action}`);
for (const relative of targets)
  await rm(join(root, relative), { recursive: true, force: true });
console.log(`Completed ${action}.`);
