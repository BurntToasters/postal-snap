import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A conversation with one unread message hides that count.
// 2. A conversation with no unread mail still says it is unread.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/conversation-unread-count-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a conversation names its unread messages", async ({ page }) => {
  await page.goto("/?threadGap=1&threadUnread=1");
  const header = page.getByRole("treeitem", {
    name: /Conversation, Jane.*Weekend plans/i,
  });
  await expect(header.locator(".thread-count")).toHaveText("2");
  await expect(header.locator(".thread-unread")).toHaveText("1 unread");
});

test("a read conversation leaves the unread count off", async ({ page }) => {
  await page.goto("/?threadGap=1&threadRead=1");
  const header = page.getByRole("treeitem", {
    name: /Conversation, Jane.*Weekend plans/i,
  });
  await expect(header.locator(".thread-count")).toHaveText("2");
  await expect(header.locator(".thread-unread")).toHaveCount(0);
});
