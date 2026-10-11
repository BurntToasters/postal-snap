import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A folder that has more mail than the loaded page names both counts, and its unread count.
// 2. A folder whose loaded page is the whole folder keeps an item count, with unread when there is some.
// 3. A folder with no unread mail leaves that count off.
// 4. A filter or search counts what is on screen, not the folder total or its unread count.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/folder-total-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a partly loaded folder names how many messages it holds", async ({
  page,
}) => {
  await page.goto("/?folderTotal=40");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.locator(".pane-heading small")).toHaveText(
    "1 unread · 1 of 40",
  );
});

test("a fully loaded folder keeps an item count", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".pane-heading small")).toHaveText(
    "1 unread · 1 item",
  );
});

test("a folder with no unread mail leaves that count off", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  // The archived message is counted here; with no unread mail, no unread part shows.
  await expect(page.locator(".pane-heading small")).toHaveText("1 item");
});

test("a filter counts the messages on screen", async ({ page }) => {
  await page.goto("/?folderTotal=40");
  await page.getByRole("radio", { name: "Starred", exact: true }).click();
  await expect(page.locator(".pane-heading small")).toHaveText("0 items");
  await page.getByRole("radio", { name: "All", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search mail" }).fill("weekend");
  await page.getByRole("searchbox", { name: "Search mail" }).press("Enter");
  await expect(page.locator(".pane-heading small")).toHaveText("1 item");
});
