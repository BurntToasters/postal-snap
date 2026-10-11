import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Opening another message drops the reply started under the first.
// 2. A note under the second message replaces the first.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/quick-reply-keep.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a started reply stays with its message", async ({ page }) => {
  await page.goto("/?threadGap=1");
  const weekend = page.getByRole("treeitem", {
    name: /Conversation, Jane.*Weekend plans/i,
  });
  const older = page.getByRole("treeitem", { name: /Older family note/i });
  await weekend.click();
  const box = page.getByRole("textbox", { name: "Write a reply" });
  await box.fill("See you then");
  await older.click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await expect(box).toHaveValue("");
  await box.fill("On my way");
  await weekend.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect(box).toHaveValue("See you then");
  await older.click();
  await expect(box).toHaveValue("On my way");
});
