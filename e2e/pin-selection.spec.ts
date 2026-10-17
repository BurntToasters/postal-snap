import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Pin selected is unavailable until a message is checked.
// 2. Pin selected moves the checked messages under Pinned and leaves the rest.
// 3. Unpin selected clears those pins.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/pin-selection-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("pin selected stays disabled until a message is checked", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Pin selected", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Unpin selected", exact: true }),
  ).toBeDisabled();
});

test("pin selected keeps the checked messages at the top", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Older family note/i }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Pin selected", exact: true })
    .click();
  await expect(page.locator(".list-day", { hasText: "Pinned" })).toBeVisible();
  await expect(page.getByRole("option").first()).toHaveAccessibleName(
    /Pinned[\s\S]*Library hours/,
  );
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  const pinned = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) =>
        call.command === "set_messages_pinned" && call.args.pinned === true,
    ),
  );
  expect(pinned?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [30, 9],
    pinned: true,
  });

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Unpin selected", exact: true })
    .click();
  await expect(page.locator(".list-day", { hasText: "Pinned" })).toHaveCount(0);
  await expect(page.getByRole("option").first()).toHaveAccessibleName(
    /Weekend plans/,
  );
  const unpinned = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) =>
        call.command === "set_messages_pinned" && call.args.pinned === false,
    ),
  );
  expect(unpinned?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [30, 9],
    pinned: false,
  });
});
