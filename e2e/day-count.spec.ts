import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A day heading hides how many messages it contains.
// 2. The count includes messages from another day.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/day-count.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a day heading counts the messages under it", async ({ page }) => {
  await page.goto("/?longList=1");
  const groups = page.locator(".list-day-group");
  await expect(groups.first()).toBeVisible();
  const total = await groups.count();
  expect(total).toBeGreaterThan(1);
  for (let index = 0; index < total; index += 1) {
    const group = groups.nth(index);
    const rows = await group.locator(".message-row").count();
    expect(rows).toBeGreaterThan(0);
    await expect(group.locator(".list-day-count")).toHaveText(
      rows === 1 ? "1 message" : `${rows} messages`,
    );
  }
});
