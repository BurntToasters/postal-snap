import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A search result can return to its folder before Details is opened.
// 2. A message already in the open folder does not offer that jump.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/show-in-folder-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a search result can return to its folder from the header", async ({
  page,
}) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("weekend");
  await search.press("Enter");
  const row = page
    .getByRole("option", { name: /Current mailbox/i })
    .or(page.getByRole("treeitem", { name: /Current mailbox/i }));
  await row.click();
  await expect(page.getByRole("button", { name: "Details" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("button", { name: "Show in Inbox" }).click();
  await expect(search).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});

test("a message in the open folder has no folder jump", async ({ page }) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  await expect(page.getByRole("button", { name: /Show in / })).toHaveCount(0);
});
