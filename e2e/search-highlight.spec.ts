import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A plain search word is marked in the subject.
// 2. An operator such as is:unread is not marked as text.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/search-highlight.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("search marks the matching words in the message list", async ({
  page,
}) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("mailbox");
  await search.press("Enter");
  const row = page.getByRole("option", { name: /Current mailbox/i });
  await expect(row.locator("mark")).toHaveText("mailbox");

  await search.fill("Saturday");
  await search.press("Enter");
  await page.getByRole("option", { name: /Current mailbox/i }).click();
  await expect(
    page.frameLocator('iframe[title="Message content"]').locator("mark"),
  ).toHaveText("Saturday");

  await search.fill("is:unread");
  await search.press("Enter");
  await expect(page.locator(".message-list mark")).toHaveCount(0);
});
