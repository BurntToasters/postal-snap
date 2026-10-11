import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Turning previews off still leaves the subject on the row.
// 2. The first line stays visible when the setting is left on.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/message-previews-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("message rows can hide the first line and still show the subject", async ({
  page,
}) => {
  await page.goto("/?showPreviews=0");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("Are we still meeting on Saturday?");

  await page.goto("/");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toContainText("Are we still meeting on Saturday?");
});
