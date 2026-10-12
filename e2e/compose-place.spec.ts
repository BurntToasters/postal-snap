import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Minimizing a long draft and opening it again returns to the top.
// 2. A draft you have not scrolled opens partway down.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-place.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a tucked draft keeps your place", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByRole("textbox", { name: "Message body" });
  await body.click();
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(0);
  await page.keyboard.insertText(
    Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join("\n"),
  );
  await body.evaluate((node) => {
    node.scrollTop = 640;
  });
  await expect
    .poll(() => body.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(400);
  await page
    .getByRole("button", { name: "Minimize draft", exact: true })
    .click();
  await page.getByRole("button", { name: /^Restore editor/ }).click();
  await expect(body).toBeVisible();
  await expect
    .poll(() => body.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(400);
});
