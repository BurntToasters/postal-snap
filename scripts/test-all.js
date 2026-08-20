import { run } from "./_utils.js";
import process from "node:process";

const steps = [
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
  ...(process.env.SKIP_E2E ? [] : [["run", "test:e2e"]]),
  ["run", "test:rust"],
  ["run", "test:release-assets"],
  ["run", "build"],
];

for (const args of steps) {
  await run("npm", args);
}
