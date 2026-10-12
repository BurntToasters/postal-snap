import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. r replies to the focused row and leaves that message closed.
// 2. The composer uses the sender and a Re: subject.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/reply-focused.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("r replies to the focused message without opening it", async ({
  page,
}) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("r");
  await expect(page.locator("#composer-subject")).toHaveValue(
    "Re: Weekend plans",
  );
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("jane@example.com");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});
