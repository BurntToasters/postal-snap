import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A reply can show the message being answered without leaving the composer.
// 2. A new message has no original to show.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/compose-original-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a reply can show the message being answered", async ({ page }) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const original = page.locator(".compose-original");
  await expect(original).not.toHaveAttribute("open", "");
  await original.locator("summary").click();
  await expect(original).toContainText("Jane");
  await expect(original).toContainText("Weekend plans");
  await expect(original).toContainText("Are we still meeting on Saturday?");
});

test("a new message has no original", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.locator(".compose-original")).toHaveCount(0);
});
