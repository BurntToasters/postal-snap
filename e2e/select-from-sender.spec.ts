import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. One loaded message from a sender has no select-from-sender action.
// 2. Select messages from this sender checks every loaded message from that address.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/select-from-sender-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("one message cannot select others from the sender", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Select messages from this sender" }),
  ).toHaveCount(0);
});

test("selects every loaded message from this sender", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Select messages from this sender" })
    .click();
  await expect(page.getByRole("toolbar", { name: "3 selected" })).toBeVisible();
  await expect(
    page.locator('.message-select[aria-label="Select Weekend plans"]'),
  ).toBeChecked();
  await expect(
    page.locator('.message-select[aria-label="Select Older family note"]'),
  ).toBeChecked();
  await expect(
    page.locator('.message-select[aria-label="Select Library hours"]'),
  ).toBeChecked();
});
