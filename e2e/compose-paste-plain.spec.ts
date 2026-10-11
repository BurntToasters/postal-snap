import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Pasted tags become formatted HTML.
// 2. Line breaks in the clipboard are dropped.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-paste-plain.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("paste without formatting keeps tags as text", async ({ page }) => {
  await page.goto("/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.evaluate(() =>
    navigator.clipboard.writeText("Hello\n<b>there</b>"),
  );
  await page
    .getByRole("textbox", { name: "Message body" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Paste without formatting" })
    .click();
  const body = page.locator(".composer-editor");
  await expect(body).toContainText("Hello");
  await expect(body).toContainText("<b>there</b>");
  await expect(body.locator("b")).toHaveCount(0);
});
