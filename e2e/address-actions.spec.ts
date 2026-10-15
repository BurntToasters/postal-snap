import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. New message keeps the display name instead of the mailbox.
// 2. Messages to this address searches only the open mailbox.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/address-actions-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a new message is addressed to the person on the message", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.locator(".sender-primary-line").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "New message to this address" })
    .click();
  await expect(page.getByPlaceholder("name@example.com").first()).toHaveValue(
    "jane@example.com",
  );
});

test("messages to this address searches the whole account", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.locator(".sender-primary-line").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Messages to this address" })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search mail" }),
  ).toHaveValue('to:"jane@example.com"');
  await expect(
    page.getByRole("button", { name: "All folders" }),
  ).toHaveAttribute("aria-pressed", "true");
});
