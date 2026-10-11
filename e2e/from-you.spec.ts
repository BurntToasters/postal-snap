import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Mail you sent into this folder is named You, with your address still available.
// 2. Mail from someone else keeps their name.
// 3. The Sent folder still names who you wrote to.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/from-you-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function row(page: import("@playwright/test").Page, name: RegExp) {
  return page
    .getByRole("option", { name })
    .or(page.getByRole("treeitem", { name }));
}

test("mail you sent is named You", async ({ page }) => {
  await page.goto("/?fromSelf=1");
  await expect(page.locator(".message-row .message-sender")).toHaveText("You");
  await expect(page.locator(".message-row .message-sender")).toHaveAttribute(
    "title",
    "sam@icloud.com",
  );
  await expect(row(page, /Weekend plans/i)).toHaveAccessibleName(/You/);
});

test("mail from someone else keeps their name", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row .message-sender")).toHaveText("Jane");
});

test("Sent still names the recipients", async ({ page }) => {
  await page.goto("/?sentRow=1");
  await expect(page.locator(".message-row .message-sender")).toHaveText(
    "To jane@example.com, lee@example.com",
  );
});
