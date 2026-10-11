import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An open message names its place among the loaded messages.
// 2. Next moves that place with the message.
// 3. A mailbox with one loaded message says 1 of 1.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/message-place-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an open message names its place in the loaded list", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect(page.locator(".reader-position")).toHaveText("1 of 3");
  await expect(page.locator(".reader-position")).toHaveAttribute(
    "aria-label",
    "Message 1 of 3",
  );
  await page.getByRole("button", { name: "Next message" }).click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await expect(page.locator(".reader-position")).toHaveText("2 of 3");
});

test("one loaded message is 1 of 1", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect(page.locator(".reader-position")).toHaveText("1 of 1");
});
