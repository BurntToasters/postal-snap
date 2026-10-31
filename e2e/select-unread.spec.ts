import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Select unread checks loaded unread messages and leaves read ones unchecked.
// 2. A read message that shares a conversation stays unchecked.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/select-unread-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("select unread checks only unread messages in the mailbox", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&mixedRead=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Select unread", exact: true })
    .click();
  await expect(
    page.locator('.message-select[aria-label="Select Weekend plans"]'),
  ).toBeChecked();
  await expect(
    page.locator('.message-select[aria-label="Select Older family note"]'),
  ).toBeChecked();
  await expect(
    page.locator('.message-select[aria-label="Select Library hours"]'),
  ).not.toBeChecked();
  await expect(page.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
});
