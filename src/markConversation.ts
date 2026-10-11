import { api } from "./api";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationRead, conversationUnread } from "./threads";
import type { MessageSummary } from "./types";

const BULK_LIMIT = 200;

/** Marks unread messages in the loaded conversation. Messages not yet loaded stay as they are. */
export async function markLoadedConversationRead(
  summary: MessageSummary,
): Promise<void> {
  await markLoadedConversation(summary, true);
}

/** Marks read messages in the loaded conversation unread. Messages not yet loaded stay as they are. */
export async function markLoadedConversationUnread(
  summary: MessageSummary,
): Promise<void> {
  await markLoadedConversation(summary, false);
}

async function markLoadedConversation(
  summary: MessageSummary,
  isRead: boolean,
): Promise<void> {
  const store = useAppStore.getState();
  const matches = (isRead ? conversationUnread : conversationRead)(
    store.messages,
    summary,
  );
  if (matches.length === 0) return;
  const ids = matches.slice(0, BULK_LIMIT).map((item) => item.id);
  if (matches.length > BULK_LIMIT) store.setError(strings.mail.bulkTooMany);
  const idSet = new Set(ids);
  const viewMailboxId = store.activeMailboxId;
  const viewLocal = store.activeLocalView;
  const previousUnread = store.mailboxes.find(
    (mailbox) => mailbox.id === summary.mailboxId,
  )?.unreadCount;
  const delta = isRead ? -ids.length : ids.length;
  store.setMessages(
    store.messages.map((item) =>
      idSet.has(item.id) ? { ...item, isRead } : item,
    ),
    store.messageCursor,
    store.hasMoreMessages,
  );
  if (previousUnread !== undefined) {
    store.setMailboxes(
      store.mailboxes.map((mailbox) =>
        mailbox.id === summary.mailboxId
          ? {
              ...mailbox,
              unreadCount: Math.max(0, mailbox.unreadCount + delta),
            }
          : mailbox,
      ),
    );
  }
  const selected = store.selectedMessage;
  if (selected && idSet.has(selected.id)) {
    store.selectMessage({ ...selected, isRead });
  }
  try {
    const outcome = await api.setMessagesFlags(
      summary.accountId,
      ids,
      isRead,
      undefined,
    );
    if (outcome.failed > 0) {
      useAppStore.getState().setError(strings.mail.bulkPartial(outcome.failed));
    }
  } catch (cause) {
    const current = useAppStore.getState();
    if (
      current.activeAccountId !== summary.accountId ||
      current.activeMailboxId !== viewMailboxId ||
      current.activeLocalView !== viewLocal
    ) {
      return;
    }
    current.setMessages(
      current.messages.map((item) =>
        idSet.has(item.id) && item.isRead === isRead
          ? { ...item, isRead: !isRead }
          : item,
      ),
      current.messageCursor,
      current.hasMoreMessages,
    );
    if (previousUnread !== undefined) {
      const expected = Math.max(0, previousUnread + delta);
      current.setMailboxes(
        current.mailboxes.map((mailbox) =>
          mailbox.id === summary.mailboxId && mailbox.unreadCount === expected
            ? { ...mailbox, unreadCount: previousUnread }
            : mailbox,
        ),
      );
    }
    const open = current.selectedMessage;
    if (open && idSet.has(open.id) && open.isRead === isRead) {
      current.selectMessage({ ...open, isRead: !isRead });
    }
    current.setError(String(cause));
  }
}
