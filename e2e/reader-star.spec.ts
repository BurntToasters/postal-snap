import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The open message can be starred without opening More.
// 2. The same button removes that star, and the list follows.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/reader-star-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function row(page: import("@playwright/test").Page) {
  return page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
}

test("the open message can be starred from the toolbar", async ({ page }) => {
  await page.goto("/");
  await row(page).click();
  const star = page
    .locator(".reader-actions")
    .getByRole("button", { name: "Add star", exact: true });
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  const remove = page
    .locator(".reader-actions")
    .getByRole("button", { name: "Remove star", exact: true });
  await expect(remove).toHaveAttribute("aria-pressed", "true");
  await expect(row(page)).toHaveAccessibleName(/Starred/);
  await remove.click();
  await expect(star).toBeVisible();
  await expect(row(page)).not.toHaveAccessibleName(/Starred/);
});
