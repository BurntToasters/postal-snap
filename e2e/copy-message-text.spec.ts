import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Copying from the list leaves the message closed.
// 2. Copying from the open message uses the readable letter, not the HTML tags.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await installMockIpc(page);
});

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/copy-message-text-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the message list copies the letter and leaves it closed", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy message text" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Are we still meeting on Saturday?");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
});

test("the open message copies its readable text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Copy message text" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Are we still meeting on Saturday?");
  expect(
    await page.evaluate(() => navigator.clipboard.readText()),
  ).not.toContain("<p>");
});
