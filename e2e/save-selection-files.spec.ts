import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Save selected files stays unavailable until a checked message has a file.
// 2. The save includes the checked messages that have a file and leaves the list in place.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/save-selection-files-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("save selected files stays disabled until a message with a file is checked", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Save selected files", exact: true }),
  ).toBeDisabled();
});

test("save selected files includes the checked messages", async ({ page }) => {
  await page.goto("/?threadGap=1&threadMarks=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Older family note/i }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Save selected files", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select Library hours" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select Older family note" }),
  ).toBeChecked();
  await expect(
    page.getByRole("toolbar", { name: /2 selected/i }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "save_conversation_attachments",
    ),
  );
  expect(saved?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [9],
  });
});
