import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, attachIpcLog, ipcCalls } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// 1. Choosing a color leaves the account mark unchanged.
// 2. The new color is only shown inside Settings.
// 3. Clearing the color leaves the mark on the default accent.
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
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
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

test("clearing an account color returns the mark to the default", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  await page.getByRole("button", { name: "Identity" }).click();
  await page.getByRole("radio", { name: "Purple" }).click();
  const clear = page.getByRole("button", { name: "Use default color" });
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(clear).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Purple" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(
    page.locator(".account-switcher-trigger .account-avatar"),
  ).not.toHaveAttribute("data-color");
  const calls = await ipcCalls(page);
  const clearCalls = calls.filter(
    (call) => call.command === "update_account_color",
  );
  expect(clearCalls.at(-1)?.args).toMatchObject({ color: null });
  await attachIpcLog(page, testInfo, "clear-color");
});
