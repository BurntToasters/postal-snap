import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Dropping the conversation header moves every loaded message in it.
// A single row inside the conversation is covered by the mailbox test.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/conversation-drag-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("dropping a conversation on a folder moves every loaded message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const header = page.getByRole("treeitem", { name: /Weekend plans/i });
  await expect(header).toBeVisible();
  await header.dragTo(page.getByRole("button", { name: "Archive" }));
  await expect(
    page.getByRole("treeitem", { name: /Weekend plans/i }),
  ).toHaveCount(0);
  const moved = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "move_messages_to_mailbox",
    ),
  );
  expect(moved?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    destinationMailboxId: 2,
  });
});
