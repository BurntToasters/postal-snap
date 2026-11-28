import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifactsAfterEach, ipcCalls } from "./ipc";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered:
// 1. Group read/flag keys or inline actions target only the newest message.
// 2. Inline controls steal focus from the grouped row.
// 3. Junk/Delete shortcuts move the wrong ids, account, or destination.
// 4. Junk cannot return to this account's Inbox, or Trash undo loses the group.
// 5. Trash deletion skips confirmation or leaves the wrong next reader selected.

test.beforeEach(async ({ page }) => installMockIpc(page));
test.afterEach(attachArtifactsAfterEach);

function groupRow(page: Page, subject: RegExp = /Weekend plans/i): Locator {
  return page
    .locator('button[role="treeitem"].thread-header')
    .filter({ hasText: subject });
}

function groupWrap(page: Page, row: Locator): Locator {
  return page
    .locator(".message-row-wrap.thread-header-wrap")
    .filter({ has: row });
}

function rowAction(wrap: Locator, action: "star" | "read"): Locator {
  return wrap.locator(`button.row-action[data-action="${action}"]`);
}

function selectedListRow(page: Page, subject: RegExp): Locator {
  return page
    .locator(".message-row[aria-selected='true']")
    .filter({ hasText: subject });
}

async function callsFor(page: Page, command: string) {
  return (await ipcCalls(page)).filter((call) => call.command === command);
}

async function waitForCallCount(
  page: Page,
  command: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await callsFor(page, command)).length)
    .toBe(count);
}

test("grouped read and flag keys plus inline controls act on every message and keep focus", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const group = groupRow(page);
  const wrap = groupWrap(page, group);
  await expect(group).toBeVisible();

  await group.focus();
  await page.keyboard.press("s");
  await waitForCallCount(page, "set_messages_flags", 1);
  await expect(group).toHaveAccessibleName(/Flagged/i);
  await expect(group).toBeFocused();

  await page.keyboard.press("u");
  await waitForCallCount(page, "set_messages_flags", 2);
  await expect(group).not.toHaveAccessibleName(/2 unread/i);
  await expect(group).toBeFocused();

  await wrap.hover();
  const read = rowAction(wrap, "read");
  await expect(read).toHaveAttribute("aria-label", "Mark conversation unread");
  await read.click();
  await waitForCallCount(page, "set_messages_flags", 3);
  await expect(group).toHaveAccessibleName(/2 unread/i);
  await expect(group).toBeFocused();

  const flag = rowAction(wrap, "star");
  await expect(flag).toHaveAttribute("aria-label", "Unflag conversation");
  await flag.click();
  await waitForCallCount(page, "set_messages_flags", 4);
  await expect(group).not.toHaveAccessibleName(/Flagged/i);
  await expect(group).toBeFocused();

  const calls = await callsFor(page, "set_messages_flags");
  expect(calls).toHaveLength(4);
  expect(calls[0]?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    isStarred: true,
  });
  expect(calls[1]?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    isRead: true,
  });
  expect(calls[2]?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    isRead: false,
  });
  expect(calls[3]?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    isStarred: false,
  });
});

test("the focused group junk shortcut moves the whole conversation and opens the next message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&junkFolder=1");
  const group = groupRow(page);
  await group.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await group.focus();
  await page.keyboard.press("!");

  await waitForCallCount(page, "move_messages_to_mailbox", 1);
  await expect(group).toHaveCount(0);
  const next = selectedListRow(page, /Library hours/i);
  await expect(next).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();

  const moved = (await callsFor(page, "move_messages_to_mailbox"))[0];
  expect(moved?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    destinationMailboxId: 11,
  });
});

test("the focused group junk shortcut returns Junk mail to this account's Inbox", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&inJunk=1");
  await page.getByRole("button", { name: /^Junk\b/ }).click();
  const group = groupRow(page);
  await group.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await group.focus();
  await page.keyboard.press("!");

  await waitForCallCount(page, "move_messages_to_mailbox", 1);
  await expect(group).toHaveCount(0);
  await expect(selectedListRow(page, /Library hours/i)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  const moved = (await callsFor(page, "move_messages_to_mailbox"))[0];
  expect(moved?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    destinationMailboxId: 1,
  });

  await page.getByRole("button", { name: /^Inbox\b/ }).click();
  await expect(group).toBeVisible();
  await expect(page.getByText("No message selected")).toBeVisible();
});

test("Delete moves the focused conversation to Trash and Undo restores it without changing the next reader", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const group = groupRow(page);
  await group.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await group.focus();
  await page.keyboard.press("Delete");

  await waitForCallCount(page, "move_messages_to_mailbox", 1);
  await expect(group).toHaveCount(0);
  await expect(selectedListRow(page, /Library hours/i)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  const notice = page.locator(".notice", {
    hasText: "Moved 2 messages to Trash.",
  });
  await expect(notice).toBeVisible();

  const moved = (await callsFor(page, "move_messages_to_mailbox"))[0];
  expect(moved?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [10, 9],
    destinationMailboxId: 3,
  });
  await notice.getByRole("button", { name: "Undo" }).click();
  await expect(group).toBeVisible();
  await expect(selectedListRow(page, /Library hours/i)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();

  const undo = (await callsFor(page, "undo_deferred"))[0];
  expect(undo?.args).toMatchObject({
    accountId: "account-1",
    undoToken: (moved?.args as Record<string, unknown> | undefined)?.undoToken,
  });
});

test("Delete in Trash confirms, removes the loaded conversation, and opens the next message", async ({
  page,
}) => {
  await page.goto("/?trashThread=1");
  await page.getByRole("button", { name: /^Trash\b/ }).click();
  const group = groupRow(page, /Old receipt/i);
  await group.click();
  await expect(
    page.getByRole("heading", { name: "Old receipt" }),
  ).toBeVisible();
  await group.focus();

  let confirmation = "";
  page.once("dialog", (dialog) => {
    confirmation = dialog.message();
    void dialog.accept();
  });
  await page.keyboard.press("Delete");
  await waitForCallCount(page, "delete_trash_messages", 1);
  expect(confirmation).toContain(
    "Permanently delete 2 messages? This cannot be undone.",
  );
  await expect(group).toHaveCount(0);
  await expect(selectedListRow(page, /Keep this/i)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Keep this" })).toBeVisible();

  const deleted = (await callsFor(page, "delete_trash_messages"))[0];
  expect(deleted?.args).toMatchObject({
    accountId: "account-1",
    messageIds: [41, 42],
  });
  expect(await callsFor(page, "move_messages_to_mailbox")).toHaveLength(0);
});
