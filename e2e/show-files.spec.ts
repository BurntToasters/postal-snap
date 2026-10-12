import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The header names the file count and moves focus to those files.
// 2. A picture inside the message does not offer that jump.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/show-files-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openWeekend(page: import("@playwright/test").Page) {
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
}

test("the header moves to the message files", async ({ page }) => {
  await page.goto("/?previewable=1&filePair=1");
  await openWeekend(page);
  await page.getByRole("button", { name: "Show 2 files" }).click();
  await expect(page.locator("#message-attachments")).toBeFocused();
  await expect(page.getByText("notes.txt")).toBeVisible();
});

test("a picture inside the message has no file jump", async ({ page }) => {
  await page.goto("/?inline=1");
  await openWeekend(page);
  await expect(
    page.getByRole("button", { name: /Show \d+ files/ }),
  ).toHaveCount(0);
});
