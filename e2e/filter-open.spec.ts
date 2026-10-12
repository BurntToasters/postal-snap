import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Opening an unread message keeps it on the Unread list after it is marked read.
// 2. Other read messages stay off that list.
// 3. Closing the message lets it leave the Unread list.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/filter-open-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function row(page: import("@playwright/test").Page, name: RegExp) {
  return page
    .getByRole("option", { name })
    .or(page.getByRole("treeitem", { name }));
}

test("the open message stays in a filtered list", async ({ page }) => {
  await page.goto("/?folderViews=1&mailboxFilter=unread&pane=hidden");
  const weekend = row(page, /Weekend plans/i);
  await expect(weekend).toBeVisible();
  await expect(row(page, /Read note/i)).toHaveCount(0);
  await weekend.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect(weekend).not.toHaveAccessibleName(/Unread/);
  await expect(weekend).toBeVisible();
  await expect(row(page, /Read note/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Close message" }).click();
  await expect(weekend).toHaveCount(0);
  await expect(page.getByText("No unread messages.")).toBeVisible();
});
