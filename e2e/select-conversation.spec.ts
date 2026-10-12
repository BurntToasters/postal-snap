import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation selection.
// 2. Select conversation checks the loaded thread and leaves the other message unchecked.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/select-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot select a conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Select conversation" }),
  ).toHaveCount(0);
});

test("select conversation checks the loaded thread", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select conversation" }).click();
  await expect(page.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select Weekend plans" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select Older family note" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select Library hours" }),
  ).not.toBeChecked();
});
