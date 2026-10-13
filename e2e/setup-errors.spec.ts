import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A specific setup error collapses to "could not finish… Try again".
// 2. The user is told to retry an action that can never succeed.
// The run ends with a screenshot of the setup error.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/setup-errors.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a duplicate account says it is already set up", async ({ page }) => {
  await page.goto("/?firstRun=1&setupDuplicate=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@icloud.com");
  await page.getByLabel("App-specific password").fill("app-password");
  await page.getByRole("button", { name: "Connect securely" }).click();
  await expect(
    page.getByText("An account with this email address is already set up."),
  ).toBeVisible();
  await expect(
    page.getByText("Postal Snap could not finish that action"),
  ).toHaveCount(0);
});
