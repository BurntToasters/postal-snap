import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A reply starts in the letter when someone is already addressed.
// 2. A new message starts in To.
// 3. A forward starts in To because that field is empty.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/compose-focus-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openMessage(page: import("@playwright/test").Page) {
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
}

test("a reply starts in the letter", async ({ page }) => {
  await page.goto("/");
  await openMessage(page);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message body" }),
  ).toBeFocused();
});

test("a new message starts in To", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "To" })).toBeFocused();
});

test("a forward starts in To", async ({ page }) => {
  await page.goto("/");
  await openMessage(page);
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "To" })).toBeFocused();
});
