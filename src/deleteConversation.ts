import { api } from "./api";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationMessages, messageAfterRemovals } from "./threads";
import type { MailboxSummary, MessageSummary } from "./types";

const BULK_LIMIT = 200;

function sameIds(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(right);
  return left.every((id) => seen.has(id));
}

function dropCounts(
  mailboxes: MailboxSummary[],
  mailboxId: number,
  removed: MessageSummary[],
): MailboxSummary[] {
  const unread = removed.filter((item) => !item.isRead).length;
  return mailboxes.map((mailbox) =>
    mailbox.id === mailboxId
      ? {
          ...mailbox,
          totalCount: Math.max(0, mailbox.totalCount - removed.length),
          unreadCount: Math.max(0, mailbox.unreadCount - unread),
        }
      : mailbox,
  );
}

/**
 * Permanently deletes one listed Trash message after confirmation.
 * The message stays closed unless it was the open message.
 */
export async function deleteListedMessage(
  summary: MessageSummary,
  onLeft?: (next: MessageSummary | undefined, openWasDeleted: boolean) => void,
): Promise<void> {
  const store = useAppStore.getState();
  const mailbox = store.mailboxes.find(
    (item) =>
      item.id === summary.mailboxId && item.accountId === summary.accountId,
  );
  if (mailbox?.role !== "trash") return;
  const confirmed = await api.showNativeConfirm(
    strings.mail.deleteForever,
    strings.mail.deleteForeverQuestion(1),
  );
  if (!confirmed) return;
  const current = useAppStore.getState();
  if (
    current.activeAccountId !== summary.accountId ||
    current.activeMailboxId !== summary.mailboxId ||
    current.activeLocalView ||
    !current.messages.some((item) => item.id === summary.id)
  )
    return;
  try {
    await api.deleteTrashMessages(summary.accountId, [summary.id]);
  } catch (cause) {
    useAppStore.getState().setError(String(cause));
    return;
  }
  const after = useAppStore.getState();
  if (
    after.activeAccountId !== summary.accountId ||
    after.activeMailboxId !== summary.mailboxId ||
    after.activeLocalView ||
    !after.messages.some((item) => item.id === summary.id)
  )
    return;
  const open = after.selectedMessage;
  const openWasDeleted = open?.id === summary.id;
  const next = messageAfterRemovals(
    after.messages,
    after.settings.groupThreads && (after.mailboxSort ?? "date") === "date",
    new Set([summary.id]),
    summary.id,
  );
  const remaining = after.messages.filter((item) => item.id !== summary.id);
  const removed = after.messages.find((item) => item.id === summary.id);
  if (removed) {
    after.setMailboxes(
      dropCounts(after.mailboxes, summary.mailboxId, [removed]),
    );
  }
  after.setMessages(remaining, after.messageCursor, after.hasMoreMessages);
  if (openWasDeleted) after.selectMessage(undefined);
  const following =
    next && remaining.some((item) => item.id === next.id) ? next : undefined;
  onLeft?.(following, openWasDeleted);
}

/**
 * Permanently deletes every loaded message in a Trash conversation.
 * Messages that are not loaded stay in Trash. The delete waits for confirmation.
 */
export async function deleteLoadedConversation(
  summary: MessageSummary,
  onLeft?: (next: MessageSummary | undefined, openWasDeleted: boolean) => void,
): Promise<void> {
  const store = useAppStore.getState();
  const mailbox = store.mailboxes.find(
    (item) =>
      item.id === summary.mailboxId && item.accountId === summary.accountId,
  );
  if (mailbox?.role !== "trash") return;
  const members = conversationMessages(store.messages, summary);
  if (members.length < 2) return;
  if (members.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    return;
  }
  const ids = members.map((item) => item.id);
  const confirmed = await api.showNativeConfirm(
    strings.reader.deleteConversation,
    strings.mail.deleteForeverQuestion(ids.length),
  );
  if (!confirmed) return;
  const current = useAppStore.getState();
  if (
    current.activeAccountId !== summary.accountId ||
    current.activeMailboxId !== summary.mailboxId ||
    current.activeLocalView
  )
    return;
  const still = conversationMessages(current.messages, summary);
  if (
    !sameIds(
      ids,
      still.map((item) => item.id),
    )
  )
    return;
  const trash = current.mailboxes.find(
    (item) =>
      item.id === summary.mailboxId && item.accountId === summary.accountId,
  );
  if (trash?.role !== "trash") return;
  try {
    await api.deleteTrashMessages(summary.accountId, ids);
  } catch (cause) {
    useAppStore.getState().setError(String(cause));
    return;
  }
  const after = useAppStore.getState();
  if (
    after.activeAccountId !== summary.accountId ||
    after.activeMailboxId !== summary.mailboxId ||
    after.activeLocalView
  )
    return;
  const removed = new Set(ids);
  const open = after.selectedMessage;
  const openWasDeleted = Boolean(
    open && open.accountId === summary.accountId && removed.has(open.id),
  );
  const anchor = openWasDeleted && open ? open : still[0];
  const next = messageAfterRemovals(
    after.messages,
    after.settings.groupThreads && (after.mailboxSort ?? "date") === "date",
    removed,
    anchor.id,
  );
  const remaining = after.messages.filter((item) => !removed.has(item.id));
  after.setMailboxes(dropCounts(after.mailboxes, summary.mailboxId, still));
  after.setMessages(remaining, after.messageCursor, after.hasMoreMessages);
  if (openWasDeleted) after.selectMessage(undefined);
  const following =
    next && remaining.some((item) => item.id === next.id) ? next : undefined;
  onLeft?.(following, openWasDeleted);
}
