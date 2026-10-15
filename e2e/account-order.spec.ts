import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Moving an account changes the settings list and then snaps back.
// 2. The account switcher keeps the old order after the move.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/account-order.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("moving an account changes the switcher order", async ({ page }) => {
  await page.goto("/?multiAccount=1");
  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  const switcher = page.getByRole("menu", { name: "Email accounts" });
  await expect(switcher.getByRole("menuitemradio").first()).toContainText(
    "Sam",
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await expect(
    page.getByRole("button", { name: "Move Sam up" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Move Work up" }).click();
  const managed = page.getByRole("button", { name: /^Manage / });
  await expect(managed.first()).toHaveAccessibleName("Manage Work");
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  await expect(
    page
      .getByRole("menu", { name: "Email accounts" })
      .getByRole("menuitemradio")
      .first(),
  ).toContainText("Work");
});
