import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A draft with files names that count in the drafts list.
// 2. A draft with no files leaves the count off the row.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/draft-files-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a draft with files names the count", async ({ page }) => {
  await page.goto("/?localMail=1&draftFiles=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const row = page.getByRole("button", { name: /Family update/ });
  await expect(row.locator(".draft-files")).toHaveText("2 files");
});

test("a draft with no files leaves the count off", async ({ page }) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.locator(".draft-files")).toHaveCount(0);
  await expect(page.getByText("Family update")).toBeVisible();
});
