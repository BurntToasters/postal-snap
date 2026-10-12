import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A mailbox search with no matches offers to search the whole account.
// 2. That search finds the message that was outside the open mailbox.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/search-all-mailboxes.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an empty mailbox search can search all mailboxes", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("elsewhere");
  await search.press("Enter");
  await expect(page.getByText(/No messages matching/)).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Across account/i }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Search all mailboxes" }).click();
  await expect(
    page.getByRole("option", { name: /Across account/i }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Search all mailboxes" }),
  ).toHaveCount(0);
});
