import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

interface FileCoverageSnapshot {
  path: string;
  s: Record<string, number>;
}

const expectedSnapshots = new Map<
  string,
  { path: string; statements: Record<string, number> }
>();
const expectedNoArtifacts = new Set<string>();
const PAGEHIDE_EXPECTED_KEY = "__postal_snap_test_expected_coverage__";

function outputDirectory(): string {
  return resolve(
    process.env.POSTAL_SNAP_E2E_COVERAGE_DIR ??
      resolve(import.meta.dirname, "../coverage/e2e"),
  );
}

function outputPath(testInfo: TestInfo): string {
  const id = createHash("sha256")
    .update(
      `${testInfo.project.name}:${testInfo.workerIndex}:${testInfo.testId}:${testInfo.retry}`,
    )
    .digest("hex")
    .slice(0, 20);
  return resolve(outputDirectory(), `${id}.json`);
}

async function mailShellCoverage(page: Page): Promise<FileCoverageSnapshot> {
  return page.evaluate(() => {
    const browser = window as unknown as {
      __coverage__?: Record<
        string,
        { path: string; s: Record<string, number> }
      >;
    };
    const coverage = browser.__coverage__;
    if (!coverage) throw new Error("Instrumented app coverage is missing");
    const path = Object.keys(coverage).find((key) =>
      key.includes("MailShell.tsx"),
    );
    if (!path) throw new Error("MailShell coverage entry is missing");
    return { path, s: { ...coverage[path].s } };
  });
}

async function captureMailShellOnPagehide(page: Page): Promise<void> {
  await page.evaluate((storageKey) => {
    const browser = window as typeof window & {
      __coverage__?: Record<
        string,
        { path: string; s: Record<string, number> }
      >;
    };
    window.addEventListener("pagehide", () => {
      const coverage = browser.__coverage__;
      const path = Object.keys(coverage ?? {}).find((key) =>
        key.includes("MailShell.tsx"),
      );
      if (!coverage || !path) return;
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ path, s: { ...coverage[path].s } }),
      );
    });
  }, PAGEHIDE_EXPECTED_KEY);
}

async function readPagehideCoverage(
  page: Page,
): Promise<FileCoverageSnapshot | null> {
  return page.evaluate((storageKey) => {
    const serialized = sessionStorage.getItem(storageKey);
    sessionStorage.removeItem(storageKey);
    return serialized ? (JSON.parse(serialized) as FileCoverageSnapshot) : null;
  }, PAGEHIDE_EXPECTED_KEY);
}

function statementTotal(snapshot: FileCoverageSnapshot): number {
  return Object.values(snapshot.s).reduce((total, count) => total + count, 0);
}

function addStatements(
  first: FileCoverageSnapshot,
  final: FileCoverageSnapshot,
): Record<string, number> {
  expect(final.path).toBe(first.path);
  const ids = new Set([...Object.keys(first.s), ...Object.keys(final.s)]);
  return Object.fromEntries(
    [...ids].map((id) => [id, (first.s[id] ?? 0) + (final.s[id] ?? 0)]),
  );
}

test.afterAll(async () => {
  if (expectedSnapshots.size === 0 && expectedNoArtifacts.size === 0) return;
  const actualFiles = new Set(
    await readdir(outputDirectory()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }),
  );

  for (const [filePath, expected] of expectedSnapshots) {
    expect(actualFiles.has(basename(filePath))).toBe(true);
    expect((await stat(filePath)).size).toBeLessThanOrEqual(48 * 1024 * 1024);
    const merged = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      { s: Record<string, number> }
    >;
    expect(merged[expected.path]?.s).toEqual(expected.statements);
  }
  for (const filePath of expectedNoArtifacts) {
    expect(actualFiles.has(basename(filePath))).toBe(false);
  }
});

test("coverage teardown tolerates a page that never hosted the app", async ({
  page,
}, testInfo: TestInfo) => {
  await expect(page).toHaveURL("about:blank");
  if (process.env.E2E_COVERAGE === "true") {
    expectedNoArtifacts.add(outputPath(testInfo));
  }
});

test("coverage teardown rejects an app document without instrumentation", async ({
  page,
}, testInfo: TestInfo) => {
  test.skip(
    process.env.E2E_COVERAGE !== "true",
    "This regression requires the instrumented Vite server",
  );
  await page.goto("/");
  const hasCoverage = await page.evaluate(() =>
    Boolean(
      (
        globalThis as typeof globalThis & {
          __coverage__?: Record<string, unknown>;
        }
      ).__coverage__,
    ),
  );
  expect(hasCoverage).toBe(true);

  test.fail();
  expectedNoArtifacts.add(outputPath(testInfo));
  await page.evaluate(() => {
    delete (
      globalThis as typeof globalThis & {
        __coverage__?: Record<string, unknown>;
      }
    ).__coverage__;
  });
});

test("coverage teardown keeps one test's counters in its own artifact", async ({
  page,
}, testInfo: TestInfo) => {
  test.skip(
    process.env.E2E_COVERAGE !== "true",
    "This regression requires the instrumented Vite server",
  );
  await installMockIpc(page);
  await page.goto("/?localMail=1");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.click();
  await expect(page.getByRole("tab", { name: "Accounts" })).toBeVisible();
  const snapshot = await mailShellCoverage(page);
  expectedSnapshots.set(outputPath(testInfo), {
    path: snapshot.path,
    statements: snapshot.s,
  });
});

test("coverage teardown captures an app page before an explicit context close", async ({
  page,
  context,
}, testInfo: TestInfo) => {
  test.skip(
    process.env.E2E_COVERAGE !== "true",
    "This regression requires the instrumented Vite server",
  );
  await installMockIpc(page);
  await page.goto("/?localMail=1");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.click();
  await expect(page.getByRole("tab", { name: "Accounts" })).toBeVisible();
  const snapshot = await mailShellCoverage(page);
  expectedSnapshots.set(outputPath(testInfo), {
    path: snapshot.path,
    statements: snapshot.s,
  });
  await context.close();
});

test("coverage teardown merges app counters across a reload", async ({
  page,
}, testInfo: TestInfo) => {
  test.skip(
    process.env.E2E_COVERAGE !== "true",
    "This regression requires the instrumented Vite server",
  );
  await installMockIpc(page);
  await page.goto("/?localMail=1");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  const firstBefore = await mailShellCoverage(page);
  await settings.click();
  await expect(page.getByRole("tab", { name: "Accounts" })).toBeVisible();
  const firstDocument = await mailShellCoverage(page);
  expect(statementTotal(firstDocument)).toBeGreaterThan(
    statementTotal(firstBefore),
  );

  await page.reload();
  await expect(settings).toBeVisible();
  const finalBefore = await mailShellCoverage(page);
  await settings.click();
  await expect(page.getByRole("tab", { name: "Accounts" })).toBeVisible();
  const finalDocument = await mailShellCoverage(page);
  expect(statementTotal(finalDocument)).toBeGreaterThan(
    statementTotal(finalBefore),
  );

  expectedSnapshots.set(outputPath(testInfo), {
    path: firstDocument.path,
    statements: addStatements(firstDocument, finalDocument),
  });
});

test("coverage teardown bounds 13 navigated document snapshots", async ({
  page,
}, testInfo: TestInfo) => {
  test.skip(
    process.env.E2E_COVERAGE !== "true",
    "This regression requires the instrumented Vite server",
  );
  await installMockIpc(page);

  const snapshots: FileCoverageSnapshot[] = [];
  for (let index = 0; index < 13; index += 1) {
    await page.goto(`/?localMail=1&coveragePage=${index}`);
    if (index > 0) {
      const previousDocument = await readPagehideCoverage(page);
      expect(previousDocument).not.toBeNull();
      snapshots.push(previousDocument!);
    }
    await captureMailShellOnPagehide(page);
    const settings = page.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    await expect(settings).toBeVisible();
    await settings.click();
    await expect(page.getByRole("tab", { name: "Accounts" })).toBeVisible();
  }
  snapshots.push(await mailShellCoverage(page));

  let merged = snapshots[0]!;
  for (const snapshot of snapshots.slice(1)) {
    merged = {
      path: merged.path,
      s: addStatements(merged, snapshot),
    };
  }
  expectedSnapshots.set(outputPath(testInfo), {
    path: merged.path,
    statements: merged.s,
  });
});
