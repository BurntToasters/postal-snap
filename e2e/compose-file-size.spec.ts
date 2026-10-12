import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An attached file shows its size, and the composer shows the total.
// 2. A file with no known size stays unlabeled, and no total is invented.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/compose-file-size-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an attached file shows its size and the total", async ({ page }) => {
  await page.goto("/?pickFile=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  const files = page.locator(".compose-attachments");
  await expect(files).toContainText("budget.pdf");
  await expect(files).toContainText("4.0 KB");
  await expect(files).toContainText("Total size 4.0 KB");
});

test("a file with no known size does not invent a total", async ({ page }) => {
  await page.goto("/?pickFile=1&sizeMissing=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  const files = page.locator(".compose-attachments");
  await expect(files).toContainText("budget.pdf");
  await expect(files.locator(".compose-attachment-size")).toHaveCount(0);
  await expect(files.locator(".compose-attachment-total")).toHaveCount(0);
});
