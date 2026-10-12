import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A letter with no text sends immediately.
// 2. Writing a message is not focused, or Send anyway never sends.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-empty-message.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message with no text asks before it sends", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("jane@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Send without a message?",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Write a message" }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "Write a message" }).click();
  await expect(page.getByLabel("Message body")).toBeFocused();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.getByRole("button", { name: "Send anyway" }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const sent = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.sentDraft as
        { to?: string[]; subject?: string } | undefined,
  );
  expect(sent?.to).toEqual(["jane@example.com"]);
  expect(sent?.subject).toBe("Hello");
});
