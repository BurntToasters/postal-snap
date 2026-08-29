import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createInitialResults,
  createStepPlan,
  isQualityGateClean,
  main,
  parseTest,
  printBanner,
  printSummary,
  qualityGateSteps,
  runCommand,
} from "./test-all.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readScripts() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    .scripts;
}

function passingResults(plan, failing = []) {
  const results = createInitialResults(plan);
  for (const step of plan) {
    results[step.name].status = failing.includes(step.name)
      ? "failed"
      : "passed";
  }
  return results;
}

function runGate({ failing = [] } = {}) {
  const calls = [];
  const plan = createStepPlan({ npm: "npm" });
  const logs = [];
  const exitCode = main({
    plan,
    runStep: (step, results) => {
      calls.push(`run:${step.name}`);
      results[step.name].status = failing.includes(step.name)
        ? "failed"
        : "passed";
    },
    log: (line) => logs.push(String(line)),
  });
  return { calls, exitCode, logs, plan };
}

test("the quality-gate plan stays in lockstep with qualityGateSteps", () => {
  for (const env of [{}, { SKIP_E2E: "1" }]) {
    const plan = createStepPlan({ npm: "npm", env });
    const names = plan.map((step) => scriptName(step.args));
    assert.deepEqual(
      names,
      qualityGateSteps(env).map((args) =>
        args[0] === "run" ? args[1] : args[0],
      ),
    );
  }
  assert.equal(readScripts()["test:all"], "node scripts/test-all.js");
});

function scriptName(args) {
  return args[0] === "run" ? args[1] : args[0];
}

test("SKIP_E2E drops Playwright from the plan", () => {
  const withE2e = createStepPlan({ npm: "npm", env: {} });
  const withoutE2e = createStepPlan({ npm: "npm", env: { SKIP_E2E: "1" } });
  assert.ok(withE2e.some((step) => step.name === "e2e"));
  assert.ok(!withoutE2e.some((step) => step.name === "e2e"));
});

test("every planned step is represented in the results map", () => {
  const plan = createStepPlan({ npm: "npm" });
  assert.deepEqual(
    Object.keys(createInitialResults(plan)),
    plan.map((step) => step.name),
  );
  assert.deepEqual(createInitialResults(plan).test, {
    status: "pending",
    passed: null,
    failed: null,
    files: null,
  });
});

test("isQualityGateClean requires every step to have passed", () => {
  const plan = createStepPlan({ npm: "npm" });
  assert.equal(isQualityGateClean(passingResults(plan)), true);
  assert.equal(
    isQualityGateClean(passingResults(plan, ["releaseAssets"])),
    false,
  );
  assert.equal(isQualityGateClean(createInitialResults(plan)), false);
  assert.equal(isQualityGateClean({}), false);
});

test("main prints the IYERIS-style banner and summary", () => {
  const { exitCode, logs, calls } = runGate();
  const text = logs.join("\n");
  assert.equal(exitCode, 0);
  assert.ok(text.includes("POSTAL SNAP TEST SUITE"));
  assert.ok(text.includes("SUMMARY"));
  assert.ok(text.includes("All checks passed."));
  assert.ok(calls.includes("run:releaseAssets"));
  assert.ok(calls.includes("run:rustClippy"));
});

test("main fails the summary when a step fails", () => {
  const { exitCode, logs, calls } = runGate({ failing: ["releaseAssets"] });
  assert.equal(exitCode, 1);
  assert.ok(calls.includes("run:releaseAssets"));
  assert.ok(logs.join("\n").includes("Some checks failed"));
});

test("printSummary reports the release-asset step and fails the run", () => {
  const plan = createStepPlan({ npm: "npm" });
  const logs = [];
  const code = printSummary(
    passingResults(plan, ["releaseAssets"]),
    plan,
    (line) => logs.push(String(line)),
  );
  assert.equal(code, 1);
  assert.ok(logs.join("\n").includes("Release Assets:"));
  assert.equal(
    printSummary(passingResults(plan), plan, () => {}),
    0,
  );
});

test("printBanner names Postal Snap", () => {
  const logs = [];
  printBanner((line) => logs.push(String(line)));
  assert.ok(logs.join("\n").includes("POSTAL SNAP TEST SUITE"));
});

test("runCommand records failure and surfaces command output", () => {
  const plan = createStepPlan({ npm: "npm" });
  const results = createInitialResults(plan);
  const logs = [];
  const ok = runCommand(
    plan.find((step) => step.name === "releaseAssets"),
    results,
    {
      spawn: () => ({
        status: 1,
        stdout: "",
        stderr: "release assets exploded",
      }),
      log: (line) => logs.push(String(line)),
    },
  );
  assert.equal(ok, false);
  assert.equal(results.releaseAssets.status, "failed");
  assert.ok(logs.join("\n").includes("release assets exploded"));
});

test("runCommand passes each step its own timeout", () => {
  const plan = createStepPlan({ npm: "npm", rustTimeout: 4242 });
  const results = createInitialResults(plan);
  const seen = [];
  const spawn = (...spawnArgs) => {
    const options = spawnArgs.at(-1);
    seen.push({ timeout: options.timeout });
    return { status: 0, stdout: "", stderr: "" };
  };
  for (const name of ["releaseAssets", "rustClippy"]) {
    runCommand(
      plan.find((step) => step.name === name),
      results,
      {
        spawn,
        log: () => {},
      },
    );
  }
  assert.equal(seen[0].timeout, 300_000);
  assert.equal(seen[1].timeout, 4242);
  assert.equal(results.releaseAssets.status, "passed");
  assert.equal(results.rustClippy.status, "passed");
});

test("parseTest extracts vitest counts from colored output", () => {
  const results = { test: {} };
  parseTest(
    [
      "\x1b[32m Test Files \x1b[39m 5 passed (5)",
      " Tests  25 passed (25)",
    ].join("\n"),
    results,
  );
  assert.equal(results.test.passed, 25);
  assert.equal(results.test.failed, 0);
  assert.equal(results.test.files, 5);
});
