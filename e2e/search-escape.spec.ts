import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Escape leaves a submitted search and shows the folder again.
// 2. Escape clears text that was not submitted, and the folder stays.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/search-escape-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function row(page: import("@playwright/test").Page, name: RegExp) {
  return page
    .getByRole("option", { name })
    .or(page.getByRole("treeitem", { name }));
}

test("escape leaves a search and shows the folder", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("weekend");
  await search.press("Enter");
  await expect(row(page, /Current mailbox/i)).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(row(page, /Weekend plans/i)).toBeVisible();
  await expect(row(page, /Current mailbox/i)).toHaveCount(0);
});

test("escape clears a search that was not submitted", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("library");
  await expect(row(page, /Weekend plans/i)).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(row(page, /Weekend plans/i)).toBeVisible();
});
