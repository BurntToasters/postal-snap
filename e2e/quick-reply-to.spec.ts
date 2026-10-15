import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A short reply names the sender.
// 2. A Reply-To address is named instead of the sender.
// 3. Reply all names the other people too.
// 4. A message with no sender address leaves the line off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/quick-reply-to-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openMessage(page: import("@playwright/test").Page) {
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await page.getByRole("textbox", { name: "Write a reply" }).focus();
}

test("a short reply names the sender", async ({ page }) => {
  await page.goto("/");
  await openMessage(page);
  await expect(page.locator(".quick-reply-to")).toBeVisible();
  await expect(page.locator(".quick-reply-to")).toHaveText("To Jane");
});

test("a short reply names a different reply address", async ({ page }) => {
  await page.goto("/?replyTo=1");
  await openMessage(page);
  await expect(page.locator(".quick-reply-to")).toHaveText(
    "To replies@example.com",
  );
});

test("reply all names everyone the reply will include", async ({ page }) => {
  await page.goto("/?groupReply=1&replyAllPref=1");
  await openMessage(page);
  await expect(page.locator(".quick-reply-to")).toHaveText(
    "To Jane, lee@example.com, pat@example.com",
  );
});

test("a message with no sender address leaves that line off", async ({
  page,
}) => {
  await page.goto("/?blankSender=1");
  await openMessage(page);
  await expect(page.locator(".quick-reply")).toBeVisible();
  await expect(page.locator(".quick-reply-to")).toHaveCount(0);
});
