import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The action stays unavailable when no other mailbox has unread mail.
// 2. Next unread mailbox opens the next sidebar mailbox that has unread mail.
// 3. The ] shortcut does the same jump.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/next-unread-mailbox-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("stays put when this mailbox is the only unread one", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Next unread mailbox" }),
  ).toBeDisabled();
});

test("opens the next mailbox with unread mail", async ({ page }) => {
  await page.goto("/?unreadArchive=1");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Next unread mailbox" }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
});

test("the bracket shortcut opens the next unread mailbox", async ({ page }) => {
  await page.goto("/?unreadArchive=1");
  await page.keyboard.press("]");
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
});
