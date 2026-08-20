import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { filesRecursively, root } from "./_utils.js";

const roots = [`${root}/src`, `${root}/src-tauri/src`];
const forbidden = [
  /@tauri-apps\/plugin-shell/,
  /std::process::Command/,
  /tokio::process/,
  /Command::new\s*\(/,
];
const violations = [];
for (const directory of roots) {
  for (const path of await filesRecursively(directory)) {
    if (!new Set([".ts", ".tsx", ".rs"]).has(extname(path))) continue;
    const source = await readFile(path, "utf8");
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
