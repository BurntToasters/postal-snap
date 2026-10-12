import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A queued message names when it entered the Outbox.
// 2. A message with no queued time leaves that line off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/outbox-queued-time-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a queued message names when it was queued", async ({ page }) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  const when = page.locator("time.outbox-queued");
  await expect(when).toHaveAttribute("datetime", "2026-08-18T11:00:00Z");
  await expect(when).toContainText(/^Queued /);
  await expect(when).toHaveAttribute("title", /2026/);
});

test("a queued message with no time leaves that line off", async ({ page }) => {
  await page.goto("/?localMail=1&noQueuedTime=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Could not confirm")).toBeVisible();
  await expect(page.locator("time.outbox-queued")).toHaveCount(0);
});
