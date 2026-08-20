import { chmod, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import process from "node:process";

if (!existsSync(".git")) process.exit(0);
await mkdir(".git/hooks", { recursive: true });
if (existsSync("scripts/hooks/pre-commit")) {
  await copyFile("scripts/hooks/pre-commit", ".git/hooks/pre-commit");
  await chmod(".git/hooks/pre-commit", 0o755);
}
