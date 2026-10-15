import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The title uses the active account's Inbox unread count.
// 2. Another account's unread mail stays out of that title.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/window-title-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the window title shows the active Inbox unread count", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Inbox (1) — Postal Snap");
  await expect
    .poll(async () =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "set_unread_badge",
          args: expect.objectContaining({ count: 1 }),
        }),
      ]),
    );

  await page.goto("/?multiAccount=1");
  await expect(page).toHaveTitle("Sam (1) — Postal Snap");
  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  await page
    .getByRole("menu", { name: "Email accounts" })
    .getByRole("menuitemradio", { name: /Work/ })
    .click();
  await expect(page).toHaveTitle("Work (3) — Postal Snap");
  await expect
    .poll(async () =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "set_unread_badge",
          args: expect.objectContaining({ count: 3 }),
        }),
      ]),
    );
});
