import { api } from "./api";
import { strings } from "./i18n";
import { beginMessageOpen } from "./messageOpen";
import { useAppStore } from "./store";
import {
  conversationMessages,
  messageAfterRemoval,
  messageAfterRemovals,
} from "./threads";
import type { MailboxSummary, MessageSummary } from "./types";

const BULK_LIMIT = 200;

export type ConversationMoveRole = "archive" | "trash" | "junk" | "inbox";

function shiftCounts(
  mailboxes: MailboxSummary[],
  message: MessageSummary,
  destinationId: number,
): MailboxSummary[] {
  return mailboxes.map((mailbox) => {
    if (mailbox.id === message.mailboxId) {
      return {
        ...mailbox,
        totalCount: Math.max(0, mailbox.totalCount - 1),
        unreadCount: Math.max(
          0,
          mailbox.unreadCount - (message.isRead ? 0 : 1),
        ),
      };
    }
    if (mailbox.id === destinationId) {
      return {
        ...mailbox,
        totalCount: mailbox.totalCount + 1,
        unreadCount: mailbox.unreadCount + (message.isRead ? 0 : 1),
      };
    }
    return mailbox;
  });
}

/**
 * Moves one listed message to Archive, Trash, Junk, or back to Inbox.
 * The message stays closed unless it was the open message.
 */
export async function moveListedMessage(
  summary: MessageSummary,
  role: "archive" | "inbox" | "trash" | "junk",
  onLeft?: (next: MessageSummary | undefined, openWasMoved: boolean) => void,
): Promise<void> {
  const store = useAppStore.getState();
  const destination = store.mailboxes.find(
    (mailbox) =>
      mailbox.accountId === summary.accountId && mailbox.role === role,
  );
  if (!destination) {
    store.setError(
      role === "inbox" ? strings.mail.noInbox : strings.mail.noTargetFolder,
    );
    return;
  }
  if (destination.id === summary.mailboxId) return;
  const snapshotMessages = store.messages;
  const snapshotMailboxes = store.mailboxes;
  const previousSelected = store.selectedMessage;
  const openWasMoved = previousSelected?.id === summary.id;
  const viewMailboxId = store.activeMailboxId;
  const viewLocal = store.activeLocalView;
  const grouped =
    store.settings.groupThreads && (store.mailboxSort ?? "date") === "date";
  const next = messageAfterRemoval(store.messages, grouped, summary.id);
  store.setMailboxes(shiftCounts(store.mailboxes, summary, destination.id));
  store.setMessages(
    store.messages.filter((item) => item.id !== summary.id),
    store.messageCursor,
    store.hasMoreMessages,
  );
  onLeft?.(next, openWasMoved);
  const sameView = () => {
    const current = useAppStore.getState();
    return (
      current.activeAccountId === summary.accountId &&
      current.activeMailboxId === viewMailboxId &&
      current.activeLocalView === viewLocal
    );
  };
  const restore = () => {
    const current = useAppStore.getState();
    if (!sameView()) return;
    const optimistic = snapshotMessages
      .filter((item) => item.id !== summary.id)
      .map((item) => item.id)
      .join(",");
    if (current.messages.map((item) => item.id).join(",") !== optimistic)
      return;
    current.setMessages(
      snapshotMessages,
      current.messageCursor,
      current.hasMoreMessages,
    );
    current.setMailboxes(snapshotMailboxes);
    if (openWasMoved && previousSelected) {
      beginMessageOpen();
      current.selectMessage(previousSelected);
    }
  };
  try {
    if (role === "inbox") {
      await api.moveMessageToMailbox(
        summary.accountId,
        summary.id,
        destination.id,
      );
    } else {
      await api.moveMessage(summary.accountId, summary.id, role);
    }
  } catch (cause) {
    restore();
    if (sameView()) useAppStore.getState().setError(String(cause));
  }
}

/**
 * Moves every loaded message in this mailbox conversation.
 * Messages that are not loaded stay where they are.
 * `onLeft` runs after the list updates and before the move finishes.
 */
export async function moveLoadedConversation(
  summary: MessageSummary,
  target: ConversationMoveRole | number,
  onLeft?: (next: MessageSummary | undefined, openWasMoved: boolean) => void,
): Promise<void> {
  const store = useAppStore.getState();
  const members = conversationMessages(store.messages, summary);
  if (members.length < 2) return;
  const destination = store.mailboxes.find((mailbox) => {
    if (mailbox.accountId !== summary.accountId) return false;
    return typeof target === "number"
      ? mailbox.id === target
      : mailbox.role === target;
  });
  if (!destination) {
    store.setError(strings.mail.noTargetFolder);
    return;
  }
  if (destination.id === summary.mailboxId) return;
  let moving = members.slice(0, BULK_LIMIT);
  if (members.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    if (!moving.some((item) => item.id === summary.id)) {
      moving = [...moving.slice(0, BULK_LIMIT - 1), summary];
    }
  }
  const ids = moving.map((item) => item.id);
  const idSet = new Set(ids);
  const snapshotMessages = store.messages;
  const snapshotMailboxes = store.mailboxes;
  const previousSelected = store.selectedMessage;
  const openWasMoved = Boolean(
    previousSelected && idSet.has(previousSelected.id),
  );
  const viewMailboxId = store.activeMailboxId;
  const viewLocal = store.activeLocalView;
  const grouped =
    store.settings.groupThreads && (store.mailboxSort ?? "date") === "date";
  const next = messageAfterRemovals(store.messages, grouped, idSet, summary.id);
  let mailboxes = store.mailboxes;
  for (const item of moving)
    mailboxes = shiftCounts(mailboxes, item, destination.id);
  store.setMailboxes(mailboxes);
  store.setMessages(
    store.messages.filter((item) => !idSet.has(item.id)),
    store.messageCursor,
    store.hasMoreMessages,
  );
  onLeft?.(next, openWasMoved);
  const sameView = () => {
    const current = useAppStore.getState();
    return (
      current.activeAccountId === summary.accountId &&
      current.activeMailboxId === viewMailboxId &&
      current.activeLocalView === viewLocal
    );
  };
  const restore = () => {
    const current = useAppStore.getState();
    if (!sameView()) return;
    const optimistic = snapshotMessages
      .filter((item) => !idSet.has(item.id))
      .map((item) => item.id)
      .join(",");
    if (current.messages.map((item) => item.id).join(",") !== optimistic)
      return;
    current.setMessages(
      snapshotMessages,
      current.messageCursor,
      current.hasMoreMessages,
    );
    current.setMailboxes(snapshotMailboxes);
    if (openWasMoved && previousSelected) {
      beginMessageOpen();
      current.selectMessage(previousSelected);
    }
  };
  try {
    const outcome = await api.moveMessagesToMailbox(
      summary.accountId,
      ids,
      destination.id,
    );
    if (outcome.failed > 0) {
      useAppStore.getState().setError(strings.mail.bulkPartial(outcome.failed));
    }
    if (outcome.updated + outcome.queued === 0) restore();
  } catch (cause) {
    restore();
    if (sameView()) useAppStore.getState().setError(String(cause));
  }
}
