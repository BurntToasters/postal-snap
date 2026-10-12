import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. With two accounts, the message list names the open account, even when the mailbox list is hidden.
// 2. One account leaves that name off the list heading.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/pane-account-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("two accounts name the open account on the message list", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  const account = page.locator(".pane-heading .pane-account");
  await expect(account).toHaveText("Sam");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.getByRole("button", { name: "Hide mailboxes" }).click();
  await expect(account).toHaveText("Sam");
});

test("one account leaves that name off the list heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.locator(".pane-heading .pane-account")).toHaveCount(0);
});
