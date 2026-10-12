import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Low importance is off until it is chosen, and it replaces High importance.
// 2. A received low-importance message is named in the list and in the reader.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/low-importance-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a new message can be marked low importance", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const low = page.getByRole("checkbox", { name: "Low importance" });
  const high = page.getByRole("checkbox", { name: "High importance" });
  await expect(low).not.toBeChecked();
  await high.click();
  await low.click();
  await expect(high).not.toBeChecked();
  await expect(low).toBeChecked();
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("jane@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Whenever");
  await page.getByLabel("Message body").pressSequentially("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const marked = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.sentDraft as
        { importance?: string; subject?: string } | undefined,
  );
  expect(marked?.importance).toBe("low");
  expect(marked?.subject).toBe("Whenever");
});

test("a received low-importance message is labeled in the list and the reader", async ({
  page,
}) => {
  await page.goto("/?lowImportance=1");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toHaveAccessibleName(/Low importance/);
  await row.click();
  await expect(page.locator(".message-importance")).toHaveText(
    "Low importance",
  );
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});
