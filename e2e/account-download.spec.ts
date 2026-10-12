import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Changing how long one account keeps mail snaps back to 90 days.
// 2. Leaving the account page drops the new setting.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/account-download.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("one account can keep mail for a different length of time", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  const days = page.getByRole("combobox", { name: "Keep mail for" });
  await expect(days).toHaveValue("90");
  await days.selectOption("30");
  await expect(page.getByText("Download setting saved.")).toBeVisible();
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await page.getByRole("button", { name: "Connection", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Keep mail for" }),
  ).toHaveValue("30");
});
