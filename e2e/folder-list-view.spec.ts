import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A folder with no saved list keeps the account-wide unread filter.
// 2. Changing Archive to All leaves Inbox on Unread.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/folder-list-view-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

const row = (page: import("@playwright/test").Page, name: RegExp) =>
  page.getByRole("option", { name }).or(page.getByRole("treeitem", { name }));

test("each folder keeps its own list filter", async ({ page }) => {
  await page.goto("/?folderViews=1&mailboxFilter=unread");
  await expect(page.getByRole("radio", { name: "Unread" })).toBeChecked();
  await expect(row(page, /Weekend plans/i)).toBeVisible();
  await expect(row(page, /Read note/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Unread" })).toBeChecked();
  await expect(row(page, /Filed note/i)).toHaveCount(0);

  await page.getByRole("radio", { name: "All", exact: true }).click();
  await expect(row(page, /Filed note/i)).toBeVisible();
  await expect
    .poll(async () => {
      const calls = await page.evaluate(
        () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
      );
      return calls.some((call) => {
        if (call.command !== "save_settings") return false;
        const views = (
          call.args.settings as
            | { mailboxViews?: { mailboxId?: number; filter?: string }[] }
            | undefined
        )?.mailboxViews;
        return views?.some(
          (view) => view.mailboxId === 2 && view.filter === "all",
        );
      });
    })
    .toBe(true);

  await page.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Unread" })).toBeChecked();
  await expect(row(page, /Weekend plans/i)).toBeVisible();
  await expect(row(page, /Read note/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "All", exact: true }),
  ).toBeChecked();
  await expect(row(page, /Filed note/i)).toBeVisible();
});
