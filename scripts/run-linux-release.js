import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";
import { run } from "./_utils.js";

export function selectLinuxReleaseScript({
  platform = process.platform,
  arch = process.arch,
  resume = false,
} = {}) {
  if (platform !== "linux") {
    throw new Error("Linux releases must run on a Linux signing host.");
  }
  const releaseArch =
    arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!releaseArch) {
    throw new Error(`Unsupported Linux release architecture: ${arch}`);
  }
  return `release:linux:${releaseArch}${resume ? ":resume" : ""}`;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const script = selectLinuxReleaseScript({
    resume: process.argv.includes("--resume"),
  });
  await run("npm", ["run", script]);
}
