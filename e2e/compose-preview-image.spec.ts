import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An attached picture can be previewed and stays attached after closing.
// 2. A file that is not a picture has no preview.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/compose-preview-image-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an attached picture can be previewed", async ({ page }) => {
  await page.goto("/?pickImage=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await page.getByRole("button", { name: "Preview family-photo.jpg" }).click();
  const dialog = page.getByRole("dialog", { name: "family-photo.jpg" });
  await expect(
    dialog.getByRole("img", { name: "family-photo.jpg" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".compose-attachments")).toContainText(
    "family-photo.jpg",
  );
});

test("a file that is not a picture has no preview", async ({ page }) => {
  await page.goto("/?pickFile=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.locator(".compose-attachments")).toContainText(
    "budget.pdf",
  );
  await expect(page.getByRole("button", { name: /Preview / })).toHaveCount(0);
});
