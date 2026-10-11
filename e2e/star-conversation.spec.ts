import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation star action.
// 2. Star conversation marks every loaded message, then Remove stars clears them.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/star-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot star a conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Star conversation" }),
  ).toHaveCount(0);
});

test("star conversation marks the loaded thread and remove stars clears it", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Star conversation" }).click();
  await expect(page.getByRole("treeitem", { name: /Starred/i })).toHaveCount(3);
  const starred = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
      (call) => call.command === "set_messages_flags",
    ),
  );
  expect(starred?.at(-1)?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    isStarred: true,
  });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remove stars" }).click();
  await expect(page.getByRole("treeitem", { name: /Starred/i })).toHaveCount(0);
  const cleared = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
      (call) => call.command === "set_messages_flags",
    ),
  );
  expect(cleared?.at(-1)?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    isStarred: false,
  });
});
