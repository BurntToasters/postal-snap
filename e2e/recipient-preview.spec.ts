import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A long To line lists every address and runs off the letter.
// 2. A short To line hides an address behind "others".
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/recipient-preview.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openWeekend(page: import("@playwright/test").Page) {
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
}

test("a long To line names the first people and how many more", async ({
  page,
}) => {
  await page.goto("/?manyTo=1");
  await openWeekend(page);
  const to = page.locator(".recipient-preview").first();
  await expect(to).toContainText(
    "jane@example.com, lee@example.com, and 2 others",
  );
  await expect(to).toHaveAttribute(
    "title",
    "jane@example.com, lee@example.com, pat@example.com, sam@icloud.com",
  );
});

test("a short To line lists each address", async ({ page }) => {
  await page.goto("/");
  await openWeekend(page);
  const to = page.locator(".recipient-preview").first();
  await expect(to).toHaveText("sam@icloud.com");
  await expect(to).toHaveAttribute("title", "sam@icloud.com");
});
