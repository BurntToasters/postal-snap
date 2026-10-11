import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Details stay open when the next message opens.
// 2. Closing details keeps the next message closed too.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/details-stay-open-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("details stay open on the next message", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator("#message-details-panel")).toBeVisible();
  await page.getByRole("button", { name: "Next message" }).click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await expect(page.locator("#message-details-panel")).toBeVisible();
});

test("closing details keeps the following message closed", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await page.getByRole("button", { name: "Hide details" }).click();
  await page.getByRole("button", { name: "Next message" }).click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await expect(page.locator("#message-details-panel")).toHaveCount(0);
});
