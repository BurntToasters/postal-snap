import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Previous unread mailbox walks backward, so Trash comes before Inbox
//    when both Archive and Trash have unread mail.
// 2. The [ shortcut does the same jump.
// 3. The action stays unavailable when no other mailbox has unread mail.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/previous-unread-mailbox-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("stays unavailable when this mailbox is the only unread one", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Previous unread mailbox" }),
  ).toBeDisabled();
});

test("opens the previous mailbox with unread mail", async ({ page }) => {
  await page.goto("/?unreadArchive=1&unreadTrash=1");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Previous unread mailbox" }).click();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
});

test("the bracket shortcut opens the previous unread mailbox", async ({
  page,
}) => {
  await page.goto("/?unreadArchive=1&unreadTrash=1");
  await page.keyboard.press("[");
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
});
