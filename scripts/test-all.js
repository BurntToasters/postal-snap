import { basename } from "node:path";
import process from "node:process";
import { run } from "./_utils.js";

export function qualityGateSteps(env = process.env) {
  return [
    ["run", "format:check"],
    ["run", "format:rust:check"],
    ["run", "lint"],
    ["run", "lint:rust"],
    ["run", "check:native-process-policy"],
    ["run", "check:cargo-update-policy"],
    ["run", "test:cargo-safe-update"],
    ["run", "typecheck"],
    ["run", "typecheck:test"],
    ["test"],
    ...(env.SKIP_E2E ? [] : [["run", "test:e2e"]]),
    ["run", "test:rust"],
    ["run", "test:release-assets"],
    ["run", "build"],
  ];
}

export function isDirectExecution(argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return basename(entry).toLowerCase() === "test-all.js";
}

if (isDirectExecution()) {
  for (const args of qualityGateSteps()) {
    await run("npm", args);
  }
}
