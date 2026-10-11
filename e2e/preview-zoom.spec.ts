import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A picture preview stays at its fitted size until Zoom in.
// 2. The next text file has no zoom controls, and returning resets the picture.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/preview-zoom.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a picture preview can zoom in and out", async ({ page }) => {
  await page.goto("/?previewable=1&filePair=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Preview: family.png" }).click();
  const picture = page.getByRole("img", { name: "family.png" });
  await expect(picture).toHaveAttribute("data-zoom", "1");
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(picture).toHaveAttribute("data-zoom", "1.5");
  await page.getByRole("button", { name: "Next file" }).click();
  await expect(page.getByRole("button", { name: "Zoom in" })).toHaveCount(0);
  await page.getByRole("button", { name: "Previous file" }).click();
  await expect(page.getByRole("img", { name: "family.png" })).toHaveAttribute(
    "data-zoom",
    "1",
  );
});
