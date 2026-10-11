import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation snooze action.
// 2. Snooze conversation hides every loaded message in the thread and opens the next one.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/snooze-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot snooze a conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Snooze conversation", exact: true }),
  ).toHaveCount(0);
});

test("snooze conversation hides the loaded thread", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Snooze conversation", exact: true })
    .click();
  await page.getByRole("button", { name: "Tomorrow morning" }).click();
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  const snoozed = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "snooze_messages",
    ),
  );
  expect(snoozed?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
  });
  expect(snoozed?.args.untilIso).toEqual(expect.any(String));
});
