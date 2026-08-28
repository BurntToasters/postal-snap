import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

export const root = resolve(import.meta.dirname, "..");
export const releaseDir = join(root, "release");
export const RM_RETRY_OPTIONS = { maxRetries: 8, retryDelay: 100 };

export async function rmRetry(path, options = {}) {
  await rm(path, { force: true, ...RM_RETRY_OPTIONS, ...options });
}

function denyGitHubCliPassthrough(command) {
  if (command === "gh") {
    throw new Error(
      "GitHub CLI must be spawned through scripts/github-cli.js so leftover GH_TOKEN and GITHUB_TOKEN cannot authenticate gh.",
    );
  }
}

export function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

export function windowsCmdLine(command, args = []) {
  return [command, ...args].map(quoteWindowsCmdArg).join(" ");
}

export function resolveSpawnInvocation(
  command,
  args = [],
  options = {},
  platform = process.platform,
) {
  denyGitHubCliPassthrough(command);
  const actualCmd =
    platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const useShell =
    options.shell ??
    (platform === "win32" && (command === "npm" || /\.cmd$/i.test(actualCmd)));
  const spawnOptions = {
    cwd: root,
    ...options,
    shell: useShell,
  };
  // Node DEP0190: never pass an args array with shell:true.
  if (useShell) {
    return {
      command: windowsCmdLine(actualCmd, args),
      args: undefined,
      options: spawnOptions,
    };
  }
  return { command: actualCmd, args, options: spawnOptions };
}

function spawnChild(command, args, options) {
  const invocation = resolveSpawnInvocation(command, args, options);
  return invocation.args === undefined
    ? spawn(invocation.command, invocation.options)
    : spawn(invocation.command, invocation.args, invocation.options);
}

export async function run(command, args = [], options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawnChild(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

export async function runWithInput(command, args, input, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawnChild(command, args, {
      stdio: ["pipe", "inherit", "inherit"],
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} exited with code ${code}`)),
    );
    child.stdin.end(input);
  });
}

export async function output(command, args = [], options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnChild(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise(stdout.trim())
        : reject(
            new Error(stderr.trim() || `${command} exited with code ${code}`),
          ),
    );
  });
}

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
export function artifactArch(name) {
  if (/arm64|aarch64/i.test(name)) return "aarch64";
  if (/x64|x86_64/i.test(name)) return "x86_64";
  if (/macOS/i.test(name)) return "universal";
  return undefined;
}
export { basename, existsSync, join, process, readFile, writeFile };
