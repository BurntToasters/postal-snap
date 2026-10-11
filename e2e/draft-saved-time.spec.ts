import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Saving a draft leaves the status without a time.
// 2. The time appears before the draft is saved.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/draft-saved-time.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a saved draft says when it was saved", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "To" })).toBeFocused();
  await expect(page.getByText(/Draft saved at /)).toHaveCount(0);
  await page.locator("#composer-subject").fill("Picnic");
  await page.keyboard.press("Control+s");
  await expect(page.getByText(/Draft saved at /).first()).toBeVisible();
});
