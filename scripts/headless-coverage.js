import { mkdir, readdir } from "node:fs/promises";
import coverage from "istanbul-lib-coverage";
import report from "istanbul-lib-report";
import reports from "istanbul-reports";
import sourceMaps from "istanbul-lib-source-maps";

import { json } from "./lib/json.js";
import { join, readFile, root, writeFile } from "./lib/paths.js";
import { rmRetry, run } from "./lib/spawn.js";

const coverageDirectory = join(root, "coverage");
const unitDirectory = join(coverageDirectory, "unit");
const e2eDirectory = join(coverageDirectory, "e2e");
const combinedDirectory = join(coverageDirectory, "combined");
const mergeOnly = process.argv.includes("--merge-only");

if (!mergeOnly) {
  await rmRetry(coverageDirectory, { recursive: true });
  await run("npm", ["run", "test:cov:unit"]);
  await run("npm", ["run", "test:cov:e2e"]);
}

const coverageMap = coverage.createCoverageMap(
  await json(join(unitDirectory, "coverage-final.json")),
);
const e2eCoverageMap = coverage.createCoverageMap({});
const e2eFiles = (await readdir(e2eDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort();
if (!e2eFiles.length) throw new Error("Playwright produced no coverage files.");

for (const file of e2eFiles) {
  e2eCoverageMap.merge(
    JSON.parse(await readFile(join(e2eDirectory, file), "utf8")),
  );
}
const remappedE2eCoverage = await sourceMaps
  .createSourceMapStore()
  .transformCoverage(e2eCoverageMap);
coverageMap.merge(remappedE2eCoverage);

await mkdir(combinedDirectory, { recursive: true });
const context = report.createContext({
  dir: combinedDirectory,
  coverageMap,
});
for (const name of ["text", "html", "json", "lcovonly"]) {
  reports.create(name).execute(context);
}

const summary = coverageMap.getCoverageSummary().toJSON();
await writeFile(
  join(combinedDirectory, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  `Headless coverage: ${summary.lines.pct}% lines, ${summary.statements.pct}% statements, ${summary.branches.pct}% branches, ${summary.functions.pct}% functions.`,
);

const minimums = {
  lines: 94,
  statements: 74,
  branches: 68,
  functions: 79,
};
const failures = Object.entries(minimums)
  .filter(([metric, minimum]) => summary[metric].pct < minimum)
  .map(
    ([metric, minimum]) =>
      `${metric} ${summary[metric].pct}% is below ${minimum}%`,
  );
if (failures.length) {
  throw new Error(`Headless coverage gate failed: ${failures.join(", ")}.`);
}
