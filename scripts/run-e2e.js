import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import process from "node:process";
import { createServer } from "vite";

import { root } from "./lib/paths.js";

const playwrightCli = join(
  root,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

export async function runE2e({
  args = process.argv.slice(2),
  env = process.env,
  createViteServer = createServer,
  spawnChild = spawn,
} = {}) {
  // Host Vite in this process so Windows cannot orphan a grandchild that
  // keeps test:all's captured output pipe open after Playwright exits.
  const server = await createViteServer({
    root,
    server: { host: "127.0.0.1", port: 4173, strictPort: true },
  });
  await server.listen();
  try {
    const child = spawnChild(
      process.execPath,
      [playwrightCli, "test", ...args],
      {
        cwd: root,
        env: { ...env, POSTAL_SNAP_E2E_EXTERNAL_SERVER: "1" },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    return await childExit(child);
  } finally {
    await server.close();
  }
}

export function isDirectRun(argv1) {
  return basename(argv1 ?? "").toLowerCase() === "run-e2e.js";
}

if (isDirectRun(process.argv[1])) {
  try {
    process.exitCode = await runE2e();
  } catch (error) {
    console.error(
      `E2E runner failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
