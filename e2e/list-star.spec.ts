import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Clicking the star opens the message instead of starring it.
// 2. A starred row loses the star control.
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
  await page
    .getByRole("button", { name: "Add star", includeHidden: true })
    .click();
  await expect(row).not.toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Remove star", includeHidden: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(row).toHaveAccessibleName(/Starred/i);
});
