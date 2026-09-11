import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { releaseDir } from "./paths.js";

export async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
export function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length)
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
}
export async function ensureReleaseDir() {
  await mkdir(releaseDir, { recursive: true });
  return releaseDir;
}
