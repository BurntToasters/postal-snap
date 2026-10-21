import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message can be pinned and then unpinned.
// 2. A pinned message stays above newer mail, under a Pinned heading.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/pin-message-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("pin moves an older message above newer mail", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Library hours/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(page.getByRole("treeitem").first()).toHaveAccessibleName(
    /Pinned[\s\S]*Library hours/,
  );
  await expect(page.locator(".list-day", { hasText: "Pinned" })).toBeVisible();
  const pinned = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "set_messages_pinned",
    ),
  );
  expect(pinned?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [30],
    pinned: true,
  });
});

test("a pinned message is already at the top of the list", async ({ page }) => {
  await page.goto("/?threadGap=1&pinned=1");
  await expect(page.locator(".list-day", { hasText: "Pinned" })).toBeVisible();
  await expect(page.getByRole("treeitem").first()).toHaveAccessibleName(
    /Library hours/,
  );
});
