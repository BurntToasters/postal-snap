import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Save selected messages stays unavailable until a message is checked.
// 2. The save includes every checked message, including one with no files.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/save-selection-messages-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("save selected messages stays disabled until a message is checked", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", {
      name: "Save selected messages",
      exact: true,
    }),
  ).toBeDisabled();
});

test("save selected messages includes every checked message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Older family note/i }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Save selected messages", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(
    page.locator('.message-select[aria-label="Select Library hours"]'),
  ).toBeChecked();
  await expect(
    page.locator('.message-select[aria-label="Select Older family note"]'),
  ).toBeChecked();
  await expect(
    page.getByRole("toolbar", { name: /2 selected/i }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "save_messages_eml",
    ),
  );
  expect(saved?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [30, 9],
  });
});
