import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A new link has no remove action.
// 2. Opening that link again can remove it and leave the words.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-remove-link.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an existing link can be removed and the words stay", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByLabel("Message body");
  await body.pressSequentially("Library hours");
  await body.press("Meta+a");
  await page.getByRole("button", { name: "Show formatting" }).click();
  const more = page.getByRole("button", { name: "More formatting" });
  await more.click();
  await page.getByRole("button", { name: "Insert link" }).click();
  const dialog = page.getByRole("dialog", { name: "Insert link" });
  await expect(dialog.getByRole("button", { name: "Remove link" })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("textbox", { name: "Web address" })
    .fill("https://library.example.test/hours");
  await dialog.getByRole("button", { name: "Insert link" }).click();
  await expect(page.locator(".composer-editor a")).toHaveAttribute(
    "data-external-href",
    "https://library.example.test/hours",
  );

  await body.press("Meta+a");
  if ((await more.getAttribute("aria-expanded")) !== "true") {
    await more.click();
  }
  await page.getByRole("button", { name: "Insert link" }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Web address" }),
  ).toHaveValue("https://library.example.test/hours");
  await dialog.getByRole("button", { name: "Remove link" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".composer-editor")).toContainText("Library hours");
  await expect(page.locator(".composer-editor a")).toHaveCount(0);
});
