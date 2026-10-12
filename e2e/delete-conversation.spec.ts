import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message that is not part of a Trash conversation has no delete action.
// 2. Delete conversation permanently removes every loaded message in that
//    Trash conversation and opens the next message.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/delete-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single Trash message has no delete conversation action", async ({
  page,
}) => {
  await page.goto("/?trashThread=1");
  await page.getByRole("button", { name: /^Trash/ }).click();
  await page.getByRole("treeitem", { name: /Keep this/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Delete conversation", exact: true }),
  ).toHaveCount(0);
});

test("delete conversation removes the loaded Trash thread", async ({
  page,
}) => {
  await page.goto("/?trashThread=1");
  await page.getByRole("button", { name: /^Trash/ }).click();
  await page.getByRole("treeitem", { name: /Old receipt/i }).click();
  await expect(
    page.getByRole("heading", { name: "Old receipt" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(
      "Permanently delete 2 messages? This cannot be undone.",
    );
    void dialog.accept();
  });
  await page
    .getByRole("menuitem", { name: "Delete conversation", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Keep this" })).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: /Old receipt/i }),
  ).toHaveCount(0);
  const deleted = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "delete_trash_messages",
    ),
  );
  expect(deleted?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [41, 42],
  });
});
