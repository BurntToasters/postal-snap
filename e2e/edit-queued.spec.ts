import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A waiting message opens in the composer without a delivery warning.
// 2. A message whose delivery could not be confirmed stays in Outbox when the warning is dismissed.
// 3. Accepting that warning opens the message for editing.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/edit-queued-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a waiting message opens for editing", async ({ page }) => {
  await page.goto("/?localMail=1&queued=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Waiting to send")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#composer-subject")).toHaveValue("Queued");
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("sam@example.test");
});

test("an unconfirmed send stays until the warning is accepted", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Could not confirm")).toBeVisible();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("may deliver another copy");
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByText("Could not confirm")).toBeVisible();
  await expect(page.locator("#composer-subject")).toHaveCount(0);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("may deliver another copy");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#composer-subject")).toHaveValue("Queued");
});
