import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The action searches only the open mailbox.
// 2. The query is the display name, or it drops the address.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/messages-from-sender.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("messages from this sender searches the whole account", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Messages from this sender" })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search mail" }),
  ).toHaveValue('from:"jane@example.com"');
  await expect(
    page.getByRole("button", { name: "All folders" }),
  ).toHaveAttribute("aria-pressed", "true");
});
