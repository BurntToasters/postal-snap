import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The same person in To and Cc asks before the message goes out.
// 2. Review recipients returns to the address field.
// 3. Send anyway still sends both copies.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-duplicate-recipient.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a repeated recipient asks before the message sends", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("pat@example.com");
  await page.getByRole("button", { name: "Cc", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Cc", exact: true })
    .fill("Pat <pat@example.com>");
  await page.getByRole("textbox", { name: "Subject" }).fill("Hello");
  await page.getByLabel("Message body").pressSequentially("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "This person is listed more than once",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("pat@example.com")).toBeVisible();
  await dialog.getByRole("button", { name: "Review recipients" }).click();
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.getByRole("button", { name: "Send anyway" }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const sent = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.sentDraft as
        { to?: string[]; cc?: string[] } | undefined,
  );
  expect(sent?.to).toEqual(["pat@example.com"]);
  expect(sent?.cc).toEqual(["Pat <pat@example.com>"]);
});
