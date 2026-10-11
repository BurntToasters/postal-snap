import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A nested folder starts open.
// 2. Collapsing it hides the child and is saved.
// 3. The next launch keeps that folder closed until it is expanded.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/collapse-folder.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a nested folder stays closed", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  const nested = page.getByRole("button", {
    name: /^Projects \/ 2026, 1 unread/,
  });
  await expect(nested).toBeVisible();
  await expect(nested).toHaveAttribute("title", /^Projects \/ 2026, 1 unread/);
  await page.getByRole("button", { name: "Collapse Projects" }).click();
  await expect(
    page.getByRole("button", { name: /^Projects \/ 2026, 1 unread/ }),
  ).toHaveCount(0);
  const saved = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __POSTAL_SNAP_TEST__?: {
          savedSettings?: Array<{
            collapsedMailboxes?: Array<{
              accountId: string;
              mailboxId: number;
            }>;
          }>;
        };
      }
    ).__POSTAL_SNAP_TEST__;
    return state?.savedSettings?.at(-1)?.collapsedMailboxes;
  });
  expect(saved).toEqual([{ accountId: "account-1", mailboxId: 4 }]);
  await page.goto("/?nestedFolders=1&collapsedFolder=4");
  await expect(
    page.getByRole("button", { name: /^Projects \/ 2026, 1 unread/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Projects" }).click();
  await expect(
    page.getByRole("button", { name: /^Projects \/ 2026, 1 unread/ }),
  ).toBeVisible();
});
