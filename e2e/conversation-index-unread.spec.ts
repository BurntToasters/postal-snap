import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An unread message in the conversation is listed without saying so.
// 2. A conversation with no unread mail still says Unread.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/conversation-index-unread.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an unread message in the conversation says so", async ({ page }) => {
  await page.goto("/?threadGap=1&threadPeople=1&threadUnread=1");
  await page
    .getByRole("treeitem", { name: /Conversation, Jane, Lee/i })
    .click();
  const index = page.getByRole("navigation", { name: "In this conversation" });
  await expect(index.locator(".conversation-index-unread")).toHaveText([
    "Unread",
  ]);
  await expect(
    index.getByRole("button", { name: /Unread, Older family note from Lee/ }),
  ).toBeVisible();
  await expect(
    index.getByRole("button", { name: /^Weekend plans from Jane/ }),
  ).toBeVisible();
});

test("a read conversation leaves the unread note off", async ({ page }) => {
  await page.goto("/?threadGap=1&threadRead=1");
  await page.getByRole("treeitem", { name: /Conversation, Jane/i }).click();
  const index = page.getByRole("navigation", { name: "In this conversation" });
  await expect(index.locator(".conversation-index-unread")).toHaveCount(0);
});
