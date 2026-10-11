import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A named sender keeps the address on the row.
// 2. A sender whose name is the address does not repeat it.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/sender-address-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function row(page: import("@playwright/test").Page) {
  return page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
}

test("a named sender keeps the address on the row", async ({ page }) => {
  await page.goto("/");
  await expect(row(page)).toHaveAccessibleName(/jane@example.com/);
  await expect(page.locator(".message-row .message-sender")).toHaveAttribute(
    "title",
    "jane@example.com",
  );
});

test("a sender named with the address does not repeat it", async ({ page }) => {
  await page.goto("/?senderIsAddress=1");
  await expect(row(page)).toBeVisible();
  await expect(
    page.locator(".message-row .message-sender"),
  ).not.toHaveAttribute("title");
});
