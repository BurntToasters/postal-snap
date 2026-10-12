import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A collapsed conversation hides marks that belong only to an older message.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/conversation-marks.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a collapsed conversation shows marks from any loaded message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&threadMarks=1");
  const header = page.getByRole("treeitem", {
    name: /Conversation, Jane, jane@example\.com, Weekend plans/i,
  });
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute(
    "aria-label",
    /Has attachments, Calendar invitation, Replied, Forwarded, 2 messages/,
  );
  await expect(header.locator(".message-subject svg")).toHaveCount(4);
});
