import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Bodies far over the forward limit still open a composer.
// 2. The too-large error appears late, after every body is built.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/forward-conversation-limit-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an oversized conversation reports too large and opens no composer", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&hugeThread=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  const started = Date.now();
  await page
    .getByRole("menuitem", { name: "Forward conversation", exact: true })
    .click();
  await expect(
    page.getByText("This conversation is too large to forward."),
  ).toBeVisible({ timeout: 5000 });
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(page.locator(".composer-window")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Forward", exact: true }),
  ).toHaveCount(0);
});
