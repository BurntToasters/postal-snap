import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A queued message with files names that count in the Outbox.
// 2. A queued message with no files leaves the count off the row.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/outbox-files-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a queued message with files names the count", async ({ page }) => {
  await page.goto("/?localMail=1&outboxFiles=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  const row = page.locator("article", { hasText: "Could not confirm" });
  await expect(row.locator(".outbox-files")).toHaveText("2 files");
});

test("a queued message with no files leaves the count off", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Could not confirm")).toBeVisible();
  await expect(page.locator(".outbox-files")).toHaveCount(0);
});
