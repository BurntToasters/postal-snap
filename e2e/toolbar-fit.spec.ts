import type { Locator } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. With Update Ready shown, a slim window clips Compose off the toolbar.
// 2. The search scope chip paints over the Update Ready badge.
// 3. Search is squeezed too narrow to type in.
// 4. Icon-only toolbar buttons lose their accessible names.

test.use({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
});
test.beforeEach(async ({ page }) => installMockIpc(page));

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no layout box");
  return value;
}

for (const [width, scale] of [
  [1240, 1],
  [1050, 1],
  [900, 1],
  [800, 1],
  [1100, 1.5],
] as const) {
  test(`toolbar fits at ${width}px and ${scale * 100}% text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`/?update=1&scale=${scale}`);
    const badge = page.getByRole("button", {
      name: "Update Ready · Click to Restart",
    });
    await expect(badge).toBeVisible();

    const trailing = await box(page.locator(".toolbar-trailing"));
    const compose = await box(page.getByRole("button", { name: "Compose" }));
    const search = await box(page.locator(".search-box"));
    const scope = await box(page.locator(".search-scope"));
    const badgeBox = await box(badge);
    expect(compose.x).toBeGreaterThanOrEqual(trailing.x - 1);
    expect(scope.x + scope.width).toBeLessThanOrEqual(search.x + search.width);
    expect(search.x + search.width).toBeLessThanOrEqual(badgeBox.x);
    expect(
      await page
        .getByRole("searchbox", { name: "Search mail" })
        .evaluate((input) => input.clientWidth),
    ).toBeGreaterThanOrEqual(60);
    await expect(page.getByRole("button", { name: "Get Mail" })).toBeVisible();
    await page.screenshot({
      path: `test-results/toolbar-fit-${width}-${scale * 100}.png`,
    });
  });
}
