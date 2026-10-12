import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Inbox cannot leave the folder list.
// 2. A hidden folder leaves the main list and stays under Hidden.
// 3. Show mailbox puts it back.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/hide-mailbox.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a mailbox can leave the folder list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("group", { name: "Hidden" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Inbox/ }).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Hide mailbox" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Archive", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide mailbox" }).click();
  const hidden = page.getByRole("group", { name: "Hidden" });
  await expect(
    hidden.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".folder-tree, .folder-list").getByRole("button", {
      name: "Archive",
      exact: true,
    }),
  ).toHaveCount(1);
  const saved = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __POSTAL_SNAP_TEST__?: {
          savedSettings?: Array<{
            hiddenMailboxes?: Array<{ accountId: string; mailboxId: number }>;
          }>;
        };
      }
    ).__POSTAL_SNAP_TEST__;
    return state?.savedSettings?.at(-1)?.hiddenMailboxes;
  });
  expect(saved).toEqual([{ accountId: "account-1", mailboxId: 2 }]);
  await hidden
    .getByRole("button", { name: "Archive", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show mailbox" }).click();
  await expect(page.getByRole("group", { name: "Hidden" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();
});
