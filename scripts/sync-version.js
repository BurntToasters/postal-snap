import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json, root, writeJson } from "./_utils.js";

export function cargoTomlPackageName(cargo) {
  const match = cargo.match(/^name\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("Cargo.toml is missing a package name.");
  return match[1];
}

export function replaceCargoTomlVersion(cargo, version) {
  const pattern = /^(version\s*=\s*")[^"]+("\s*)$/m;
  if (!pattern.test(cargo)) {
    throw new Error("Cargo.toml is missing a package version.");
  }
  return cargo.replace(pattern, `$1${version}$2`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceCargoLockPackageVersion(lock, packageName, version) {
  const pattern = new RegExp(
    `(^\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(packageName)}"\\r?\\nversion = ")[^"]+(")`,
    "m",
  );
  if (!pattern.test(lock)) {
    throw new Error(
      `Cargo.lock is missing a [[package]] entry for ${packageName}.`,
    );
  }
  return lock.replace(pattern, `$1${version}$2`);
}

export async function syncWorkspaceVersions(workspaceRoot, version) {
  const tauriPath = join(workspaceRoot, "src-tauri/tauri.conf.json");
  const tauri = await json(tauriPath);
  tauri.version = version;
  await writeJson(tauriPath, tauri);

  const cargoPath = join(workspaceRoot, "src-tauri/Cargo.toml");
  const cargo = await readFile(cargoPath, "utf8");
  await writeFile(cargoPath, replaceCargoTomlVersion(cargo, version));

  const cargoLockPath = join(workspaceRoot, "src-tauri/Cargo.lock");
  const cargoLock = await readFile(cargoLockPath, "utf8");
  await writeFile(
    cargoLockPath,
    replaceCargoLockPackageVersion(
      cargoLock,
      cargoTomlPackageName(cargo),
      version,
    ),
  );
}

async function main() {
  const pkg = await json(join(root, "package.json"));
  await syncWorkspaceVersions(root, pkg.version);
  console.log(`Versions synchronized to ${pkg.version}`);
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  await main();
}
