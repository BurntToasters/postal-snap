import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Sending to noreply asks before the message goes out.
// 2. Review recipients returns to the address field.
// 3. Send anyway still sends the letter.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-noreply.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message to an automated address asks before it sends", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("noreply@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Hello");
  await page.getByLabel("Message body").pressSequentially("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "This address may not accept mail",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("noreply@example.com")).toBeVisible();
  await dialog.getByRole("button", { name: "Review recipients" }).click();
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.getByRole("button", { name: "Send anyway" }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const sent = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.sentDraft as { to?: string[] } | undefined,
  );
  expect(sent?.to).toEqual(["noreply@example.com"]);
});
