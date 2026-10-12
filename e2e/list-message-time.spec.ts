import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message from another day shows the date and hides the time.
// 2. The row time replaces the exact date you can point at.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/list-message-time.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message row shows the date and the time", async ({ page }) => {
  await page.goto("/");
  const when = page.locator(".message-date").first();
  await expect(when).toHaveText(/\d{1,2}:\d{2}/);
  await expect(when).toHaveText(/,/);
  const title = await when.getAttribute("title");
  expect(title).toMatch(/August/i);
  expect(title).not.toBe((await when.textContent())?.trim());
});
