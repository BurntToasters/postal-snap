import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

export {
  basename,
  existsSync,
  join,
  mkdir,
  process,
  readFile,
  resolve,
  rm,
  stat,
  writeFile,
};

export async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
export async function filesRecursively(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesRecursively(path)));
    else result.push(path);
  }
  return result;
}
export async function newestMatching(directory, predicate) {
  const matches = (await filesRecursively(directory)).filter(predicate);
  const entries = await Promise.all(
    matches.map(async (path) => ({ path, time: (await stat(path)).mtimeMs })),
  );
  return entries.sort((a, b) => b.time - a.time)[0]?.path;
}
export async function executableExists(command) {
  try {
    await access(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export function artifactPlatform(name) {
  if (/Windows/i.test(name)) return "windows";
  if (/macOS/i.test(name)) return "darwin";
  if (/Linux/i.test(name)) return "linux";
  return undefined;
}

// IYERIS/Zinnia gpg-sign treat the AppImage itself as the Linux updater
// payload. `.AppImage.tar.gz` is v1Compatible only and must not match.
export function isLinuxAppImage(name) {
  return /\.AppImage$/i.test(name);
}

export function isLinuxAppImageSignature(name) {
  return /\.AppImage\.sig$/i.test(name);
}
export function artifactArch(name) {
  if (/arm64|aarch64/i.test(name)) return "aarch64";
  if (/x64|x86_64/i.test(name)) return "x86_64";
  if (/macOS/i.test(name)) return "universal";
  return undefined;
}
