import { api } from "./api";
import { useAppStore } from "./store";

export type MarkReadMode = "open" | "after2s" | "manual";

const listedReadGeneration = new Map<number, number>();

function applyListedRead(
  messageId: number,
  mailboxId: number,
  isRead: boolean,
  unreadCount: number | undefined,
): void {
  const store = useAppStore.getState();
  store.setMessages(
    store.messages.map((item) =>
      item.id === messageId ? { ...item, isRead } : item,
    ),
    store.messageCursor,
    store.hasMoreMessages,
  );
  if (unreadCount !== undefined) {
    store.setMailboxes(
      store.mailboxes.map((mailbox) =>
        mailbox.id === mailboxId ? { ...mailbox, unreadCount } : mailbox,
      ),
    );
  }
  const selected = store.selectedMessage;
  if (selected?.id === messageId) {
    store.selectMessage({ ...selected, isRead });
  }
}

/** Marks one listed message read or unread without opening it. */
export async function toggleListedRead(messageId: number): Promise<void> {
  const store = useAppStore.getState();
  const summary =
    store.messages.find((item) => item.id === messageId) ??
    (store.selectedMessage?.id === messageId
      ? store.selectedMessage
      : undefined);
  if (!summary) return;
  const next = !summary.isRead;
  const generation = (listedReadGeneration.get(messageId) ?? 0) + 1;
  listedReadGeneration.set(messageId, generation);
  const viewMailboxId = store.activeMailboxId;
  const viewLocal = store.activeLocalView;
  const previousUnread = store.mailboxes.find(
    (mailbox) => mailbox.id === summary.mailboxId,
  )?.unreadCount;
  const unreadCount =
    previousUnread === undefined
      ? undefined
      : Math.max(0, previousUnread + (next ? -1 : 1));
  applyListedRead(messageId, summary.mailboxId, next, unreadCount);
  try {
    await api.setMessageFlags(summary.accountId, messageId, next, undefined);
  } catch (cause) {
    const current = useAppStore.getState();
    if (
      listedReadGeneration.get(messageId) !== generation ||
      current.activeAccountId !== summary.accountId ||
      current.activeMailboxId !== viewMailboxId ||
      current.activeLocalView !== viewLocal
    ) {
      return;
    }
    const expected = unreadCount;
    const restored =
      previousUnread !== undefined &&
      current.mailboxes.find((mailbox) => mailbox.id === summary.mailboxId)
        ?.unreadCount === expected
        ? previousUnread
        : undefined;
    applyListedRead(messageId, summary.mailboxId, summary.isRead, restored);
    current.setError(String(cause));
  }
}

/** Milliseconds before an open message is marked read. `null` waits for the reader. */
export function markReadDelayMs(mode: MarkReadMode | undefined): number | null {
  if (mode === "manual") return null;
  if (mode === "after2s") return 2_000;
  return 0;
}

export function waitToMarkRead(
  mode: MarkReadMode | undefined,
  stillOpen: () => boolean,
): Promise<boolean> {
  const delay = markReadDelayMs(mode);
  if (delay === null || !stillOpen()) return Promise.resolve(false);
  if (delay === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(stillOpen()), delay);
  });
}
