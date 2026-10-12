import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Resizing the compose window stores that size.
// 2. The next compose window opens at the stored size.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-window-size.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the compose window keeps its size", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const windowBox = page.locator(".composer-window");
  const before = await windowBox.boundingBox();
  expect(before).not.toBeNull();
  await page.getByRole("button", { name: "Resize message window" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const state = (
          window as unknown as {
            __POSTAL_SNAP_TEST__?: {
              savedSettings?: Array<{ composerWidth?: number }>;
            };
          }
        ).__POSTAL_SNAP_TEST__;
        return state?.savedSettings?.at(-1)?.composerWidth ?? 0;
      });
    })
    .toBeGreaterThan(before?.width ?? 0);
  await page.getByRole("button", { name: "Discard" }).click();
  await page.goto("/?composerWidth=640&composerHeight=420");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const restored = await windowBox.boundingBox();
  expect(restored?.width ?? 0).toBeGreaterThan(620);
  expect(restored?.width ?? 0).toBeLessThan(660);
  expect(restored?.height ?? 0).toBeGreaterThan(400);
  expect(restored?.height ?? 0).toBeLessThan(440);
});
