import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message row names how many files it has.
// 2. A picture in the letter leaves that count off and keeps the file mark.
// 3. A message with no files leaves both off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/message-file-count-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function row(page: import("@playwright/test").Page) {
  return page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
}

test("a message row names its files", async ({ page }) => {
  await page.goto("/?fileCount=2");
  await expect(row(page)).toContainText("2 files");
});

test("a picture in the letter leaves the count off", async ({ page }) => {
  await page.goto("/?inlineFile=1");
  const message = row(page);
  await expect(message).toBeVisible();
  await expect(message).not.toContainText("file");
  await expect(message.locator("svg")).toHaveCount(1);
});

test("a message with no files leaves the count off", async ({ page }) => {
  await page.goto("/");
  const message = row(page);
  await expect(message).toBeVisible();
  await expect(message.locator(".message-file-count")).toHaveCount(0);
});
