import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The first previewable file offers the next one and not a previous one.
// 2. The last file can return to the previous one.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/preview-next-file.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a file preview opens the next and previous file", async ({ page }) => {
  await page.goto("/?previewable=1&filePair=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Preview: family.png" }).click();
  await expect(
    page.getByRole("dialog", { name: "Preview of family.png" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous file" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Next file" }).click();
  await expect(
    page.getByRole("dialog", { name: "Preview of notes.txt" }),
  ).toBeVisible();
  await expect(page.getByText("Bring the salad.")).toBeVisible();
  await page.getByRole("button", { name: "Previous file" }).click();
  await expect(
    page.getByRole("dialog", { name: "Preview of family.png" }),
  ).toBeVisible();
});
