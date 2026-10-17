import type { RefObject } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { waitToMarkRead } from "../../markRead";
import { beginMessageOpen, isCurrentMessageOpen } from "../../messageOpen";
import { deleteLoadedConversation } from "../../deleteConversation";
import {
  moveLoadedConversation,
  type ConversationMoveRole,
} from "../../moveConversation";
import { rememberMoveMailboxId } from "../../recentMailbox";
import { useAppStore } from "../../store";
import { messageAfterRemoval } from "../../threads";
import { undoableMove, undoTargetFor } from "../../undoMove";
import type { MessageDetail, MessageSummary } from "../../types";
import { moveCounts } from "./readerUtils";

type Store = ReturnType<typeof useAppStore.getState>;

function restoreMovedMessage(
  current: MessageSummary[],
  expected: MessageSummary[],
  message: MessageSummary,
  previousIndex: number,
): MessageSummary[] | undefined {
  if (previousIndex < 0) return undefined;
  if (current.some((summary) => summary.id === message.id)) return undefined;
  if (current.length > expected.length) return undefined;
  const expectedIndexes = new Map(
    expected.map((summary, index) => [summary.id, index]),
  );
  let lastIndex = -1;
  let insertAt = 0;
  for (const summary of current) {
    const index = expectedIndexes.get(summary.id);
    if (index === undefined || index < lastIndex) return undefined;
    if (index < previousIndex) insertAt += 1;
    lastIndex = index;
  }
  const restored = [...current];
  restored.splice(insertAt, 0, message);
  return restored;
}

interface Options {
  selectMessage: Store["selectMessage"];
  setMessages: Store["setMessages"];
  setMailboxes: Store["setMailboxes"];
  setError: (error?: string) => void;
  moveOperations: RefObject<Map<number, number>>;
}

export function useReaderMoves({
  selectMessage,
  setMessages,
  setMailboxes,
  setError,
  moveOperations,
}: Options) {
  async function deleteForever() {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    const source = snapshot.mailboxes.find(
      (mailbox) => mailbox.id === message.mailboxId,
    );
    if (source?.role !== "trash") return;
    const confirmed = await api.showNativeConfirm(
      strings.mail.deleteForever,
      strings.mail.deleteForeverQuestion(1),
    );
    if (!confirmed) return;
    const current = useAppStore.getState();
    if (
      current.selectedMessage?.id !== message.id ||
      current.activeAccountId !== message.accountId
    )
      return;
    const next = messageAfterRemoval(
      current.messages,
      current.settings.groupThreads &&
        (current.mailboxSort ?? "date") === "date",
      message.id,
    );
    beginMessageOpen();
    try {
      await api.deleteTrashMessages(message.accountId, [message.id]);
    } catch (cause) {
      if (useAppStore.getState().selectedMessage?.id === message.id)
        setError(String(cause));
      return;
    }
    const after = useAppStore.getState();
    if (
      after.activeAccountId !== message.accountId ||
      after.activeMailboxId !== message.mailboxId ||
      after.activeLocalView ||
      (after.selectedMessage && after.selectedMessage.id !== message.id)
    )
      return;
    const remaining = after.messages.filter(
      (summary) => summary.id !== message.id,
    );
    if (remaining.length !== after.messages.length) {
      setMailboxes(moveCounts(after.mailboxes, message));
      setMessages(remaining, after.messageCursor, after.hasMoreMessages);
    }
    const following =
      next &&
      (remaining.some((summary) => summary.id === next.id) ||
        after.messages.some((summary) => summary.id === next.id))
        ? next
        : undefined;
    if (following) void showNextMessage(following);
    else {
      beginMessageOpen();
      selectMessage(undefined);
    }
  }

  function previewDetail(summary: MessageSummary): MessageDetail {
    return {
      ...summary,
      to: [],
      cc: [],
      replyTo: null,
      textBody: summary.preview,
      htmlBody: null,
      remoteImagesBlocked: false,
      attachments: [],
    };
  }

  async function showNextMessage(next: MessageSummary) {
    const request = beginMessageOpen();
    selectMessage(previewDetail(next));
    try {
      const detail = await api.getMessage(next.accountId, next.id);
      if (!isCurrentMessageOpen(request)) return;
      const current = useAppStore.getState();
      if (
        current.activeAccountId !== next.accountId ||
        current.activeMailboxId !== next.mailboxId ||
        current.activeLocalView
      )
        return;
      selectMessage(detail);
      if (next.isRead) return;
      const readyToMark = await waitToMarkRead(
        useAppStore.getState().settings.markRead,
        () => {
          const latest = useAppStore.getState();
          return (
            isCurrentMessageOpen(request) &&
            latest.selectedMessage?.id === next.id &&
            latest.activeAccountId === next.accountId &&
            latest.activeMailboxId === next.mailboxId &&
            !latest.activeLocalView
          );
        },
      );
      if (!readyToMark) return;
      await api.setMessageFlags(next.accountId, next.id, true, undefined);
      if (!isCurrentMessageOpen(request)) return;
      const latest = useAppStore.getState();
      if (
        latest.activeAccountId !== next.accountId ||
        latest.activeMailboxId !== next.mailboxId ||
        latest.activeLocalView
      )
        return;
      setMessages(
        latest.messages.map((item) =>
          item.id === next.id ? { ...item, isRead: true } : item,
        ),
        latest.messageCursor,
        latest.hasMoreMessages,
      );
      setMailboxes(
        latest.mailboxes.map((mailbox) =>
          mailbox.id === next.mailboxId
            ? {
                ...mailbox,
                unreadCount: Math.max(0, mailbox.unreadCount - 1),
              }
            : mailbox,
        ),
      );
      if (latest.selectedMessage?.id === next.id)
        selectMessage({ ...detail, isRead: true });
    } catch (cause) {
      if (!isCurrentMessageOpen(request)) return;
      setError(String(cause));
    }
  }

  function restoreFailedMove(
    currentSelectedId: number | undefined,
    nextId: number | undefined,
    message: MessageDetail,
  ) {
    if (currentSelectedId && currentSelectedId !== nextId) return;
    beginMessageOpen();
    selectMessage(message);
  }

  async function muteConversation() {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message?.messageId?.trim()) return;
    if (message.conversationMuted) {
      try {
        await api.unmuteConversation(message.accountId, message.id);
        paintConversationMuted(message, false);
      } catch (cause) {
        setError(String(cause));
      }
      return;
    }
    const inInbox = snapshot.mailboxes.some(
      (box) => box.id === message.mailboxId && box.role === "inbox",
    );
    const confirmed = await api.showNativeConfirm(
      strings.reader.muteConversation,
      inInbox
        ? strings.reader.muteConversationQuestion
        : strings.reader.muteConversationFuture,
    );
    if (!confirmed) return;
    try {
      const filed = await api.muteConversation(message.accountId, message.id);
      dropFiledMessages(message, filed);
      paintConversationMuted(message, true);
    } catch (cause) {
      setError(String(cause));
    }
  }

  function paintConversationMuted(message: MessageSummary, muted: boolean) {
    const latest = useAppStore.getState();
    const root = message.threadRoot;
    const sameThread = (item: MessageSummary) =>
      item.accountId === message.accountId &&
      (item.id === message.id || Boolean(root && item.threadRoot === root));
    setMessages(
      latest.messages.map((item) =>
        sameThread(item) ? { ...item, conversationMuted: muted } : item,
      ),
      latest.messageCursor,
      latest.hasMoreMessages,
    );
    const selected = latest.selectedMessage;
    if (selected && sameThread(selected)) {
      selectMessage({ ...selected, conversationMuted: muted });
    }
  }

  function dropFiledMessages(message: MessageSummary, filed: number[]) {
    if (filed.length === 0) return;
    const latest = useAppStore.getState();
    const filedIds = new Set(filed);
    const rows = latest.messages.filter((item) => filedIds.has(item.id));
    if (rows.length === 0 && !filedIds.has(message.id)) return;
    const archive = latest.mailboxes.find(
      (box) => box.accountId === message.accountId && box.role === "archive",
    );
    let mailboxes = latest.mailboxes;
    for (const row of rows) {
      mailboxes = mailboxes.map((box) => {
        if (box.id === row.mailboxId) {
          return {
            ...box,
            totalCount: Math.max(0, box.totalCount - 1),
            unreadCount: Math.max(0, box.unreadCount - (row.isRead ? 0 : 1)),
          };
        }
        if (box.id === archive?.id) {
          return { ...box, totalCount: box.totalCount + 1 };
        }
        return box;
      });
    }
    setMailboxes(mailboxes);
    const remaining = latest.messages.filter((item) => !filedIds.has(item.id));
    setMessages(remaining, latest.messageCursor, latest.hasMoreMessages);
    if (!filedIds.has(message.id)) return;
    const grouped =
      latest.settings.groupThreads && (latest.mailboxSort ?? "date") === "date";
    let next = messageAfterRemoval(latest.messages, grouped, message.id);
    while (next && filedIds.has(next.id)) {
      next = messageAfterRemoval(
        latest.messages.filter(
          (item) => !filedIds.has(item.id) || item.id === next?.id,
        ),
        grouped,
        next.id,
      );
    }
    if (next && !filedIds.has(next.id)) void showNextMessage(next);
    else {
      beginMessageOpen();
      selectMessage(undefined);
    }
  }

  async function move(role: "archive" | "trash" | "junk") {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    const mailboxes = snapshot.mailboxes;
    const messages = snapshot.messages;
    const messageCursor = snapshot.messageCursor;
    const hasMoreMessages = snapshot.hasMoreMessages;
    const destination = mailboxes.find((mailbox) => mailbox.role === role);
    const source = mailboxes.find(
      (mailbox) => mailbox.id === message.mailboxId,
    );
    if (
      destination?.id === message.mailboxId ||
      (destination && source?.name === destination.name)
    )
      return;
    const operation = (moveOperations.current.get(message.id) ?? 0) + 1;
    moveOperations.current.set(message.id, operation);
    const viewMailboxId = snapshot.activeMailboxId;
    const previousUnreadCounts = new Map(
      mailboxes.map((mailbox) => [mailbox.id, mailbox.unreadCount]),
    );
    const previousIndex = messages.findIndex(
      (summary) => summary.id === message.id,
    );
    const next = messageAfterRemoval(
      messages,
      snapshot.settings.groupThreads &&
        (snapshot.mailboxSort ?? "date") === "date",
      message.id,
    );
    setMailboxes(moveCounts(mailboxes, message, destination?.id));
    setMessages(
      messages.filter((summary) => summary.id !== message.id),
      messageCursor,
      hasMoreMessages,
    );
    if (next) void showNextMessage(next);
    else {
      beginMessageOpen();
      selectMessage(undefined);
    }
    try {
      await undoableMove({
        accountId: message.accountId,
        target: { kind: role },
        send: (undoToken) =>
          api.moveMessage(message.accountId, message.id, role, undoToken),
        deferred: () => 1,
      });
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        moveOperations.current.get(message.id) !== operation ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      const expectedMessages = messages.filter(
        (summary) => summary.id !== message.id,
      );
      const restoredMessages = restoreMovedMessage(
        current.messages,
        expectedMessages,
        message,
        previousIndex,
      );
      if (restoredMessages) {
        setMessages(
          restoredMessages,
          current.messageCursor,
          current.hasMoreMessages,
        );
      }
      setMailboxes(
        current.mailboxes.map((mailbox) => {
          const previousUnreadCount = previousUnreadCounts.get(mailbox.id);
          if (previousUnreadCount === undefined) return mailbox;
          const delta =
            mailbox.id === message.mailboxId
              ? message.isRead
                ? 0
                : -1
              : mailbox.id === destination?.id
                ? message.isRead
                  ? 0
                  : 1
                : 0;
          return mailbox.unreadCount === previousUnreadCount + delta
            ? { ...mailbox, unreadCount: previousUnreadCount }
            : mailbox;
        }),
      );
      if (restoredMessages)
        restoreFailedMove(current.selectedMessage?.id, next?.id, message);
      setError(String(cause));
    }
  }

  function deleteConversation() {
    const message = useAppStore.getState().selectedMessage;
    if (!message) return;
    void deleteLoadedConversation(message, (next, openWasDeleted) => {
      if (!openWasDeleted) return;
      if (next) void showNextMessage(next);
      else {
        beginMessageOpen();
        selectMessage(undefined);
      }
    });
  }

  function moveConversation(target: ConversationMoveRole | number) {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    if (typeof target === "number")
      rememberMoveMailboxId(snapshot.mailboxes, target);
    void moveLoadedConversation(message, target, (next, openWasMoved) => {
      if (!openWasMoved) return;
      if (next) void showNextMessage(next);
      else {
        beginMessageOpen();
        selectMessage(undefined);
      }
    });
  }

  function moveToInbox() {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    const inbox = snapshot.mailboxes.find(
      (mailbox) =>
        mailbox.accountId === message.accountId && mailbox.role === "inbox",
    );
    if (inbox) void moveToMailbox(inbox.id);
  }

  async function moveToMailbox(mailboxId: number) {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    if (mailboxId === message.mailboxId) return;
    const destination = snapshot.mailboxes.find((box) => box.id === mailboxId);
    if (!destination) return;
    rememberMoveMailboxId(snapshot.mailboxes, mailboxId);
    const mailboxes = snapshot.mailboxes;
    const messages = snapshot.messages;
    const messageCursor = snapshot.messageCursor;
    const hasMoreMessages = snapshot.hasMoreMessages;
    const operation = (moveOperations.current.get(message.id) ?? 0) + 1;
    moveOperations.current.set(message.id, operation);
    const viewMailboxId = snapshot.activeMailboxId;
    const previousUnreadCounts = new Map(
      mailboxes.map((mailbox) => [mailbox.id, mailbox.unreadCount]),
    );
    const previousIndex = messages.findIndex(
      (summary) => summary.id === message.id,
    );
    const next = messageAfterRemoval(
      messages,
      snapshot.settings.groupThreads &&
        (snapshot.mailboxSort ?? "date") === "date",
      message.id,
    );
    setMailboxes(moveCounts(mailboxes, message, mailboxId));
    setMessages(
      messages.filter((summary) => summary.id !== message.id),
      messageCursor,
      hasMoreMessages,
    );
    if (next) void showNextMessage(next);
    else {
      beginMessageOpen();
      selectMessage(undefined);
    }
    try {
      await undoableMove({
        accountId: message.accountId,
        target: undoTargetFor(destination),
        send: (undoToken) =>
          api.moveMessageToMailbox(
            message.accountId,
            message.id,
            mailboxId,
            undoToken,
          ),
        deferred: () => 1,
      });
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        moveOperations.current.get(message.id) !== operation ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      const expectedMessages = messages.filter(
        (summary) => summary.id !== message.id,
      );
      const restoredMessages = restoreMovedMessage(
        current.messages,
        expectedMessages,
        message,
        previousIndex,
      );
      if (restoredMessages) {
        setMessages(
          restoredMessages,
          current.messageCursor,
          current.hasMoreMessages,
        );
      }
      setMailboxes(
        current.mailboxes.map((mailbox) => {
          const previousUnreadCount = previousUnreadCounts.get(mailbox.id);
          if (previousUnreadCount === undefined) return mailbox;
          const delta =
            mailbox.id === message.mailboxId
              ? message.isRead
                ? 0
                : -1
              : mailbox.id === mailboxId
                ? message.isRead
                  ? 0
                  : 1
                : 0;
          return mailbox.unreadCount === previousUnreadCount + delta
            ? { ...mailbox, unreadCount: previousUnreadCount }
            : mailbox;
        }),
      );
      if (restoredMessages)
        restoreFailedMove(current.selectedMessage?.id, next?.id, message);
      setError(String(cause));
    }
  }

  async function copyToMailbox(mailboxId: number) {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message || mailboxId === message.mailboxId) return;
    rememberMoveMailboxId(snapshot.mailboxes, mailboxId);
    const accountId = message.accountId;
    const messageId = message.id;
    try {
      await api.copyMessageToMailbox(accountId, messageId, mailboxId);
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        current.activeAccountId !== accountId ||
        current.selectedMessage?.id !== messageId
      )
        return;
      setError(String(cause));
    }
  }

  return {
    deleteForever,
    muteConversation,
    move,
    deleteConversation,
    moveConversation,
    moveToInbox,
    moveToMailbox,
    copyToMailbox,
  };
}
