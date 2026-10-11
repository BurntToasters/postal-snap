import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Cancel leaves the message in place and saves no rule.
// 2. Confirm moves the message and saves a Junk rule for that address.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/block-sender-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openBlockSender(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
}

test("cancel does not block the sender", async ({ page }) => {
  page.once("dialog", (dialog) => dialog.dismiss());
  await openBlockSender(page);
  await page.getByRole("menuitem", { name: "Block sender" }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  const rules = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.rules ?? [],
  );
  expect(rules).toEqual([]);
});

test("block sender moves the message and saves a Junk rule", async ({
  page,
}) => {
  page.once("dialog", (dialog) => dialog.accept());
  await openBlockSender(page);
  await page.getByRole("menuitem", { name: "Block sender" }).click();
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
      field: "from",
      action: "move_junk",
      contains: "jane@example.com",
      enabled: true,
    }),
  ]);
});
