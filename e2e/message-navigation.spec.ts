import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Next skips the following loaded message.
// 2. Previous walks off the top of the list.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/message-navigation.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("previous and next open the neighboring message", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Previous message" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Next message" }).click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Previous message" }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});
