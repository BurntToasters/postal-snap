import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Several files are named by count and hide their combined size.
// 2. One file hides its size on the jump to those files.
// 3. A picture inside the letter is counted as a file.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/message-file-size.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openWeekend(page: import("@playwright/test").Page) {
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
}

test("the letter names the combined size of its files", async ({ page }) => {
  await page.goto("/?previewable=1&filePair=1");
  await openWeekend(page);
  await expect(
    page.getByRole("button", { name: "Show 2 files" }),
  ).toContainText("192 B");
  await expect(
    page.getByRole("heading", { name: "Attachments" }),
  ).toContainText("192 B");
});

test("one file names its size on the jump", async ({ page }) => {
  await page.goto("/?previewable=1");
  await openWeekend(page);
  await expect(page.getByRole("button", { name: "Show 1 file" })).toContainText(
    "128 B",
  );
});

test("a picture inside the letter is not added to the file size", async ({
  page,
}) => {
  await page.goto("/?inline=1");
  await openWeekend(page);
  await expect(
    page.getByRole("button", { name: /Show \d+ files?/ }),
  ).toHaveCount(0);
});
