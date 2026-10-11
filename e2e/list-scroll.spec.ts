import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Leaving a folder and coming back keeps the list where you scrolled.
// 2. A folder you have not scrolled opens at the top.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/list-scroll-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("coming back to a folder keeps the list where you left it", async ({
  page,
}) => {
  await page.goto("/?longList=1");
  const folders = page.getByRole("navigation", { name: "Mailboxes" });
  const list = page.locator(".message-list");
  await expect(list).toBeVisible();
  await list.evaluate((node) => {
    node.scrollTop = 480;
  });
  await expect
    .poll(async () => list.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(400);

  await folders.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await folders.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect
    .poll(async () => list.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(400);
});

test("a folder you have not scrolled opens at the top", async ({ page }) => {
  await page.goto("/?longList=1");
  const list = page.locator(".message-list");
  await expect(list).toBeVisible();
  await expect
    .poll(async () => list.evaluate((node) => node.scrollTop))
    .toBe(0);
});
