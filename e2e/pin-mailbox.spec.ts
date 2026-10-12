import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Folders start without a Pinned group.
// 2. Pin mailbox keeps that folder at the top and opens it from there.
// 3. Unpin mailbox removes the shortcut and leaves the folder in the list.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/pin-mailbox.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a mailbox can stay pinned at the top of the folder list", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("group", { name: "Pinned" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Inbox/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin mailbox" }).click();
  const pinned = page.getByRole("group", { name: "Pinned" });
  await expect(pinned.getByRole("button", { name: /^Inbox/ })).toBeVisible();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await pinned.getByRole("button", { name: /^Inbox/ }).click();
  await expect(pinned.getByRole("button", { name: /^Inbox/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const saved = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __POSTAL_SNAP_TEST__?: {
          savedSettings?: Array<{
            pinnedMailboxes?: Array<{ accountId: string; mailboxId: number }>;
          }>;
        };
      }
    ).__POSTAL_SNAP_TEST__;
    return state?.savedSettings?.at(-1)?.pinnedMailboxes;
  });
  expect(saved).toEqual([{ accountId: "account-1", mailboxId: 1 }]);
  await pinned
    .getByRole("button", { name: /^Inbox/ })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin mailbox" }).click();
  await expect(page.getByRole("group", { name: "Pinned" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Inbox/ })).toBeVisible();
});
