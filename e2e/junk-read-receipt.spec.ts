import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A receipt request in Junk shows no receipt prompt.
// 2. The same request in Inbox still shows the prompt.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/junk-read-receipt-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a read receipt request in Junk shows no prompt", async ({ page }) => {
  await page.goto("/?readReceipt=1&inJunk=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByText("This message is in Junk.")).toBeVisible();
  await expect(
    page.getByText(/A receipt would go to jane@example.com/),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Don't send" })).toHaveCount(0);
});

test("a read receipt request in Inbox shows the prompt", async ({ page }) => {
  await page.goto("/?readReceipt=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByText(/A receipt would go to jane@example.com/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Don't send" })).toBeVisible();
});
