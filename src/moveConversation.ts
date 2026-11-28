import { api } from "./api";
import { strings } from "./i18n";
import { beginMessageOpen } from "./messageOpen";
import { useAppStore } from "./store";
import {
  conversationMessages,
  messageAfterRemoval,
  messageAfterRemovals,
} from "./threads";
import type { MailboxSummary, MessageDetail, MessageSummary } from "./types";
import { BULK_LIMIT } from "./bulk";
import { undoableMove, undoTargetFor } from "./undoMove";
import { errorText } from "./errors";

export type ConversationMoveRole = "archive" | "trash" | "junk" | "inbox";
export interface MoveFailureRefreshResult {
  counts: boolean;
  messages: boolean;
}
export type MoveFailureReconciler = (
  accountId: string,
  mailboxId: number | undefined,
  localView: "drafts" | "outbox" | "snoozed" | undefined,
) => Promise<MoveFailureRefreshResult>;

interface MailboxCounts {
  totalCount: number;
  unreadCount: number;
}

type MailboxCountSnapshot = Map<number, MailboxCounts>;

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
        unreadCount: Math.max(
          0,
          mailbox.unreadCount + (message.isRead ? 0 : 1),
        ),
      };
    }
    return mailbox;
  });
}

function mailboxCountSnapshot(
  mailboxes: MailboxSummary[],
  accountId: string,
  mailboxIds: ReadonlySet<number>,
): MailboxCountSnapshot {
  return new Map(
    mailboxes
      .filter(
        (mailbox) =>
          mailbox.accountId === accountId && mailboxIds.has(mailbox.id),
      )
      .map((mailbox) => [
        mailbox.id,
        { totalCount: mailbox.totalCount, unreadCount: mailbox.unreadCount },
      ]),
  );
}

function sameMailboxCounts(
  mailboxes: MailboxSummary[],
  accountId: string,
  expected: MailboxCountSnapshot,
): boolean {
  if (expected.size === 0) return false;
  return [...expected].every(([id, count]) => {
    const mailbox = mailboxes.find(
      (item) => item.accountId === accountId && item.id === id,
    );
    return (
      mailbox?.totalCount === count.totalCount &&
      mailbox.unreadCount === count.unreadCount
    );
  });
}

function rollbackCountDelta(
  mailboxes: MailboxSummary[],
  accountId: string,
  before: MailboxCountSnapshot,
  optimistic: MailboxCountSnapshot,
): MailboxSummary[] {
  return mailboxes.map((mailbox) => {
    if (mailbox.accountId !== accountId) return mailbox;
    const previous = before.get(mailbox.id);
    const after = optimistic.get(mailbox.id);
    if (!previous || !after) return mailbox;
    return {
      ...mailbox,
      totalCount: Math.max(
        0,
        mailbox.totalCount - (after.totalCount - previous.totalCount),
      ),
      unreadCount: Math.max(
        0,
        mailbox.unreadCount - (after.unreadCount - previous.unreadCount),
      ),
    };
  });
}

function restoreMovedMessages(
  snapshot: MessageSummary[],
  current: MessageSummary[],
  movedIds: ReadonlySet<number>,
): MessageSummary[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return snapshot.map((item) =>
    movedIds.has(item.id) ? item : (currentById.get(item.id) ?? item),
  );
}

function restoreSelectionIfStillAutomatic(
  openWasMoved: boolean,
  previousSelected: MessageDetail | undefined,
  next: MessageSummary | undefined,
): void {
  if (!openWasMoved || !previousSelected) return;
  const current = useAppStore.getState();
  const selectedId = current.selectedMessage?.id;
  if (
    selectedId === undefined ||
    selectedId === previousSelected.id ||
    selectedId === next?.id
  ) {
    beginMessageOpen();
    current.selectMessage(previousSelected);
  }
}

interface RestoreFailedMoveOptions {
  accountId: string;
  mailboxId: number | undefined;
  localView: "drafts" | "outbox" | "snoozed" | undefined;
  snapshotMessages: MessageSummary[];
  movedIds: ReadonlySet<number>;
  countBefore: MailboxCountSnapshot;
  countOptimistic: MailboxCountSnapshot;
  previousSelected: MessageDetail | undefined;
  next: MessageSummary | undefined;
  openWasMoved: boolean;
  reconcileMoveFailure?: MoveFailureReconciler;
}

async function restoreFailedMove({
  accountId,
  mailboxId,
  localView,
  snapshotMessages,
  movedIds,
  countBefore,
  countOptimistic,
  previousSelected,
  next,
  openWasMoved,
  reconcileMoveFailure,
}: RestoreFailedMoveOptions): Promise<void> {
  const sameView = () => {
    const current = useAppStore.getState();
    return (
      current.activeAccountId === accountId &&
      current.activeMailboxId === mailboxId &&
      current.activeLocalView === localView
    );
  };
  if (!sameView()) return;

  let current = useAppStore.getState();
  const optimisticIds = snapshotMessages
    .filter((item) => !movedIds.has(item.id))
    .map((item) => item.id)
    .join(",");
  const expectedIdsMatch =
    current.messages.map((item) => item.id).join(",") === optimisticIds;
  const countsAtOptimistic = sameMailboxCounts(
    current.mailboxes,
    accountId,
    countOptimistic,
  );
  const countsAtBefore = sameMailboxCounts(
    current.mailboxes,
    accountId,
    countBefore,
  );
  const needsRefresh =
    !expectedIdsMatch || (!countsAtOptimistic && !countsAtBefore);
  const attemptedRefresh = needsRefresh && Boolean(reconcileMoveFailure);

  let refreshed = { counts: false, messages: false };
  if (needsRefresh && reconcileMoveFailure) {
    try {
      refreshed = await reconcileMoveFailure(accountId, mailboxId, localView);
    } catch {
      // Keep the move error visible and use only safe local rollback below.
    }
    if (!sameView()) return;
    current = useAppStore.getState();
  }

  const messagesMatchAfterRefresh =
    current.messages.map((item) => item.id).join(",") === optimisticIds;
  if (!attemptedRefresh && !refreshed.messages && messagesMatchAfterRefresh) {
    current.setMessages(
      restoreMovedMessages(snapshotMessages, current.messages, movedIds),
      current.messageCursor,
      current.hasMoreMessages,
    );
  }

  const countsStillOptimistic = sameMailboxCounts(
    current.mailboxes,
    accountId,
    countOptimistic,
  );
  if (!refreshed.counts && countsStillOptimistic) {
    current.setMailboxes(
      rollbackCountDelta(
        current.mailboxes,
        accountId,
        countBefore,
        countOptimistic,
      ),
    );
  }

  if (current.messages.some((item) => movedIds.has(item.id)))
    restoreSelectionIfStillAutomatic(openWasMoved, previousSelected, next);
}

/**
 * Moves one listed message to Archive, Trash, Junk, Inbox, or a mailbox id.
 * The message stays closed unless it was the open message.
 */
export async function moveListedMessage(
  summary: MessageSummary,
  target: ConversationMoveRole | number,
  onLeft?: (next: MessageSummary | undefined, openWasMoved: boolean) => void,
  reconcileMoveFailure?: MoveFailureReconciler,
): Promise<void> {
  const store = useAppStore.getState();
  const destination = store.mailboxes.find((mailbox) => {
    if (mailbox.accountId !== summary.accountId) return false;
    return typeof target === "number"
      ? mailbox.id === target
      : mailbox.role === target;
  });
  if (!destination) {
    store.setError(
      target === "inbox" ? strings.mail.noInbox : strings.mail.noTargetFolder,
    );
    return;
  }
  if (destination.id === summary.mailboxId) return;
  const snapshotMessages = store.messages;
  const previousSelected = store.selectedMessage;
  const openWasMoved = previousSelected?.id === summary.id;
  const viewMailboxId = store.activeMailboxId;
  const viewLocal = store.activeLocalView;
  const grouped =
    store.settings.groupThreads && (store.mailboxSort ?? "date") === "date";
  const next = messageAfterRemoval(store.messages, grouped, summary.id);
  const countMailboxIds = new Set([summary.mailboxId, destination.id]);
  const countBefore = mailboxCountSnapshot(
    store.mailboxes,
    summary.accountId,
    countMailboxIds,
  );
  const optimisticMailboxes = shiftCounts(
    store.mailboxes,
    summary,
    destination.id,
  );
  const countOptimistic = mailboxCountSnapshot(
    optimisticMailboxes,
    summary.accountId,
    countMailboxIds,
  );
  store.setMailboxes(optimisticMailboxes);
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
  const restore = () =>
    restoreFailedMove({
      accountId: summary.accountId,
      mailboxId: viewMailboxId,
      localView: viewLocal,
      snapshotMessages,
      movedIds: new Set([summary.id]),
      countBefore,
      countOptimistic,
      previousSelected,
      next,
      openWasMoved,
      reconcileMoveFailure,
    });
  try {
    await undoableMove({
      accountId: summary.accountId,
      target: undoTargetFor(destination),
      send: async (undoToken) => {
        if (typeof target === "number" || target === "inbox") {
          await api.moveMessageToMailbox(
            summary.accountId,
            summary.id,
            destination.id,
            undoToken,
          );
        } else {
          await api.moveMessage(
            summary.accountId,
            summary.id,
            target,
            undoToken,
          );
        }
      },
      deferred: () => 1,
    });
  } catch (cause) {
    if (sameView()) useAppStore.getState().setError(errorText(cause));
    await restore();
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
  reconcileMoveFailure?: MoveFailureReconciler,
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
  const previousSelected = store.selectedMessage;
  const openWasMoved = Boolean(
    previousSelected && idSet.has(previousSelected.id),
  );
  const viewMailboxId = store.activeMailboxId;
  const viewLocal = store.activeLocalView;
  const grouped =
    store.settings.groupThreads && (store.mailboxSort ?? "date") === "date";
  const next = messageAfterRemovals(store.messages, grouped, idSet, summary.id);
  const countMailboxIds = new Set([summary.mailboxId, destination.id]);
  const countBefore = mailboxCountSnapshot(
    store.mailboxes,
    summary.accountId,
    countMailboxIds,
  );
  let mailboxes = store.mailboxes;
  for (const item of moving)
    mailboxes = shiftCounts(mailboxes, item, destination.id);
  const countOptimistic = mailboxCountSnapshot(
    mailboxes,
    summary.accountId,
    countMailboxIds,
  );
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
  const restore = () =>
    restoreFailedMove({
      accountId: summary.accountId,
      mailboxId: viewMailboxId,
      localView: viewLocal,
      snapshotMessages,
      movedIds: idSet,
      countBefore,
      countOptimistic,
      previousSelected,
      next,
      openWasMoved,
      reconcileMoveFailure,
    });
  try {
    const outcome = await undoableMove({
      accountId: summary.accountId,
      target: undoTargetFor(destination),
      send: (undoToken) =>
        api.moveMessagesToMailbox(
          summary.accountId,
          ids,
          destination.id,
          undoToken,
        ),
      deferred: (result) => result.queued,
    });
    if (outcome.failed > 0) {
      useAppStore.getState().setError(strings.mail.bulkPartial(outcome.failed));
    }
    if (outcome.updated + outcome.queued === 0) await restore();
  } catch (cause) {
    if (sameView()) useAppStore.getState().setError(errorText(cause));
    await restore();
  }
}
