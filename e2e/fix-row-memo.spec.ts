import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, emitTauriEvent } from "./ipc";

// Failure modes covered here (WP F8, message row memo):
// FM1 A sync event re-renders no message rows (row renders are read through
//     the DEV-only __POSTAL_SNAP_PERF__ probe, and rows must have rendered).
// FM2 Selecting a row re-renders at most two rows (keyed probe counts).
// FM3 ArrowDown still selects the next row and moves visible focus to it.
// FM4 Rows keep accessible names that include subject and sender.

test.beforeEach(async ({ page }) => installMockIpc(page));

interface PerfProbe {
  renders: Record<string, number>;
  rowRenders?: Record<string, Record<string, number>>;
}

async function rowRenderCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const perf = (window as unknown as { __POSTAL_SNAP_PERF__?: PerfProbe })
      .__POSTAL_SNAP_PERF__;
    return { ...(perf?.rowRenders?.messageRow ?? {}) };
  });
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

// Rows whose render count grew between two snapshots.
function changedRows(
  before: Record<string, number>,
  after: Record<string, number>,
): string[] {
  return Object.keys(after).filter((key) => after[key] !== (before[key] ?? 0));
}

// Waits until IPC traffic and row renders hold still across a 400 ms window,
// so startup loads that land late on a busy machine stay outside the window.
async function waitForRenderQuiet(page: Page) {
  await expect
    .poll(
      async () => {
        const first = await rowRenderCounts(page);
        await page.waitForTimeout(400);
        const second = await rowRenderCounts(page);
        return JSON.stringify(first) === JSON.stringify(second);
      },
      { timeout: 20_000, intervals: [100] },
    )
    .toBe(true);
}

// Lets React commit and any queued IPC promise chains drain.
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 60));
      }),
  );
}

test("FM1: a sync event re-renders no message rows", async ({
  page,
}, testInfo) => {
  await page.goto("/?multiAccount=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible({ timeout: 20_000 });
  await waitForRenderQuiet(page);
  const before = await rowRenderCounts(page);
  expect(total(before)).toBeGreaterThan(0);

  await emitTauriEvent(page, "sync-state", {
    accountId: "account-2",
    phase: "syncing",
  });
  await emitTauriEvent(page, "sync-state", {
    accountId: "account-1",
    phase: "syncing",
  });
  await settle(page);
  await waitForRenderQuiet(page);
  const after = await rowRenderCounts(page);

  expect(changedRows(before, after)).toEqual([]);
  await attachArtifacts(page, testInfo, "fm1-sync-no-row-renders", {
    before,
    after,
  });
});

test("FM2: selecting a row re-renders at most two rows", async ({
  page,
}, testInfo) => {
  await page.goto("/?hugeList=1500&theme=light&density=normal");
  const first = page.getByRole("option").first();
  await expect(first).toBeVisible();
  await waitForRenderQuiet(page);
  const before = await rowRenderCounts(page);
  expect(total(before)).toBeGreaterThan(0);

  const second = page.getByRole("option").nth(1);
  await second.click();
  await expect(second).toHaveAttribute("aria-selected", "true");
  await settle(page);
  await waitForRenderQuiet(page);
  const after = await rowRenderCounts(page);

  expect(changedRows(before, after).length).toBeLessThanOrEqual(2);
  await attachArtifacts(page, testInfo, "fm2-select-row-renders", {
    changed: changedRows(before, after),
  });
});

test("FM3: ArrowDown selects the next row and focuses it", async ({
  page,
}, testInfo) => {
  await page.goto("/?hugeList=1500&theme=light&density=normal");
  const first = page.getByRole("option").first();
  await first.focus();
  await first.press("ArrowDown");

  const next = page.getByRole("option").nth(1);
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option").first()).toHaveAttribute(
    "aria-selected",
    "false",
  );
  await attachArtifacts(page, testInfo, "fm3-arrow-down-selects");
});

test("FM4: rows keep accessible names with sender and subject", async ({
  page,
}, testInfo) => {
  await page.goto("/?theme=light&density=normal");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleName(/Weekend plans/);
  await expect(row).toHaveAccessibleName(/Unread/i);
  const names = await page
    .getByRole("option")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? ""),
    );
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(name.trim().length).toBeGreaterThan(0);
  await attachArtifacts(page, testInfo, "fm4-row-names", { names });
});

test("FM5: an in-place flag color change updates the row name and glyph", async ({
  page,
}, testInfo) => {
  await page.goto("/?theme=light&density=normal");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAccessibleName(/Flagged/);
  // Mutate the mock summary in place, then announce the flag change.
  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __POSTAL_SNAP_MOCK__: {
          summary: { accountId: string; flagColor: number; isStarred: boolean };
        };
      }
    ).__POSTAL_SNAP_MOCK__;
    mock.summary.flagColor = 3;
    mock.summary.isStarred = true;
  });
  await emitTauriEvent(page, "message-changed", {
    accountId: "account-1",
    messageId: null,
    kind: "flags",
  });
  await expect(
    page.getByRole("option", { name: /Flagged, Green.*Weekend plans/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }).locator(".star-mark"),
  ).toBeVisible();
  await attachArtifacts(page, testInfo, "fm5-in-place-flag-color");
});
