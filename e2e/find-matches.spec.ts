import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A word in the message reports which match this is.
// 2. A missing word says there are no matches.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/find-matches.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("find in the open message reports the matches", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("heading", { name: "Weekend plans" }).click();
  await page.keyboard.press("Alt+Meta+f");
  const find = page.getByRole("textbox", { name: "Find in message" });
  await find.fill("Saturday");
  await find.press("Enter");
  await expect(page.locator(".message-find-status")).toHaveText("1 of 1");
  await find.fill("zzzz");
  await find.press("Enter");
  await expect(page.locator(".message-find-status")).toHaveText("No matches");
});
