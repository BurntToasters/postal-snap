import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

export const root = resolve(import.meta.dirname, "../..");
export const releaseDir = join(root, "release");

export { basename, existsSync, join, process, readFile, writeFile };
