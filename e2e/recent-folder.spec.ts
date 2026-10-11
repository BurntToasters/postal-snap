import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A chosen folder stays behind the other folders.
// 2. Inbox jumps ahead of a folder the user just chose.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/recent-folder.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the last folder used for a move stays at the top", async ({ page }) => {
  await page.goto("/?manyFolders=1&threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  const moveGroup = () => page.getByRole("group", { name: "Move to" });
  await expect(moveGroup().getByRole("menuitem").first()).toHaveAccessibleName(
    "Move to Receipts",
  );
  await moveGroup()
    .getByRole("menuitem", { name: "Move to School", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(moveGroup().getByRole("menuitem").first()).toHaveAccessibleName(
    "Move to School",
  );
  const saved = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __POSTAL_SNAP_TEST__?: {
          savedSettings?: Array<{ recentMoveMailboxId?: number | null }>;
        };
      }
    ).__POSTAL_SNAP_TEST__;
    return state?.savedSettings?.at(-1)?.recentMoveMailboxId;
  });
  expect(saved).toBe(12);
});

test("a folder chosen last time is first in Move to", async ({ page }) => {
  await page.goto("/?manyFolders=1&threadGap=1&recentFolder=12");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("group", { name: "Move to" }).getByRole("menuitem").first(),
  ).toHaveAccessibleName("Move to School");
});
