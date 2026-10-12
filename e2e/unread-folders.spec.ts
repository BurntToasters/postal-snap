import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Folders with no unread mail stay in the list until the filter is on.
// 2. Inbox stays visible when the filter is on.
// 3. The choice is still on after the next launch, and can be turned off.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/unread-folders.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the folder list can show unread folders", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unread folders" }).click();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Inbox/ })).toBeVisible();
  const saved = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __POSTAL_SNAP_TEST__?: {
          savedSettings?: Array<{ unreadFoldersOnly?: boolean }>;
        };
      }
    ).__POSTAL_SNAP_TEST__;
    return state?.savedSettings?.at(-1)?.unreadFoldersOnly;
  });
  expect(saved).toBe(true);
  await page.goto("/?unreadFolders=1");
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Unread folders" }).click();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();
});
