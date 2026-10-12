import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The message list copies the sender address and leaves the message closed.
// 2. The open message copies that address before Details is opened.
// 3. A message with no sender address leaves the action out.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await installMockIpc(page);
});

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/copy-sender-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the message list copies the sender address and leaves it closed", async ({
  page,
}) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy sender address", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("jane@example.com");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
});

test("the open message copies the sender address", async ({ page }) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Copy sender address", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("jane@example.com");
});

test("a message with no sender address leaves that action out", async ({
  page,
}) => {
  await page.goto("/?blankSender=1");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy sender address", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row.click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Copy sender address", exact: true }),
  ).toHaveCount(0);
});
