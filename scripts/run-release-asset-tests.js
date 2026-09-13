import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { process, root } from "./lib/paths.js";

// cmd.exe does not expand the shell globs the release tests used to rely on,
// so collect the same file set in Node and pass explicit paths to --test.
export function collectReleaseAssetTestFiles(baseDir) {
  const files = [];
  for (const name of readdirSync(baseDir)) {
    if (/\.test\.(?:js|mjs)$/.test(name)) files.push(join(baseDir, name));
    if (name === "lib") {
      const libDir = join(baseDir, name);
      for (const libName of readdirSync(libDir)) {
        if (/\.test\.(?:js|mjs)$/.test(libName)) {
          files.push(join(libDir, libName));
        }
      }
    }
  }
  return files.sort();
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  const files = collectReleaseAssetTestFiles(join(root, "scripts"));
  if (!files.length) {
    throw new Error("No release asset test files found under scripts/.");
  }
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}
