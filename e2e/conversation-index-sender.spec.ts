import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Messages in one conversation are labeled only by the subject.
// 2. A sender from another conversation is listed here.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/conversation-index-sender.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("each message in the conversation names its sender", async ({ page }) => {
  await page.goto("/?threadGap=1&threadPeople=1");
  await page
    .getByRole("treeitem", { name: /Conversation, Jane, Lee/i })
    .click();
  const index = page.getByRole("navigation", { name: "In this conversation" });
  await expect(index.locator(".conversation-index-sender")).toHaveText([
    "Jane",
    "Lee",
  ]);
});
