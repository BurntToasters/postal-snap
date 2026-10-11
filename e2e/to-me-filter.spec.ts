import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. To me keeps mail that only copies you.
// 2. To me hides mail that is addressed to you.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/to-me-filter.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("To me keeps mail addressed to this account", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await expect(
    page.getByRole("treeitem", { name: /Library hours/i }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "To me" }).click();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: /Library hours/i }),
  ).toHaveCount(0);
  await expect(page.getByText("Older family note")).toHaveCount(0);
});
