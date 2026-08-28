import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import { resolveSpawnInvocation, root } from "./_utils.js";

const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const appVersion = packageJson.version ?? "unknown";
const scriptVersion = "1.1.0";
const defaultTimeoutMs = 300_000;
const rustTimeoutMs = process.platform === "win32" ? 1_200_000 : 600_000;

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

const STEP_INFO = {
  "format:check": { name: "format", label: "Format" },
  "format:rust:check": { name: "rustFormat", label: "Rust Format", rust: true },
  lint: { name: "lint", label: "Lint" },
  "lint:rust": { name: "rustClippy", label: "Rust Clippy", rust: true },
  "check:native-process-policy": {
    name: "nativePolicy",
    label: "Native Policy",
  },
  "check:cargo-update-policy": {
    name: "cargoUpdatePolicy",
    label: "Cargo Policy",
  },
  "test:cargo-safe-update": {
    name: "cargoSafeUpdate",
    label: "Cargo Safe Update",
  },
  typecheck: { name: "typecheck", label: "TypeCheck" },
  "typecheck:test": { name: "typecheckTest", label: "TypeCheck(Test)" },
  test: { name: "test", label: "Tests", vitest: true },
  "test:e2e": { name: "e2e", label: "E2E" },
  "test:rust": { name: "rustTest", label: "Rust Test", rust: true },
  "test:release-assets": { name: "releaseAssets", label: "Release Assets" },
  build: { name: "build", label: "Build" },
};

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

export function getNpmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function scriptNameFromNpmArgs(args) {
  return args[0] === "run" ? args[1] : args[0];
}

export function createStepPlan({
  npm = getNpmCommand(),
  rustTimeout = rustTimeoutMs,
  env = process.env,
} = {}) {
  return qualityGateSteps(env).map((args) => {
    const script = scriptNameFromNpmArgs(args);
    const info = STEP_INFO[script];
    if (!info) throw new Error(`Unknown quality-gate script: ${script}`);
    return {
      name: info.name,
      label: info.label,
      command: npm,
      args,
      timeout: info.rust ? rustTimeout : defaultTimeoutMs,
      parser: info.vitest ? parseTest : undefined,
      detail: info.vitest ? formatTestDetail : undefined,
    };
  });
}

export function createInitialResults(plan = createStepPlan()) {
  const results = {};
  for (const step of plan) {
    results[step.name] =
      step.name === "test"
        ? { status: "pending", passed: null, failed: null, files: null }
        : { status: "pending" };
  }
  return results;
}

export function isQualityGateClean(results) {
  const values = Object.values(results);
  if (values.length === 0) return false;
  return values.every((result) => result?.status === "passed");
}

export function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex -- ANSI CSI sequences
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function parseTest(output, results) {
  const cleanOutput = stripAnsi(output);
  const passedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+passed/);
  const failedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+failed/);
  const filesMatch = cleanOutput.match(
    /Test Files\s+(\d+)\s+passed(?:\s+\((\d+)\))?/,
  );
  results.test.passed = passedMatch
    ? Number.parseInt(passedMatch[1], 10)
    : null;
  results.test.failed = failedMatch ? Number.parseInt(failedMatch[1], 10) : 0;
  if (filesMatch) results.test.files = Number.parseInt(filesMatch[1], 10);
}

function formatTestDetail(result) {
  const failedSuffix = result.failed > 0 ? `, ${result.failed} failed` : "";
  const filesSuffix = result.files ? `, ${result.files} files` : "";
  return ` (${result.passed ?? "n/a"} passed${failedSuffix}${filesSuffix})`;
}

function printTail(output, log) {
  const cleanOutput = stripAnsi(output).trim();
  if (!cleanOutput) return;
  const tail = cleanOutput.split("\n").slice(-80).join("\n");
  log(`${colors.red}${tail}${colors.reset}`);
}

export function runCommand(
  step,
  results,
  { spawn = spawnSync, log = console.log } = {},
) {
  log(`${colors.blue}${colors.bold}Running ${step.name}...${colors.reset}`);
  const timeout = step.timeout ?? defaultTimeoutMs;
  const invocation = resolveSpawnInvocation(step.command, step.args, {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    timeout,
  });
  const run =
    invocation.args === undefined
      ? spawn(invocation.command, invocation.options)
      : spawn(invocation.command, invocation.args, invocation.options);
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  if (step.parser) step.parser(output, results);
  if (!run.error && run.status === 0) {
    results[step.name].status = "passed";
    log(`${colors.green}✓ ${step.name} passed${colors.reset}\n`);
    return true;
  }
  results[step.name].status = "failed";
  const reason = run.error
    ? run.error.message
    : run.status === null
      ? `signal ${run.signal || "unknown"}`
      : `exit code ${run.status}`;
  log(`${colors.red}✗ ${step.name} failed (${reason})${colors.reset}`);
  printTail(output, log);
  log("");
  return false;
}

export function printBanner(log = console.log) {
  log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║        POSTAL SNAP TEST SUITE        ║
╚══════════════════════════════════════╝
Postal Snap Version: ${appVersion}
Script Version: ${scriptVersion}
${colors.reset}`);
}

export function printSummary(
  results,
  plan = createStepPlan(),
  log = console.log,
) {
  log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║               SUMMARY                ║
╚══════════════════════════════════════╝
${colors.reset}`);
  const width = Math.max(...plan.map((step) => step.label.length)) + 2;
  for (const step of plan) {
    const result = results[step.name] ?? { status: "pending" };
    const mark =
      result.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`;
    const label = `${step.label}:`.padEnd(width, " ");
    const detail = step.detail ? step.detail(result) : "";
    log(`${colors.bold}${label}${colors.reset}${mark}${colors.reset}${detail}`);
  }
  log("");
  if (isQualityGateClean(results)) {
    log(`${colors.green}${colors.bold}✓ All checks passed.${colors.reset}`);
    return 0;
  }
  log(
    `${colors.red}${colors.bold}✗ Some checks failed. Review output above.${colors.reset}`,
  );
  return 1;
}

export function main({
  plan = createStepPlan(),
  runStep = runCommand,
  log = console.log,
} = {}) {
  const results = createInitialResults(plan);
  printBanner(log);
  for (const step of plan) {
    runStep(step, results, { log });
  }
  return printSummary(results, plan, log);
}

export function isDirectExecution(argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return basename(entry).toLowerCase() === "test-all.js";
}

if (isDirectExecution()) {
  process.exit(main());
}
