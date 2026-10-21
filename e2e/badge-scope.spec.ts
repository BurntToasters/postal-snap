import AxeBuilder from "@axe-core/playwright";
import type { TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The default badge leaves other accounts and non-Inbox folders out.
// 2. All-Inboxes sums only account Inbox counts while the title stays active.
// 3. Saved scope survives reopen and remains findable through Settings search.
// 4. A delayed count cannot restore a removed account's badge.

const variants = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

async function lastBadgeCount(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const calls = window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [];
    const badge = calls
      .filter((call) => call.command === "set_unread_badge")
      .at(-1);
    return badge ? Number(badge.args.count) : null;
  });
}

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await attachArtifacts(page, testInfo, `w21-badge-${slug}`);
});

for (const { density, scale } of variants) {
  test(`badge preference fits ${density} at ${scale * 100}% text`, async ({
    page,
  }) => {
    await page.goto(`/?density=${density}&scale=${scale}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();

    const scope = page.getByRole("combobox", { name: "Unread badge" });
    await expect(scope).toHaveValue("activeInbox");
    const scan = await new AxeBuilder({ page })
      .include(".settings-window")
      .analyze();
    expect(
      scan.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
}

test("badge scope saves, searches, and keeps the title on the active Inbox", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&badgeCounts=1,3");
  await expect.poll(() => lastBadgeCount(page)).toBe(1);
  await expect(page).toHaveTitle("Sam (1) — Postal Snap");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  const scope = page.getByRole("combobox", { name: "Unread badge" });
  await expect(scope).toHaveValue("activeInbox");
  await scope.selectOption("allInboxes");
  await expect.poll(() => lastBadgeCount(page)).toBe(4);
  await expect(page).toHaveTitle("Sam (1) — Postal Snap");

  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__POSTAL_SNAP_TEST__?.savedSettings.some(
          (settings) =>
            (settings as { badgeScope?: string }).badgeScope === "allInboxes",
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("badge");
  await page.getByRole("button", { name: /Unread badge/ }).click();
  await expect(
    page.getByRole("combobox", { name: "Unread badge" }),
  ).toHaveValue("allInboxes");
});

test("a delayed count cannot restore a removed account badge", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&badgeScope=allInboxes&delayBadgeCounts=1");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__POSTAL_SNAP_TEST__ as
          | (typeof window.__POSTAL_SNAP_TEST__ & {
              pendingBadgeCounts?: number;
            })
          | undefined;
        return state?.pendingBadgeCounts ?? 0;
      }),
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .locator(".account-settings-card")
    .first()
    .getByRole("button", { name: "Remove" })
    .click();

  await expect
    .poll(() =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.accountRemoved ?? false),
    )
    .toBe(true);
  await expect.poll(() => lastBadgeCount(page)).toBe(0);
  await page.evaluate(() => {
    const state = window.__POSTAL_SNAP_TEST__ as
      | (typeof window.__POSTAL_SNAP_TEST__ & {
          releaseDelayedBadgeCounts?: () => void;
        })
      | undefined;
    state?.releaseDelayedBadgeCounts?.();
  });
  await expect.poll(() => lastBadgeCount(page)).toBe(0);
});
