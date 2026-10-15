import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Marking a row read opens the message.
// 2. The row stays labeled unread after the click.
// 3. The in-row unread dot stays filled after the row is read.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/list-read-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a listed message can be marked read without opening it", async ({
  page,
}) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toHaveAccessibleName(/Unread/i);
  const dot = row.locator(".unread-dot");
  await expect(dot).toBeVisible();
  const unreadColor = await dot.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(unreadColor).not.toBe("rgba(0, 0, 0, 0)");
  const wrap = page.locator(".message-row-wrap").filter({ has: row });
  await wrap.hover();
  const read = wrap.locator('button.row-action[data-action="read"]');
  await expect(read).toHaveAttribute("aria-label", "Mark read");
  await read.click();
  await expect(row).not.toHaveAttribute("aria-selected", "true");
  await expect(row).not.toHaveAccessibleName(/Unread/i);
  await expect(read).toHaveAttribute("aria-label", "Mark unread");
  const readColor = await dot.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(readColor).toBe("rgba(0, 0, 0, 0)");
});
