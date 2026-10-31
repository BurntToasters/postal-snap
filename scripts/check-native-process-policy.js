import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { filesRecursively } from "./lib/artifacts.js";
import { root } from "./lib/paths.js";

const roots = [join(root, "src"), join(root, "src-tauri/src")];
const forbidden = [
  /@tauri-apps\/plugin-shell/,
  /std::process::Command/,
  /tokio::process/,
  /Command::new\s*\(/,
];
// Reviewed exceptions: each snippet must occur exactly once in its file.
// update_relaunch.rs: macOS relaunch helper with fixed binaries and argv-only
// paths; Tauri's restart uses `open -n`, which adds a second Dock tile.
const exceptions = new Map([
  [join(root, "src-tauri/src/update_relaunch.rs"), 'Command::new("/bin/sh")'],
]);
const violations = [];
for (const directory of roots) {
  for (const path of await filesRecursively(directory)) {
    if (!new Set([".ts", ".tsx", ".rs"]).has(extname(path))) continue;
    let source = await readFile(path, "utf8");
    const allowed = exceptions.get(path);
    if (allowed) {
      if (source.split(allowed).length !== 2) {
        violations.push(`${path}: reviewed exception must occur exactly once`);
        continue;
      }
      source = source.replace(allowed, "");
    }
    for (const pattern of forbidden) {
      if (pattern.test(source)) violations.push(`${path}: ${pattern}`);
    }
  }
}
if (violations.length) {
  throw new Error(
    `Production code may not spawn arbitrary processes:\n${violations.join("\n")}`,
  );
}
console.log("Native process policy passed.");
