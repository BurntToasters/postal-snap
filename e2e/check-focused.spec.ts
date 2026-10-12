import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. x checks the focused row and leaves the message closed.
// 2. x again removes that check and stays in selection.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/check-focused.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("x checks the focused message without opening it", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("x");
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await row.focus();
  await page.keyboard.press("x");
  await expect(page.getByRole("toolbar", { name: "0 selected" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});
