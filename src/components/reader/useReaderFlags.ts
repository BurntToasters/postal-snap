import type { RefObject } from "react";
import { api } from "../../api";
import { useAppStore } from "../../store";

type Store = ReturnType<typeof useAppStore.getState>;

interface Options {
  selectMessage: Store["selectMessage"];
  setMessages: Store["setMessages"];
  setMailboxes: Store["setMailboxes"];
  setError: (error?: string) => void;
  starredOperation: RefObject<number>;
  readOperation: RefObject<number>;
}

export function useReaderFlags({
  selectMessage,
  setMessages,
  setMailboxes,
  setError,
  starredOperation,
  readOperation,
}: Options) {
  async function setStarred() {
    const current = useAppStore.getState();
    const message = current.selectedMessage;
    if (!message) return;
    const operation = ++starredOperation.current;
    const viewMailboxId = current.activeMailboxId;
    const next = !message.isStarred;
    selectMessage({ ...message, isStarred: next });
    setMessages(
      current.messages.map((summary) =>
        summary.id === message.id ? { ...summary, isStarred: next } : summary,
      ),
      current.messageCursor,
      current.hasMoreMessages,
    );
    try {
      await api.setMessageFlags(message.accountId, message.id, undefined, next);
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation !== starredOperation.current ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      setMessages(
        current.messages.map((summary) =>
          summary.id === message.id && summary.isStarred === next
            ? { ...summary, isStarred: message.isStarred }
            : summary,
        ),
        current.messageCursor,
        current.hasMoreMessages,
      );
      if (
        current.selectedMessage?.id === message.id &&
        current.selectedMessage.isStarred === next
      )
        selectMessage({
          ...current.selectedMessage,
          isStarred: message.isStarred,
        });
      setError(String(cause));
    }
  }

  async function setRead() {
    const current = useAppStore.getState();
    const message = current.selectedMessage;
    if (!message) return;
    const operation = ++readOperation.current;
    const viewMailboxId = current.activeMailboxId;
    const next = !message.isRead;
    const previousUnreadCount = current.mailboxes.find(
      (mailbox) => mailbox.id === message.mailboxId,
    )?.unreadCount;
    selectMessage({ ...message, isRead: next });
    setMailboxes(
      current.mailboxes.map((mailbox) =>
        mailbox.id === message.mailboxId
          ? {
              ...mailbox,
              unreadCount: Math.max(0, mailbox.unreadCount + (next ? -1 : 1)),
            }
          : mailbox,
      ),
    );
    setMessages(
      current.messages.map((summary) =>
        summary.id === message.id ? { ...summary, isRead: next } : summary,
      ),
      current.messageCursor,
      current.hasMoreMessages,
    );
    try {
      await api.setMessageFlags(message.accountId, message.id, next, undefined);
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation !== readOperation.current ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      setMessages(
        current.messages.map((summary) =>
          summary.id === message.id && summary.isRead === next
            ? { ...summary, isRead: message.isRead }
            : summary,
        ),
        current.messageCursor,
        current.hasMoreMessages,
      );
      if (
        current.selectedMessage?.id === message.id &&
        current.selectedMessage.isRead === next
      )
        selectMessage({ ...current.selectedMessage, isRead: message.isRead });
      if (previousUnreadCount !== undefined) {
        const expectedUnreadCount = previousUnreadCount + (next ? -1 : 1);
        setMailboxes(
          current.mailboxes.map((mailbox) =>
            mailbox.id === message.mailboxId &&
            mailbox.unreadCount === expectedUnreadCount
              ? { ...mailbox, unreadCount: previousUnreadCount }
              : mailbox,
          ),
        );
      }
      setError(String(cause));
    }
  }

  return { setStarred, setRead };
}
