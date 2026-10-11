import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation move into a chosen folder.
// 2. Move conversation files every loaded message and opens the next one.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/move-conversation-folder-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot move a conversation to a folder", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: /Move conversation to/ }),
  ).toHaveCount(0);
});

test("move conversation files the loaded thread and opens the next message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&nestedFolders=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", {
      name: "Move conversation to Projects",
      exact: true,
    })
    .click();
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
    destinationMailboxId: 4,
  });
});
