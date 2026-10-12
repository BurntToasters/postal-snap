import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Go to Inbox stays unavailable while Inbox is already open.
// 2. The menu and the i shortcut both return from another mailbox.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/go-to-inbox-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("stays unavailable while Inbox is open", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Go to Inbox" }),
  ).toBeDisabled();
});

test("the menu returns to Inbox", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Go to Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("the i shortcut returns to Inbox", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.keyboard.press("i");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});
