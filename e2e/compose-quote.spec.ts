import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Quote wraps the current paragraph.
// 2. Quote again removes that wrap.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/compose-quote-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openQuote(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Show formatting" }).click();
  await page.getByRole("button", { name: "More formatting" }).click();
  const body = page.getByRole("textbox", { name: "Message body" });
  await body.click();
  await body.pressSequentially("Bring the notes");
  return body;
}

test("quote wraps the paragraph", async ({ page }) => {
  await openQuote(page);
  await page.getByRole("button", { name: "Quote" }).click();
  await expect(page.locator(".composer-editor blockquote")).toHaveText(
    "Bring the notes",
  );
});

test("quote again removes the wrap", async ({ page }) => {
  await openQuote(page);
  await page.getByRole("button", { name: "Quote" }).click();
  await page.getByRole("button", { name: "Quote" }).click();
  await expect(page.locator(".composer-editor blockquote")).toHaveCount(0);
  await expect(page.locator(".composer-editor")).toContainText(
    "Bring the notes",
  );
});
