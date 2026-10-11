import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A new message does not request a receipt until the option is checked.
// 2. The sent draft carries that request.
// 3. A received request shows who would be notified, and Don't send clears it.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/read-receipt-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a new message can request a read receipt", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const box = page.getByRole("checkbox", { name: "Request a read receipt" });
  await expect(box).not.toBeChecked();
  await box.click();
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("jane@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Tonight");
  await page.getByLabel("Message body").pressSequentially("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const draft = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.sentDraft as
        { requestReceipt?: boolean; subject?: string } | undefined,
  );
  expect(draft?.requestReceipt).toBe(true);
  expect(draft?.subject).toBe("Tonight");
});

test("a received read receipt request can be declined", async ({ page }) => {
  await page.goto("/?readReceipt=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByText(/A receipt would go to jane@example.com/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Don't send" }).click();
  await expect(
    page.getByText(/A receipt would go to jane@example.com/),
  ).toHaveCount(0);
  const declined = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.some(
        (call) => call.command === "decline_read_receipt",
      ) ?? false,
  );
  expect(declined).toBe(true);
});
