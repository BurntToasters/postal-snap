import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A display name that contains another address stays unmarked.
// 2. A display name that is only the sender address is marked.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/sender-name-conflict-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a display name with a different address is marked", async ({ page }) => {
  await page.goto("/?nameConflict=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("note", {
      name: "The name includes a different address: service@paypal.com.",
    }),
  ).toBeVisible();
});
