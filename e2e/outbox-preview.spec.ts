import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A queued message with a first line shows that line in Outbox.
// 2. A queued message with no written line leaves that space blank.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/outbox-preview-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("Outbox shows the first line of a queued message", async ({ page }) => {
  await page.goto("/?localMail=1&outboxPreview=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Could not confirm")).toBeVisible();
  await expect(page.getByText("Please review the notes.")).toBeVisible();
});

test("a queued message with no written line leaves that space blank", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Could not confirm")).toBeVisible();
  await expect(page.getByText("Please review the notes.")).toHaveCount(0);
});
