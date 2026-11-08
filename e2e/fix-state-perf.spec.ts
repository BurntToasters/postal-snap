import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, emitTauriEvent, ipcCalls, ipcCommands } from "./ipc";

// Failure modes covered here (WP F4, state and perf):
// FM1 A sync event for account B re-renders neither the mailbox shell nor
//     account A's message list.
// FM2 An account added while "Get mail for all accounts" runs is refreshed
//     afterwards (sync_account for its id appears in the IPC log).
// FM3 Opening an unread row refreshes folder counts only: no drafts, outbox
//     or snoozed list calls and at most one list_mailboxes.
// FM4 Removing an account clears its remembered list scroll position (read
//     through the DEV-only __POSTAL_SNAP_PERF__ probe).
// FM5 Appending a page that overlaps the loaded rows adds no duplicate rows.

test.beforeEach(async ({ page }) => installMockIpc(page));

interface PerfProbe {
  renders: Record<string, number>;
  sessionKeys: () => Record<string, string[]>;
}

async function renderCounts(page: Page) {
  return page.evaluate(() => {
    const perf = (window as unknown as { __POSTAL_SNAP_PERF__?: PerfProbe })
      .__POSTAL_SNAP_PERF__;
    return {
      probe: perf !== undefined,
      mailShell: perf?.renders.mailShell ?? 0,
      messageList: perf?.renders.messageList ?? 0,
    };
  });
}

async function sessionKeys(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const perf = (window as unknown as { __POSTAL_SNAP_PERF__?: PerfProbe })
      .__POSTAL_SNAP_PERF__;
    return perf?.sessionKeys() ?? {};
  });
}

// Waits until renders and IPC calls both hold still across a 400 ms window,
// so startup loads that land late on a busy machine stay outside the
// measured window.
async function waitForRenderQuiet(page: Page) {
  await expect
    .poll(
      async () => {
        const first = await renderCounts(page);
        const firstIpc = (await ipcCalls(page)).length;
        await page.waitForTimeout(400);
        const second = await renderCounts(page);
        const secondIpc = (await ipcCalls(page)).length;
        return (
          first.mailShell === second.mailShell &&
          first.messageList === second.messageList &&
          firstIpc === secondIpc
        );
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

test("FM1: a sync event for account B re-renders neither the shell nor account A's list", async ({
  page,
}, testInfo) => {
  await page.goto("/?multiAccount=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible({ timeout: 20_000 });
  await waitForRenderQuiet(page);
  const before = await renderCounts(page);
  expect(before.probe).toBe(true);

  await emitTauriEvent(page, "sync-state", {
    accountId: "account-2",
    phase: "syncing",
  });
  await settle(page);
  await waitForRenderQuiet(page);
  const after = await renderCounts(page);

  expect(after.messageList - before.messageList).toBe(0);
  expect(after.mailShell - before.mailShell).toBe(0);
  await attachArtifacts(page, testInfo, "fm1-sync-b-renders", {
    before,
    after,
  });
});

test("FM2: an account added during Get mail for all accounts is refreshed", async ({
  page,
}, testInfo) => {
  // Holds sync_all_accounts open and adds account-3 while it waits.
  await page.addInitScript(() => {
    const mock = (
      window as unknown as {
        __POSTAL_SNAP_MOCK__: {
          accounts: Array<Record<string, unknown>>;
          handlers: Record<string, (args: Record<string, unknown>) => unknown>;
        };
      }
    ).__POSTAL_SNAP_MOCK__;
    const original = mock.handlers.sync_all_accounts;
    mock.handlers.sync_all_accounts = async (args) => {
      const ids = (await original(args)) as string[];
      mock.accounts.push({
        id: "account-3",
        provider: "manual",
        email: "added@example.com",
        displayName: "Added",
        syncState: "idle",
        error: null,
      });
      await new Promise<void>((resolve) => {
        (window as unknown as { __releaseSync: () => void }).__releaseSync =
          resolve;
      });
      return [...ids, "account-3"];
    };
  });
  await page.goto("/?multiAccount=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  const switcher = page.getByRole("menu", { name: "Email accounts" });
  await switcher
    .getByRole("menuitem", { name: "Get mail for all accounts" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as unknown as { __releaseSync?: unknown })
            .__releaseSync,
      ),
    )
    .toBe("function");

  // The app learns of the new account through its offline/auth reconcile.
  const listsBefore = (await ipcCommands(page)).filter(
    (command) => command === "list_accounts",
  ).length;
  await emitTauriEvent(page, "sync-state", {
    accountId: "account-3",
    phase: "offline",
  });
  await expect
    .poll(
      async () =>
        (await ipcCommands(page)).filter(
          (command) => command === "list_accounts",
        ).length,
    )
    .toBeGreaterThan(listsBefore);
  await settle(page);

  await page.evaluate(() =>
    (window as unknown as { __releaseSync: () => void }).__releaseSync(),
  );
  await expect
    .poll(async () =>
      (await ipcCalls(page)).some(
        (call) =>
          call.command === "sync_account" &&
          (call.args as { accountId?: string }).accountId === "account-3",
      ),
    )
    .toBe(true);
  await attachArtifacts(page, testInfo, "fm2-added-account-refreshed");
});

test("FM3: opening an unread row refreshes folder counts only", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toHaveAccessibleName(/Unread/i);
  await settle(page);
  const start = (await ipcCommands(page)).length;

  await row.click();
  await expect
    .poll(async () =>
      (await ipcCommands(page)).slice(start).includes("list_mailboxes"),
    )
    .toBe(true);
  await settle(page);

  const after = (await ipcCommands(page)).slice(start);
  expect(after).toContain("set_message_flags");
  expect(
    after.filter((command) => command === "list_mailboxes").length,
  ).toBeLessThanOrEqual(1);
  for (const command of ["list_drafts", "list_outbox", "list_snoozed"]) {
    expect(after.filter((item) => item === command)).toEqual([]);
  }
  await attachArtifacts(page, testInfo, "fm3-mark-read-counts-only", {
    afterMarkRead: after,
  });
});

test("FM4: removing an account clears its remembered list scroll", async ({
  page,
}, testInfo) => {
  await page.goto("/?multiAccount=1&hugeList=1500");
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.getByRole("option").first().click();
  await page.locator(".message-list").evaluate((node) => {
    node.scrollTop = 600;
  });
  await settle(page);
  const remembered = await sessionKeys(page);
  expect(
    remembered.listScroll?.some((key) => key.startsWith("account-1:")),
  ).toBe(true);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .locator(".account-settings-card")
    .first()
    .getByRole("button", { name: "Remove" })
    .click();
  await expect
    .poll(async () => (await ipcCommands(page)).includes("remove_account"))
    .toBe(true);
  await settle(page);

  const after = await sessionKeys(page);
  expect(
    (after.listScroll ?? []).filter((key) => key.startsWith("account-1:")),
  ).toEqual([]);
  await attachArtifacts(page, testInfo, "fm4-remove-clears-session", {
    before: remembered,
    after,
  });
});

test("FM5: appending a page that overlaps loaded rows adds no duplicates", async ({
  page,
}, testInfo) => {
  // First page is rows 0-999; the second page repeats rows 500-999.
  await page.addInitScript(() => {
    const mock = (
      window as unknown as {
        __POSTAL_SNAP_MOCK__?: {
          handlers: Record<
            string,
            (args: Record<string, unknown>) => Promise<unknown>
          >;
        };
      }
    ).__POSTAL_SNAP_MOCK__;
    const original = mock?.handlers.list_messages;
    if (!mock || !original) return;
    mock.handlers.list_messages = async (args) => {
      const result = (await original(args)) as {
        items: Array<{ receivedAt: string; uid: number }>;
        nextCursor: unknown;
        hasMore: boolean;
      };
      if (!args.cursor) {
        const first = result.items.slice(0, 1000);
        const last = first[first.length - 1];
        return {
          ...result,
          items: first,
          nextCursor: { receivedAt: last.receivedAt, uid: last.uid },
          hasMore: true,
        };
      }
      return {
        ...result,
        items: result.items.slice(500, 1500),
        nextCursor: null,
        hasMore: false,
      };
    };
  });
  await page.goto("/?hugeList=1500&theme=light&density=normal");
  const list = page.locator(".message-list");
  await expect(page.getByRole("option").first()).toBeVisible();

  const loadOlder = page.getByRole("button", {
    name: "Load older mail",
    exact: true,
  });
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(loadOlder).toBeVisible();
  await loadOlder.click();
  await expect(loadOlder).toBeHidden();
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.getByRole("option").first()).toHaveAttribute(
    "aria-setsize",
    "1500",
  );
  const lastRow = page.getByRole("option", { name: /Archive note 1500,/ });
  await expect(lastRow).toHaveAttribute("aria-posinset", "1500");

  const names = await page
    .getByRole("option")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? node.textContent),
    );
  expect(new Set(names).size).toBe(names.length);
  await attachArtifacts(page, testInfo, "fm5-overlap-no-duplicates");
});
