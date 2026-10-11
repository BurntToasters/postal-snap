import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An open message shows its size beside the date before Details is opened.
// 2. A message of zero bytes still names that size.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/message-header-size-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openWeekend(page: import("@playwright/test").Page) {
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
}

test("an open message shows its size before details are opened", async ({
  page,
}) => {
  await page.goto("/");
  await openWeekend(page);
  await expect(page.getByRole("button", { name: "Details" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.locator(".message-header-size")).toHaveText("512 B");
});

test("a zero-byte message still names its size", async ({ page }) => {
  await page.goto("/?emptySize=1");
  await openWeekend(page);
  await expect(page.locator(".message-header-size")).toHaveText("0 B");
});
