import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Cancel leaves the message in place and saves no rule.
// 2. Confirm saves a Junk rule for the sender's domain.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/block-domain-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("block domain saves a Junk rule for that domain", async ({ page }) => {
  page.once("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Block domain", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
  const state = await page.evaluate(() => ({
    moved: window.__POSTAL_SNAP_TEST__?.moved ?? false,
    rules: window.__POSTAL_SNAP_TEST__?.rules ?? [],
  }));
  expect(state.moved).toBe(true);
  expect(state.rules).toEqual([
    expect.objectContaining({
      field: "domain",
      action: "move_junk",
      contains: "example.com",
      enabled: true,
    }),
  ]);
});
