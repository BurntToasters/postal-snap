import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { emitTauriEvent, ipcCommands } from "./ipc";
import { installMockIpc } from "./mock-ipc";
import type { MockMessageSummary, MockShared, MockState } from "./mock/context";

type MoveCommand = "move_message" | "move_messages_to_mailbox";

interface HeldMoveState {
  pendingMove?: { command: MoveCommand; args: Record<string, unknown> };
  rejectHeldMove?: () => void;
  arrivalPageMode?: "during" | "after-failure";
  arrivalSearchModes?: string[];
  failArrivalReconciliation?: boolean;
  rowReadById?: Record<number, boolean>;
  rowStarredById?: Record<number, boolean>;
}

type RecoveryState = MockState & HeldMoveState;

test.beforeEach(async ({ page }) => installMockIpc(page));

async function holdMove(page: Page, command: MoveCommand): Promise<void> {
  await page.addInitScript((targetCommand: MoveCommand) => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as RecoveryState;
    const handlers = mock.handlers as Record<
      string,
      (args: Record<string, unknown>) => unknown
    >;
    handlers[targetCommand] = (args) => {
      state.pendingMove = { command: targetCommand, args };
      return new Promise((_, reject) => {
        state.rejectHeldMove = () =>
          reject(
            mock.mockError("operationFailed", "Synthetic move refusal.", true),
          );
      });
    };
  }, command);
}

async function setInboxUnreadCount(page: Page, count: number): Promise<void> {
  await page.addInitScript((nextCount: number) => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const inbox = mock.mailboxes.find((mailbox) => mailbox.id === 1);
    if (inbox) inbox.unreadCount = nextCount;
  }, count);
}

async function setAuthoritativeInboxUnreadCount(
  page: Page,
  count: number,
): Promise<void> {
  await page.addInitScript((nextCount: number) => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const inbox = mock.mailboxes.find((mailbox) => mailbox.id === 1);
    if (inbox) inbox.unreadCount = nextCount;
    const handlers = mock.handlers as Record<
      string,
      (args: Record<string, unknown>) => unknown
    >;
    const original = handlers.list_mailboxes;
    handlers.list_mailboxes = (args) => {
      const result = original(args) as Array<{
        id: number;
        unreadCount: number;
        [key: string]: unknown;
      }>;
      return result.map((mailbox) =>
        mailbox.id === 1 ? { ...mailbox, unreadCount: nextCount } : mailbox,
      );
    };
  }, count);
}

async function mirrorRowMutations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as RecoveryState;
    const handlers = mock.handlers as Record<
      string,
      (args: Record<string, unknown>) => unknown
    >;
    state.rowReadById = {};
    state.rowStarredById = {};
    const initialRead = (id: number) => id === 9 || id === 61 || id === 63;
    const update = (id: number, isRead: unknown, isStarred: unknown) => {
      if (typeof isRead === "boolean") {
        const previous = state.rowReadById?.[id] ?? initialRead(id);
        state.rowReadById![id] = isRead;
        if (previous !== isRead) {
          const inbox = mock.mailboxes.find((mailbox) => mailbox.id === 1);
          if (inbox) {
            inbox.unreadCount = Math.max(
              0,
              inbox.unreadCount + (isRead ? -1 : 1),
            );
          }
        }
      }
      if (typeof isStarred === "boolean") state.rowStarredById![id] = isStarred;
    };
    handlers.set_message_flags = (args) => {
      const id = Number(args.messageId);
      update(id, args.isRead, args.isStarred);
      return undefined;
    };
    handlers.set_messages_flags = (args) => {
      const ids = (args.messageIds ?? []) as number[];
      for (const id of ids) update(id, args.isRead, args.isStarred);
      return { updated: ids.length, queued: 0, failed: 0 };
    };
    const originalList = handlers.list_messages;
    handlers.list_messages = async (args) => {
      const result = (await originalList(args)) as {
        items: MockMessageSummary[];
        [key: string]: unknown;
      };
      return {
        ...result,
        items: result.items.map((item) => ({
          ...item,
          isRead: state.rowReadById?.[item.id] ?? item.isRead,
          isStarred: state.rowStarredById?.[item.id] ?? item.isStarred,
        })),
      };
    };
  });
}

async function setArrivalPageMode(
  page: Page,
  mode: HeldMoveState["arrivalPageMode"],
): Promise<void> {
  await page.evaluate((nextMode) => {
    const state = window.__POSTAL_SNAP_TEST__ as RecoveryState;
    state.arrivalPageMode = nextMode;
  }, mode);
}

async function installArrivalSearch(
  page: Page,
  failReconciliation = false,
): Promise<void> {
  await page.addInitScript((fail: boolean) => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as RecoveryState;
    state.failArrivalReconciliation = fail;
    const handlers = mock.handlers as Record<
      string,
      (args: Record<string, unknown>) => unknown
    >;
    const urgent: MockMessageSummary = {
      ...mock.summary,
      id: 62,
      uid: 62,
      messageId: "<urgent@example.com>",
      subject: "Urgent: server maintenance",
      receivedAt: "2026-08-17T08:00:00Z",
      isRead: false,
      isStarred: false,
    };
    const pinned: MockMessageSummary & { pinned: boolean } = {
      ...mock.summary,
      id: 63,
      uid: 63,
      messageId: "<pinned-note@example.com>",
      subject: "Pinned reminder",
      receivedAt: "2026-08-18T09:00:00Z",
      isRead: true,
      isStarred: false,
      pinned: true,
    };
    const arrival: MockMessageSummary = {
      ...mock.summary,
      id: 65,
      uid: 65,
      messageId: "<unrelated-arrival@example.com>",
      subject: "Unrelated new arrival",
      receivedAt: "2026-08-20T12:00:00Z",
      isRead: false,
      isStarred: false,
    };
    const results = () => {
      state.arrivalSearchModes ??= [];
      state.arrivalSearchModes.push(state.arrivalPageMode ?? "initial");
      if (fail && state.arrivalPageMode === "after-failure")
        return [pinned, arrival];
      return state.arrivalPageMode === "during"
        ? [pinned, arrival]
        : state.arrivalPageMode === "after-failure"
          ? [pinned, urgent, arrival]
          : [pinned, urgent];
    };
    const originalCached = handlers.search_cached_messages;
    const originalServer = handlers.search_server_messages;
    const isTargetSearch = (args: Record<string, unknown>) =>
      (args.query as { text?: string } | undefined)?.text ===
      "body:recovery-check";
    handlers.search_cached_messages = (args) =>
      isTargetSearch(args) ? results() : originalCached(args);
    handlers.search_server_messages = async (args) => {
      if (
        fail &&
        isTargetSearch(args) &&
        state.arrivalPageMode === "after-failure"
      )
        throw new Error("PRIVATE server response body and address");
      const existing = (await originalServer(args)) as {
        messages: MockMessageSummary[];
        [key: string]: unknown;
      };
      return isTargetSearch(args)
        ? { ...existing, messages: results() }
        : existing;
    };
  }, failReconciliation);
}

async function beginArrivalMove(page: Page, failReconciliation = false) {
  await holdMove(page, "move_message");
  await installArrivalSearch(page, failReconciliation);
  await page.goto("/?rowMix=1");

  const search = page.getByRole("searchbox");
  await search.fill("body:recovery-check");
  await search.press("Enter");
  const urgent = rowById(page, 62);
  await expect(urgent).toBeVisible();
  await expect(page.locator(".message-row")).toHaveCount(2);
  await clickRowAction(page, 62, "archive");
  const pending = await waitForMove(page, "move_message");
  expect(pending?.args).toMatchObject({ messageId: 62, role: "archive" });
  await expect(urgent).toHaveCount(0);

  const pinnedReader = page.getByRole("heading", { name: "Pinned reminder" });
  await rowById(page, 63).click();
  await expect(pinnedReader).toBeVisible();
  const searchReads = (await ipcCommands(page)).filter(
    (command) => command === "search_server_messages",
  ).length;
  await setArrivalPageMode(page, "during");
  await waitForEventListener(page, "message-changed");
  await emitTauriEvent(page, "message-changed", {
    accountId: "account-1",
    messageId: 65,
    kind: "synced",
  });
  await waitForNewCommand(page, "search_server_messages", searchReads);
  await expect(rowById(page, 65)).toBeVisible();
  await expect(urgent).toHaveCount(0);
  await expect(pinnedReader).toBeVisible();
  await expect(search).toHaveValue("body:recovery-check");

  return { urgent, pinnedReader, search };
}

async function refreshCountsFromStatus(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__POSTAL_SNAP_TEST__ as RecoveryState).eventListeners.get(
            "folder-counts-changed",
          )?.size ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  const mailboxReads = (await ipcCommands(page)).filter(
    (command) => command === "list_mailboxes",
  ).length;
  await emitTauriEvent(page, "folder-counts-changed", {
    accountId: "account-1",
  });
  await expect
    .poll(
      async () =>
        (await ipcCommands(page)).filter(
          (command) => command === "list_mailboxes",
        ).length,
    )
    .toBeGreaterThan(mailboxReads);
}

async function waitForEventListener(page: Page, event: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (eventName) =>
          (window.__POSTAL_SNAP_TEST__ as RecoveryState).eventListeners.get(
            eventName,
          )?.size ?? 0,
        event,
      ),
    )
    .toBeGreaterThan(0);
}

async function waitForNewCommand(
  page: Page,
  command: string,
  previousCount: number,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await ipcCommands(page)).filter((item) => item === command).length,
    )
    .toBeGreaterThan(previousCount);
}

function inboxUnreadBadge(page: Page) {
  return page.locator('.folder-row[data-mailbox-id="1"] button.folder strong');
}

async function expectInboxUnreadCount(
  page: Page,
  count: number,
): Promise<void> {
  const badge = inboxUnreadBadge(page);
  if (count === 0) await expect(badge).toHaveCount(0);
  else await expect(badge).toHaveText(String(count));
}

async function waitForMove(page: Page, command: MoveCommand) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__POSTAL_SNAP_TEST__ as RecoveryState;
        return state.pendingMove ?? null;
      }),
    )
    .toMatchObject({ command });
  return page.evaluate(() => {
    const state = window.__POSTAL_SNAP_TEST__ as RecoveryState;
    return state.pendingMove;
  });
}

async function refuseMove(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__POSTAL_SNAP_TEST__ as RecoveryState;
    if (!state.rejectHeldMove) throw new Error("No move is being held.");
    state.rejectHeldMove();
  });
}

async function settleUi(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

function rowById(page: Page, id: number) {
  return page.locator(`.message-row[data-message-id="${id}"]`);
}

async function clickRowAction(
  page: Page,
  id: number,
  action: "read" | "star" | "archive",
): Promise<void> {
  const row = rowById(page, id);
  const wrapper = page.locator(".message-row-wrap").filter({ has: row });
  await wrapper.hover();
  const button = wrapper.locator(`button.row-action[data-action="${action}"]`);
  await expect(button).toBeVisible();
  await button.click();
}

test("individual move refusal preserves later row changes and reader selection", async ({
  page,
}) => {
  await holdMove(page, "move_message");
  await setInboxUnreadCount(page, 5);
  await mirrorRowMutations(page);
  await page.goto("/?rowMix=1");

  const urgent = rowById(page, 62);
  await expect(urgent).toBeVisible();
  await urgent.click();
  await expect(
    page.getByRole("heading", { name: "Urgent: server maintenance" }),
  ).toBeVisible();
  await urgent.focus();
  await page.keyboard.press("e");

  const pending = await waitForMove(page, "move_message");
  expect(pending?.args).toMatchObject({ messageId: 62, role: "archive" });
  await expect(urgent).toHaveCount(0);

  const invitation = rowById(page, 64);
  await clickRowAction(page, 64, "read");
  await expect(invitation).toHaveClass(/\bread\b/);

  const receipt = rowById(page, 61);
  await clickRowAction(page, 61, "star");
  await expect(receipt.locator(".star-mark")).toHaveCount(1);
  await expect(inboxUnreadBadge(page)).toHaveText("3");

  await rowById(page, 63).click();
  await expect(
    page.getByRole("heading", { name: "Pinned reminder" }),
  ).toBeVisible();
  await refuseMove(page);
  await expect(urgent).toBeVisible();
  await expect(inboxUnreadBadge(page)).toHaveText("3");

  const observed = {
    invitationRead: await invitation.evaluate((node) =>
      node.classList.contains("read"),
    ),
    receiptFlagged: (await receipt.locator(".star-mark").count()) === 1,
    pinnedReaderStillSelected: await page
      .getByRole("heading", { name: "Pinned reminder" })
      .isVisible(),
  };
  expect(observed).toEqual({
    invitationRead: true,
    receiptFlagged: true,
    pinnedReaderStillSelected: true,
  });
});

test("grouped move refusal preserves later row changes and reader selection", async ({
  page,
}) => {
  await holdMove(page, "move_messages_to_mailbox");
  await setInboxUnreadCount(page, 5);
  await mirrorRowMutations(page);
  await page.goto("/?rowMix=1");

  const conversation = page.locator(".message-row.thread-header");
  await expect(conversation).toBeVisible();
  await conversation.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await conversation.focus();
  await page.keyboard.press("e");

  const pending = await waitForMove(page, "move_messages_to_mailbox");
  expect(pending?.args).toMatchObject({
    accountId: "account-1",
    messageIds: expect.arrayContaining([10, 9]),
  });
  await expect(conversation).toHaveCount(0);

  const invitation = rowById(page, 64);
  await clickRowAction(page, 64, "read");
  await expect(invitation).toHaveClass(/\bread\b/);
  const receipt = rowById(page, 61);
  await clickRowAction(page, 61, "star");
  await expect(receipt.locator(".star-mark")).toHaveCount(1);
  await expect(inboxUnreadBadge(page)).toHaveText("2");

  await rowById(page, 63).click();
  await expect(
    page.getByRole("heading", { name: "Pinned reminder" }),
  ).toBeVisible();
  await refuseMove(page);
  await expect(conversation).toBeVisible();
  await expect(inboxUnreadBadge(page)).toHaveText("2");

  const observed = {
    invitationRead: await invitation.evaluate((node) =>
      node.classList.contains("read"),
    ),
    receiptFlagged: (await receipt.locator(".star-mark").count()) === 1,
    pinnedReaderStillSelected: await page
      .getByRole("heading", { name: "Pinned reminder" })
      .isVisible(),
  };
  expect(observed).toEqual({
    invitationRead: true,
    receiptFlagged: true,
    pinnedReaderStillSelected: true,
  });
});

test("move refusal keeps the newly selected account and folder", async ({
  page,
}) => {
  await holdMove(page, "move_message");
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const original = mock.handlers.list_messages;
    mock.handlers.list_messages = async (args) => {
      const result = (await original(args)) as {
        items: Array<{ accountId: string; mailboxId: number }>;
        [key: string]: unknown;
      };
      return {
        ...result,
        items: result.items.filter(
          (item) =>
            item.accountId === String(args.accountId) &&
            item.mailboxId === Number(args.mailboxId),
        ),
      };
    };
  });
  await page.goto("/?multiAccount=1&threadGap=1");

  const library = rowById(page, 30);
  await expect(library).toBeVisible();
  await library.click();
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  await library.focus();
  await page.keyboard.press("e");
  const pending = await waitForMove(page, "move_message");
  expect(pending?.args).toMatchObject({ messageId: 30, role: "archive" });
  await expect(library).toHaveCount(0);

  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  await page
    .getByRole("menu", { name: "Email accounts" })
    .getByRole("menuitemradio", { name: /Work/ })
    .click();
  const workAccount = page.getByRole("button", {
    name: /Work.*reader@fastmail\.com/i,
  });
  await expect(workAccount).toBeVisible();

  const archive = page.locator(
    '.folder-row[data-mailbox-id="22"] button.folder',
  );
  await expect(archive).toBeVisible();
  await archive.click();
  await expect(archive).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();

  await refuseMove(page);
  await settleUi(page);
  expect({
    account: await workAccount.isVisible(),
    folderActive: await archive.getAttribute("aria-current"),
    staleAccountRows: await page.locator(".message-row").count(),
  }).toEqual({ account: true, folderActive: "page", staleAccountRows: 0 });
});

test("move refusal does not reapply counts after an authoritative refresh", async ({
  page,
}) => {
  await holdMove(page, "move_message");
  await setAuthoritativeInboxUnreadCount(page, 0);
  await page.goto("/?rowMix=1");

  const urgent = rowById(page, 62);
  await expect(urgent).toBeVisible();
  if (await urgent.evaluate((node) => node.classList.contains("read"))) {
    await clickRowAction(page, 62, "read");
    await expect(urgent).toHaveClass(/\bunread\b/);
  }
  await refreshCountsFromStatus(page);
  await expectInboxUnreadCount(page, 0);

  await clickRowAction(page, 62, "archive");
  const pending = await waitForMove(page, "move_message");
  expect(pending?.args).toMatchObject({ messageId: 62, role: "archive" });
  await expect(urgent).toHaveCount(0);
  await expectInboxUnreadCount(page, 0);
  await refreshCountsFromStatus(page);
  await expectInboxUnreadCount(page, 0);

  await refuseMove(page);
  await expect(urgent).toBeVisible();
  await expectInboxUnreadCount(page, 0);
});

test("move refusal reconciles a new row without losing the active search or selection", async ({
  page,
}) => {
  const { urgent, pinnedReader, search } = await beginArrivalMove(page);
  expect(
    await page.evaluate(
      () => (window.__POSTAL_SNAP_TEST__ as RecoveryState).arrivalSearchModes,
    ),
  ).toContain("during");

  await setArrivalPageMode(page, "after-failure");
  const reconciliationSearches = await page.evaluate(
    () =>
      (window.__POSTAL_SNAP_TEST__ as RecoveryState).arrivalSearchModes?.filter(
        (mode) => mode === "after-failure",
      ).length ?? 0,
  );
  await refuseMove(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__POSTAL_SNAP_TEST__ as RecoveryState
          ).arrivalSearchModes?.filter((mode) => mode === "after-failure")
            .length ?? 0,
      ),
    )
    .toBeGreaterThan(reconciliationSearches);
  await expect(urgent).toBeVisible();
  await expect(rowById(page, 65)).toBeVisible();
  await expect(pinnedReader).toBeVisible();
  await expect(search).toHaveValue("body:recovery-check");
});

test("failed reconciliation keeps the changed search results and redacts the error", async ({
  page,
}) => {
  const { urgent, pinnedReader, search } = await beginArrivalMove(page, true);
  await setArrivalPageMode(page, "after-failure");
  const searchReads = (await ipcCommands(page)).filter(
    (command) => command === "search_server_messages",
  ).length;

  await refuseMove(page);
  await waitForNewCommand(page, "search_server_messages", searchReads);
  const searchError = page
    .getByRole("alert")
    .filter({ hasText: "Server search unavailable" });
  await expect(searchError).toBeVisible();
  await expect(searchError).not.toContainText("PRIVATE server response body");
  await expect(urgent).toHaveCount(0);
  await expect(rowById(page, 65)).toBeVisible();
  await expect(pinnedReader).toBeVisible();
  await expect(search).toHaveValue("body:recovery-check");
});

test("move recovery keeps an unsubmitted search edit out of the refresh", async ({
  page,
}) => {
  const { urgent, search } = await beginArrivalMove(page);
  await expect(page.locator(".message-list-items")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await search.fill("subject:unsubmitted-replacement");
  await expect(search).toHaveValue("subject:unsubmitted-replacement");
  await expect(page.locator(".message-list-items")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  await setArrivalPageMode(page, "after-failure");
  const searchReads = (await ipcCommands(page)).filter(
    (command) => command === "search_server_messages",
  ).length;
  await refuseMove(page);
  await waitForNewCommand(page, "search_server_messages", searchReads);
  await expect(page.locator(".message-list-items")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  const observed = await page.evaluate(() => {
    const calls = (window.__POSTAL_SNAP_TEST__ as RecoveryState).ipcCalls;
    const searches = calls
      .filter((call) => call.command === "search_server_messages")
      .map(
        (call) =>
          (call.args.query as { text?: string; allFolders?: boolean }).text,
      );
    const savedQueries = calls
      .filter((call) => call.command === "remember_search")
      .map((call) => String(call.args.query));
    return { searches, savedQueries };
  });
  expect(observed.searches[observed.searches.length - 1]).toBe(
    "body:recovery-check",
  );
  expect(observed.savedQueries).not.toContain(
    "subject:unsubmitted-replacement",
  );
  await expect(search).toHaveValue("subject:unsubmitted-replacement");
  await expect(urgent).toBeVisible();
  await expect(rowById(page, 65)).toBeVisible();
});
