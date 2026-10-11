import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation junk action.
// 2. Mark conversation as junk moves every loaded message in the thread.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/junk-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot mark a conversation as junk", async ({
  page,
}) => {
  await page.goto("/?junkFolder=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Mark conversation as junk" }),
  ).toHaveCount(0);
});

test("mark conversation as junk files the loaded thread", async ({ page }) => {
  await page.goto("/?threadGap=1&junkFolder=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Mark conversation as junk" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  const moved = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "move_messages_to_mailbox",
    ),
  );
  expect(moved?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    destinationMailboxId: 11,
  });
});
