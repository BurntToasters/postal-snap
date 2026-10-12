import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Reply, reply all, forward, archive, and star hide their keys.
// 2. Mark unread in More hides its key.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/reader-shortcut-hints.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("letter actions show their keyboard shortcuts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/ }).click();
  const actions = page.locator(".reader-unified-actions");
  await expect(
    actions.getByRole("button", { name: "Reply", exact: true }),
  ).toHaveAttribute("title", /⌘R|Ctrl\+R/);
  await expect(
    actions.getByRole("button", { name: "Reply all", exact: true }),
  ).toHaveAttribute("title", /⇧⌘R|Ctrl\+Shift\+R/);
  await expect(
    actions.getByRole("button", { name: "Forward", exact: true }),
  ).toHaveAttribute("title", /⇧⌘F|Ctrl\+Shift\+F/);
  await expect(
    actions.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveAttribute("title", /⌘E|Ctrl\+E/);
  await expect(
    actions.getByRole("button", { name: "Add star", exact: true }),
  ).toHaveAttribute("title", /⇧⌘L|Ctrl\+Shift\+L/);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Mark unread" }).locator("kbd"),
  ).toHaveText(/⇧⌘U|Ctrl\+Shift\+U/);
});
