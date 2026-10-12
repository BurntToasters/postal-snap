import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation move.
// 2. Archive conversation files every loaded message in the thread and opens the next one.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/archive-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot archive a conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Archive conversation" }),
  ).toHaveCount(0);
});

test("archive conversation files the loaded thread and opens the next message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
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
