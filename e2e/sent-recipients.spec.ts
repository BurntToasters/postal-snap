import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A Sent row still names the account owner.
// 2. Extra recipients are dropped from the row name.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/sent-recipients.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a Sent row names the people the message was written to", async ({
  page,
}) => {
  await page.goto("/?sentRow=1");
  await page.getByRole("button", { name: "Sent", exact: true }).click();
  const row = page.getByRole("option", { name: /Sent note/ });
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleName(
    /To jane@example.com, lee@example.com/,
  );
  await expect(row.locator(".message-sender")).toHaveText(
    "To jane@example.com, lee@example.com",
  );
});
