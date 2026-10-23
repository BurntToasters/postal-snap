import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Copy recipients writes the message body.
// 2. A Cc address is left out.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function readClipboardText(page: import("@playwright/test").Page) {
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(
    /\r\n/g,
    "\n",
  );
}

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/copy-recipients-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the open message can copy its recipients", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?fromSelf=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Copy recipients", exact: true })
    .click();
  await expect
    .poll(() => readClipboardText(page))
    .toBe("jane@example.com\nlee@example.com\nsam@icloud.com");
});
