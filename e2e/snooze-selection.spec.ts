import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Snooze selected hides the checked messages and leaves the others in the list.
// 2. The request names only those messages and a future time.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/snooze-selection-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("snooze selected hides the checked messages", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Older family note/i }).click();
  await expect(
    page.getByRole("checkbox", { name: /Library hours/i }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /Older family note/i }),
  ).toBeChecked();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Snooze selected", exact: true })
    .click();
  await page.getByRole("button", { name: "Tomorrow morning" }).click();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Library hours/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: /Older family note/i }),
  ).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: /selected/i })).toHaveCount(0);
  const snoozed = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "snooze_messages",
    ),
  );
  expect(snoozed?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [30, 9],
  });
  expect(snoozed?.args.untilIso).toEqual(expect.any(String));
});
