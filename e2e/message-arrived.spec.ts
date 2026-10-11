import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message that reached the server hours after its date shows Arrived.
// 2. A message whose arrival matches its date does not.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/message-arrived-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a late arrival shows when the server received the message", async ({
  page,
}) => {
  await page.goto("/?arrived=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("Arrived:", { exact: true })).toBeVisible();
});

test("an arrival close to the date stays on the date row", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("Arrived:", { exact: true })).toHaveCount(0);
});
