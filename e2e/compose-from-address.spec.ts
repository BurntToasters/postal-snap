import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A new message starts from the account address until another is chosen.
// 2. The next new message starts from the address chosen last time.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-from-address.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a new message starts from the From address last chosen", async ({
  page,
}) => {
  await page.goto("/?fromAlias=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const from = page.getByRole("combobox", { name: "From address" });
  await expect(from).toHaveValue("sam@icloud.com");
  await from.selectOption("work@example.com");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __POSTAL_SNAP_TEST__?: {
              savedSettings?: Array<{
                lastFromAddresses?: Array<{ address?: string }>;
              }>;
            };
          }
        ).__POSTAL_SNAP_TEST__;
        return state?.savedSettings?.at(-1)?.lastFromAddresses?.[0]?.address;
      }),
    )
    .toBe("work@example.com");
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "From address" }),
  ).toHaveValue("work@example.com");
});
