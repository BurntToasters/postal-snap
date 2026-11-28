import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifactsAfterEach, emitTauriEvent, ipcCalls } from "./ipc";
import { installMockIpc } from "./mock-ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered:
// 1. Selection shortcut `u` sends only the checked IDs to their owning account.
// 2. Late move, delete, and snooze results cannot clear or close a newer
//    account's selection or reader.
// 3. A late bulk result cannot clear a newer account's selected message.
// 4. A partial grouped-read result restores the server-failed message after the
//    backend's change event refreshes the list.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/grouped-selection-recovery-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

type DeferredWindow = Window & {
  finishBulkFlags?: (outcome: {
    updated: number;
    queued: number;
    failed: number;
  }) => void;
  finishMutation?: (result: unknown) => void;
  rejectMutation?: (error: unknown) => void;
};

async function holdBulkFlags(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
    mock.handlers.set_messages_flags = () =>
      new Promise((resolve) => {
        (window as DeferredWindow).finishBulkFlags = resolve;
      });
  });
}

async function waitForHeldBulkFlags(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as DeferredWindow).finishBulkFlags),
    )
    .toBe("function");
}

async function finishBulkFlags(
  page: import("@playwright/test").Page,
  outcome: { updated: number; queued: number; failed: number },
) {
  await page.evaluate((result) => {
    const view = window as DeferredWindow;
    const finish = view.finishBulkFlags;
    if (!finish) throw new Error("The bulk flag request was not held.");
    view.finishBulkFlags = undefined;
    finish(result);
  }, outcome);
}

async function holdMutation(
  page: import("@playwright/test").Page,
  command: string,
) {
  await page.evaluate((name) => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
    mock.handlers[name] = () =>
      new Promise((resolve) => {
        (window as DeferredWindow).finishMutation = resolve;
      });
  }, command);
}

async function waitForHeldMutation(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as DeferredWindow).finishMutation),
    )
    .toBe("function");
}

async function finishMutation(
  page: import("@playwright/test").Page,
  result: unknown,
) {
  await page.evaluate((value) => {
    const view = window as DeferredWindow;
    const finish = view.finishMutation;
    if (!finish) throw new Error("The mutation request was not held.");
    view.finishMutation = undefined;
    finish(value);
  }, result);
}

async function holdRejectedMutation(
  page: import("@playwright/test").Page,
  command: string,
) {
  await page.evaluate((name) => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
    mock.handlers[name] = () =>
      new Promise((_resolve, reject) => {
        (window as DeferredWindow).rejectMutation = reject;
      });
  }, command);
}

async function waitForHeldRejection(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as DeferredWindow).rejectMutation),
    )
    .toBe("function");
}

async function rejectHeldMutation(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const view = window as DeferredWindow;
    const reject = view.rejectMutation;
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!reject || !mock) throw new Error("The mutation request was not held.");
    view.rejectMutation = undefined;
    reject(
      mock.mockError("operationFailed", "Could not complete the request."),
    );
  });
}

async function waitForUiCommit(page: import("@playwright/test").Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function switchToWork(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  await page
    .getByRole("menu", { name: "Email accounts" })
    .getByRole("menuitemradio", { name: /Work/ })
    .click();
  await expect(
    page.getByRole("option", { name: /Team launch/i }),
  ).toBeVisible();
}

async function exposeWorkMessageWhenThreadFixtureIsActive(
  page: import("@playwright/test").Page,
) {
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
    const listMessages = mock.handlers.list_messages;
    mock.handlers.list_messages = (args) =>
      args.accountId === mock.secondSummary.accountId
        ? { items: [mock.secondSummary], nextCursor: null, hasMore: false }
        : listMessages(args);
  });
}

test("selection u sends exactly the checked message IDs", async ({ page }) => {
  await page.goto("/?threadGap=1&mixedRead=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Older family note/i }).click();
  await page.keyboard.press("u");

  await expect
    .poll(
      async () =>
        (await ipcCalls(page)).filter(
          (call) => call.command === "set_messages_flags",
        ).length,
    )
    .toBe(1);
  const call = (await ipcCalls(page)).find(
    (item) => item.command === "set_messages_flags",
  );
  expect(call?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [30, 9],
    isRead: true,
  });
});

test("a late selection result preserves the new account's selected message", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await holdBulkFlags(page);

  await page.keyboard.press("u");
  await waitForHeldBulkFlags(page);
  const calls = await ipcCalls(page);
  expect(
    calls.filter((call) => call.command === "set_messages_flags").at(-1)?.args,
  ).toMatchObject({
    accountId: "account-1",
    messageIds: [10],
    isRead: true,
  });

  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  const switcher = page.getByRole("menu", { name: "Email accounts" });
  await switcher.getByRole("menuitemradio", { name: /Work/ }).click();
  await expect(
    page.getByRole("option", { name: /Team launch/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Team launch/i }).click();
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();

  await finishBulkFlags(page, { updated: 0, queued: 0, failed: 1 });
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await expect(page.locator(".error-toast")).toHaveCount(0);
  await expect(
    page.locator('.message-select[aria-label="Select Team launch"]'),
  ).toBeChecked();
});

test("a late bulk move failure stays with its original selection", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await holdRejectedMutation(page, "move_messages_to_mailbox");
  await page.keyboard.press("e");
  await waitForHeldRejection(page);

  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await rejectHeldMutation(page);

  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await expect(
    page.locator('.message-select[aria-label="Select Library hours"]'),
  ).toBeChecked();
  await expect(page.locator(".error-toast")).toHaveCount(0);
});

for (const operation of ["move", "delete", "snooze"] as const) {
  test(`late ${operation} preserves a newer account selection and reader`, async ({
    page,
  }) => {
    await page.goto(
      operation === "delete"
        ? "/?multiAccount=1&trashThread=1"
        : "/?multiAccount=1",
    );

    if (operation === "move") {
      await page.getByRole("button", { name: "Select", exact: true }).click();
      await page.getByRole("option", { name: /Weekend plans/i }).click();
      await holdMutation(page, "move_messages_to_mailbox");
      await page.keyboard.press("e");
      await waitForHeldMutation(page);
    } else if (operation === "delete") {
      await page.getByRole("button", { name: /^Trash\b/ }).click();
      await page.getByRole("button", { name: "Select", exact: true }).click();
      await page.getByRole("option", { name: /Old receipt/i }).click();
      await expect(
        page.getByRole("toolbar", { name: "1 selected" }),
      ).toBeVisible();
      await page.evaluate(() => {
        const mock = window.__POSTAL_SNAP_MOCK__;
        if (!mock) throw new Error("Mock state is missing.");
        mock.handlers.show_native_confirm = () => true;
      });
      await holdMutation(page, "delete_trash_messages");
      await page
        .getByRole("toolbar", { name: "1 selected" })
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await waitForHeldMutation(page);
    } else {
      await page.getByRole("option", { name: /Weekend plans/i }).click();
      await expect(
        page.getByRole("heading", { name: "Weekend plans" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Select", exact: true }).click();
      await page
        .locator('.message-select[aria-label="Select Weekend plans"]')
        .check();
      await page.getByRole("button", { name: "More mailbox actions" }).click();
      await page
        .getByRole("menuitem", { name: "Snooze selected", exact: true })
        .click();
      await holdMutation(page, "snooze_messages");
      await page.getByRole("button", { name: "Tomorrow morning" }).click();
      await waitForHeldMutation(page);
    }

    const command =
      operation === "move"
        ? "move_messages_to_mailbox"
        : operation === "delete"
          ? "delete_trash_messages"
          : "snooze_messages";
    const call = (await ipcCalls(page))
      .filter((item) => item.command === command)
      .at(-1);
    expect(call?.args).toMatchObject(
      operation === "delete"
        ? { accountId: "account-1", messageIds: [41] }
        : { accountId: "account-1", messageIds: [10] },
    );

    await switchToWork(page);
    if (operation === "move" || operation === "delete") {
      await page.getByRole("button", { name: "Select", exact: true }).click();
      await page.getByRole("option", { name: /Team launch/i }).click();
      await expect(
        page.getByRole("toolbar", { name: "1 selected" }),
      ).toBeVisible();
      await finishMutation(page, { updated: 0, queued: 1, failed: 0 });
      await expect(
        page.getByRole("toolbar", { name: "1 selected" }),
      ).toBeVisible();
      await expect(
        page.locator('.message-select[aria-label="Select Team launch"]'),
      ).toBeChecked();
    } else {
      await page.getByRole("option", { name: /Team launch/i }).click();
      await expect(
        page.getByRole("heading", { name: "Team launch" }),
      ).toBeVisible();
      await finishMutation(page, undefined);
      await expect(
        page.getByRole("heading", { name: "Team launch" }),
      ).toBeVisible();
    }
  });
}

for (const operation of ["flagColor", "saveSelectedFiles"] as const) {
  test(`a late ${operation} failure does not show in another account`, async ({
    page,
  }) => {
    await page.goto("/?multiAccount=1&fileCount=1");
    await holdRejectedMutation(
      page,
      operation === "flagColor"
        ? "set_messages_flag_color"
        : "save_conversation_attachments",
    );

    if (operation === "flagColor") {
      const row = page.getByRole("option", { name: /Weekend plans/i });
      await row.click({ button: "right" });
      const trigger = page.locator(".popup-submenu-trigger", {
        hasText: "Flag color",
      });
      await trigger.focus();
      await page.keyboard.press("ArrowRight");
      await page
        .locator(".popup-submenu-panel")
        .getByRole("menuitem", { name: "Orange", exact: true })
        .click();
      await waitForHeldRejection(page);
    } else {
      await page.getByRole("button", { name: "Select", exact: true }).click();
      await page.getByRole("option", { name: /Weekend plans/i }).click();
      await page.getByRole("button", { name: "More mailbox actions" }).click();
      await page
        .getByRole("menuitem", { name: "Save selected files", exact: true })
        .click();
      await waitForHeldRejection(page);
    }

    await switchToWork(page);
    await page.getByRole("option", { name: /Team launch/i }).click();
    await expect(
      page.getByRole("heading", { name: "Team launch" }),
    ).toBeVisible();
    await rejectHeldMutation(page);
    await waitForUiCommit(page);
    await expect(page.locator(".error-toast")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Team launch" }),
    ).toBeVisible();
  });
}

test("partial conversation read refreshes the applied and failed message state", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const group = page.getByRole("treeitem", { name: /Weekend plans/i });
  await expect(group).toHaveAccessibleName(/2 unread/);
  const wrap = page.locator(".message-row-wrap").filter({ has: group });
  await wrap.hover();
  await holdBulkFlags(page);
  await wrap.locator('button.row-action[data-action="read"]').click();
  await waitForHeldBulkFlags(page);

  const calls = await ipcCalls(page);
  expect(
    calls.filter((call) => call.command === "set_messages_flags").at(-1)?.args,
  ).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    isRead: true,
  });

  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
    mock.summary.isRead = true;
    mock.olderSummary.isRead = false;
  });
  await emitTauriEvent(page, "message-changed", {
    accountId: "account-1",
    messageId: null,
    kind: "flags",
  });
  await emitTauriEvent(page, "folder-counts-changed", {
    accountId: "account-1",
  });

  await expect(group).toHaveAccessibleName(/1 unread/);
  await finishBulkFlags(page, { updated: 1, queued: 0, failed: 1 });
  await expect(
    page.getByText("1 message could not be updated. The rest succeeded."),
  ).toBeVisible();
  await expect(group).toHaveAccessibleName(/1 unread/);
});

for (const action of ["read", "star"] as const) {
  test(`a late conversation ${action} partial failure does not leak into another account`, async ({
    page,
  }) => {
    await page.goto("/?multiAccount=1&threadGap=1");
    const group = page.getByRole("treeitem", { name: /Weekend plans/i });
    const wrap = page.locator(".message-row-wrap").filter({ has: group });
    await wrap.hover();
    await holdBulkFlags(page);
    await wrap.locator(`button.row-action[data-action="${action}"]`).click();
    await waitForHeldBulkFlags(page);

    const call = (await ipcCalls(page))
      .filter((item) => item.command === "set_messages_flags")
      .at(-1);
    expect(call?.args).toMatchObject({
      accountId: "account-1",
      messageIds: [10, 9],
      ...(action === "read" ? { isRead: true } : { isStarred: true }),
    });

    await exposeWorkMessageWhenThreadFixtureIsActive(page);
    await switchToWork(page);
    await finishBulkFlags(page, { updated: 1, queued: 0, failed: 1 });
    await waitForUiCommit(page);
    await expect(page.locator(".error-toast")).toHaveCount(0);
  });
}
