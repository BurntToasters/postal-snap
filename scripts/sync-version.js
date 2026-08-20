import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { json, root, writeJson } from "./_utils.js";

const pkg = await json(join(root, "package.json"));
const tauriPath = join(root, "src-tauri/tauri.conf.json");
const tauri = await json(tauriPath);
tauri.version = pkg.version;
await writeJson(tauriPath, tauri);

const cargoPath = join(root, "src-tauri/Cargo.toml");
const cargo = await readFile(cargoPath, "utf8");
await writeFile(
  cargoPath,
  cargo.replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${pkg.version}$2`),
);
console.log(`Versions synchronized to ${pkg.version}`);
