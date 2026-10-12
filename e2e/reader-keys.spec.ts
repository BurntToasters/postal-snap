import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. j moves to the next message while the letter itself has focus.
// 2. k moves back.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/reader-keys-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("j and k move between messages while the letter is focused", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  const letter = page.frameLocator(".message-body iframe").locator("body");
  await letter.click();
  await page.keyboard.press("j");
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await page.frameLocator(".message-body iframe").locator("body").click();
  await page.keyboard.press("k");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});
