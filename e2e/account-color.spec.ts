import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Choosing a color leaves the account mark unchanged.
// 2. The new color is only shown inside Settings.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/account-color.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an account color shows in the account list", async ({ page }) => {
  await page.goto("/?multiAccount=1");
  await expect(
    page.locator(".account-switcher-trigger .account-avatar"),
  ).toHaveAttribute("data-color", "blue");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity" }).click();
  await page.getByRole("radio", { name: "Purple" }).click();
  await expect(page.getByRole("radio", { name: "Purple" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(
    page.locator(".account-switcher-trigger .account-avatar"),
  ).toHaveAttribute("data-color", "purple");
});
