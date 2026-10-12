import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Leaving a letter and coming back returns to the top.
// 2. A letter you have not scrolled opens partway down.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/letter-scroll.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function letterScroll(page: import("@playwright/test").Page) {
  return page.locator(".message-body iframe").evaluate((frame) => {
    const iframe = frame as HTMLIFrameElement;
    const scrolling =
      iframe.contentDocument?.scrollingElement ??
      iframe.contentDocument?.documentElement;
    return scrolling?.scrollTop ?? 0;
  });
}

test("coming back to a letter keeps your place", async ({ page }) => {
  await page.goto("/?threadGap=1&longLetter=1");
  const weekend = page.getByRole("treeitem", {
    name: /Conversation, Jane.*Weekend plans/i,
  });
  const older = page.getByRole("treeitem", { name: /Older family note/i });
  await weekend.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.locator(".message-body iframe").evaluate((frame) => {
        const iframe = frame as HTMLIFrameElement;
        const scrolling =
          iframe.contentDocument?.scrollingElement ??
          iframe.contentDocument?.documentElement;
        return scrolling
          ? scrolling.scrollHeight > scrolling.clientHeight
          : false;
      }),
    )
    .toBe(true);
  await page.locator(".message-body iframe").evaluate((frame) => {
    const iframe = frame as HTMLIFrameElement;
    const scrolling =
      iframe.contentDocument?.scrollingElement ??
      iframe.contentDocument?.documentElement;
    if (scrolling) scrolling.scrollTop = 480;
  });
  await expect.poll(() => letterScroll(page)).toBeGreaterThan(400);

  await older.click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await expect.poll(() => letterScroll(page)).toBe(0);

  await weekend.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect.poll(() => letterScroll(page)).toBeGreaterThan(400);
});
