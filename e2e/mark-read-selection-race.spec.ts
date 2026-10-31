import type { TestInfo } from "@playwright/test";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";
import { recordIpc, recordedCalls } from "./ipc-recorder";

test.use({ trace: "off" });

type RaceWindow = Window & { finishAutomaticRead?: () => void };

const artifactDirectory = resolve(
  "artifacts/codebase-fixes-2026-10-29/frontend/mark-read-selection-race",
);

function artifactSlug(testInfo: TestInfo) {
  return `${testInfo.project.name}-${testInfo.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150);
}

async function holdReadFor(
  page: import("@playwright/test").Page,
  ...ids: number[]
) {
  await page.addInitScript((messageIds: number[]) => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const original = mock.handlers.set_message_flags;
    mock.handlers.set_message_flags = (args) => {
      if (messageIds.includes(Number(args.messageId)) && args.isRead === true) {
        (window as { __heldMarkReadId?: number }).__heldMarkReadId = Number(
          args.messageId,
        );
        return new Promise<void>((resolveRead) => {
          (window as RaceWindow).finishAutomaticRead = resolveRead;
        });
      }
      return original(args);
    };
  }, ids);
}

function weekendRow(page: import("@playwright/test").Page) {
  return page.locator('[data-option-key="message:10"]');
}

async function waitForHeldRead(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as RaceWindow).finishAutomaticRead),
    )
    .toBe("function");
}

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.context().tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const slug = artifactSlug(testInfo);
  await mkdir(artifactDirectory, { recursive: true });
  const calls = page.isClosed() ? [] : await recordedCalls(page);
  const jsonPath = resolve(artifactDirectory, `${slug}.json`);
  const screenshotPath = resolve(artifactDirectory, `${slug}.png`);
  const tracePath = resolve(artifactDirectory, `${slug}.zip`);
  const temporaryTrace = resolve(
    tmpdir(),
    `postal-snap-mark-read-${testInfo.project.name}-${testInfo.testId}-${testInfo.retry}.zip`,
  );

  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        project: testInfo.project.name,
        title: testInfo.title,
        status: testInfo.status,
        calls,
      },
      null,
      2,
    )}\n`,
  );
  if (!page.isClosed()) {
    await page.screenshot({ path: screenshotPath });
  }
  await page.context().tracing.stop({ path: temporaryTrace });
  await copyFile(temporaryTrace, tracePath);
  await rm(temporaryTrace, { force: true });
});

test("list selection leaves a late mark-read row and folder count correct", async ({
  page,
}) => {
  await holdReadFor(page, 10);
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await waitForHeldRead(page);

  await page.getByRole("treeitem", { name: /Library hours/i }).click();
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();

  await page.evaluate(() => (window as RaceWindow).finishAutomaticRead?.());

  await expect(weekendRow(page)).toHaveClass(/\bread\b/);
  await expect(weekendRow(page)).not.toHaveClass(/\bunread\b/);
  await expect(page.locator(".pane-heading small")).toHaveText("3 items");
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
});

test("reader next leaves a late mark-read row and folder count correct", async ({
  page,
}) => {
  await holdReadFor(page, 10);
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await waitForHeldRead(page);

  await page.getByRole("button", { name: "Next message" }).click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();

  await page.evaluate(() => (window as RaceWindow).finishAutomaticRead?.());

  await expect(weekendRow(page)).toHaveClass(/\bread\b/);
  await expect(weekendRow(page)).not.toHaveClass(/\bunread\b/);
  await expect(page.locator(".pane-heading small")).toHaveText("3 items");
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
});

test("auto-open next message keeps list and folder unread after late mark-read", async ({
  page,
}) => {
  await holdReadFor(page, 9, 10);
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Library hours/i }).click();
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  await page
    .locator("#reader-pane")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await waitForHeldRead(page);
  const markedId = await page.evaluate(
    () => (window as { __heldMarkReadId?: number }).__heldMarkReadId,
  );
  expect(markedId).toBeTruthy();

  const awayId = markedId === 10 ? 9 : 10;
  await page.locator(`[data-option-key="message:${awayId}"]`).click();
  await expect(
    page.getByRole("heading", {
      name: awayId === 10 ? "Weekend plans" : "Older family note",
    }),
  ).toBeVisible();

  await page.evaluate(() => (window as RaceWindow).finishAutomaticRead?.());

  const markedRow = page.locator(`[data-option-key="message:${markedId}"]`);
  await expect(markedRow).toHaveClass(/\bread\b/);
  await expect(markedRow).not.toHaveClass(/\bunread\b/);
  await expect(page.locator(".pane-heading small")).toHaveText("2 items");
  await expect(
    page.getByRole("heading", {
      name: awayId === 10 ? "Weekend plans" : "Older family note",
    }),
  ).toBeVisible();
});
