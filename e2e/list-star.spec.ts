import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Clicking the star opens the message instead of starring it.
// 2. A starred row loses its inline star mark.
// 3. The hover star is missing or opens the row.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/list-star-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a listed message can be starred without opening it", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toBeVisible();
  await expect(row.locator(".star-mark")).toHaveCount(0);
  const wrap = page.locator(".message-row-wrap").filter({ has: row });
  await wrap.hover();
  await wrap.locator('button.row-action[data-action="star"]').click();
  await expect(row).not.toHaveAttribute("aria-selected", "true");
  await expect(
    wrap.locator('button.row-action[data-action="star"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    wrap.locator('button.row-action[data-action="star"]'),
  ).toHaveAttribute("aria-label", "Remove star");
  await expect(row).toHaveAccessibleName(/Starred/i);
  await expect(row.locator(".message-subject .star-mark")).toBeVisible();
});
