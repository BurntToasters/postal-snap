import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A picture and a text file are labeled only by size.
// 2. A message with no files shows a file kind.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/message-file-kind.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openWeekend(page: import("@playwright/test").Page) {
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
}

test("each file names its kind", async ({ page }) => {
  await page.goto("/?previewable=1&filePair=1");
  await openWeekend(page);
  await expect(
    page.getByRole("button", { name: "Download file: family.png" }),
  ).toContainText("PNG");
  await expect(
    page.getByRole("button", { name: "Download file: notes.txt" }),
  ).toContainText("Text");
});

test("a letter with no files shows no file kind", async ({ page }) => {
  await page.goto("/");
  await openWeekend(page);
  await expect(page.locator(".attachment-list")).toHaveCount(0);
});
