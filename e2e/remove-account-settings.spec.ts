import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A removed account's pinned folders stay in saved settings, so a later
//    full save writes them back after Rust pruned them.
// 2. Pruning also drops another account's pins.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/remove-account-settings.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("removing an account drops only its saved folder pins", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&pinnedBoth=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".account-settings-card")
    .first()
    .getByRole("button", { name: "Remove" })
    .click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const saved = (
          window as unknown as {
            __POSTAL_SNAP_TEST__: {
              savedSettings: { pinnedMailboxes?: { accountId: string }[] }[];
            };
          }
        ).__POSTAL_SNAP_TEST__.savedSettings;
        return saved.at(-1)?.pinnedMailboxes ?? null;
      }),
    )
    .toEqual([{ accountId: "account-2", mailboxId: 9 }]);
});
