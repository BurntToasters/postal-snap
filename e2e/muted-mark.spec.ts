import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A muted conversation is labeled in the list and on the open message.
// 2. A conversation that is not muted leaves that label off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/muted-mark-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a muted conversation is labeled in the list and the message", async ({
  page,
}) => {
  await page.goto("/?conversationMuted=1");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await expect(row).toHaveAccessibleName(/Muted/);
  await expect(row.locator(".message-muted")).toHaveText("Muted");
  await row.click();
  await expect(page.locator(".message-header .message-muted")).toHaveText(
    "Muted",
  );
});

test("an ordinary conversation leaves the muted label off", async ({
  page,
}) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await expect(row.locator(".message-muted")).toHaveCount(0);
  await row.click();
  await expect(page.locator(".message-header .message-muted")).toHaveCount(0);
});
