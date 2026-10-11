import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Reply writes only to the sender until the preference is on.
// 2. With the preference on, Reply includes the other recipients.
// 3. Reply in the menu still writes to the sender.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/reply-to-all-pref.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("Reply can include everyone addressed on the message", async ({
  page,
}) => {
  await page.goto("/?groupReply=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("jane@example.com");
  await expect(
    page.getByRole("combobox", { name: "Cc", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading & Sending" }).click();
  const preference = page.getByRole("checkbox", { name: /Reply to everyone/ });
  await expect(preference).not.toBeChecked();
  await preference.click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("jane@example.com");
  await expect(
    page.getByRole("combobox", { name: "Cc", exact: true }),
  ).toHaveValue("lee@example.com, pat@example.com");
});
