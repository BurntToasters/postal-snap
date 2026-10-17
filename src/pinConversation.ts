import { api } from "./api";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationMessages } from "./threads";
import type { MessageSummary } from "./types";
import { BULK_LIMIT } from "./bulk";

function paintPins(ids: ReadonlySet<number>, pinned: boolean): void {
  const store = useAppStore.getState();
  store.setMessages(
    store.messages.map((item) =>
      ids.has(item.id) ? { ...item, pinned } : item,
    ),
    store.messageCursor,
    store.hasMoreMessages,
  );
  const selected = store.selectedMessage;
  if (selected && ids.has(selected.id)) {
    store.selectMessage({ ...selected, pinned });
  }
}

async function applyPin(
  accountId: string,
  ids: number[],
  pinned: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const view = useAppStore.getState();
  const viewMailboxId = view.activeMailboxId;
  const viewLocal = view.activeLocalView;
  paintPins(idSet, pinned);
  try {
    const updated = await api.setMessagesPinned(accountId, ids, pinned);
    if (updated !== ids.length) {
      throw new Error("That message could not be pinned.");
    }
  } catch (cause) {
    const current = useAppStore.getState();
    if (
      current.activeAccountId !== accountId ||
      current.activeMailboxId !== viewMailboxId ||
      current.activeLocalView !== viewLocal
    ) {
      return;
    }
    const revert = new Set(
      ids.filter((id) => {
        const item = current.messages.find((message) => message.id === id);
        return item ? Boolean(item.pinned) === pinned : false;
      }),
    );
    paintPins(revert, !pinned);
    current.setError(String(cause));
  }
}

/**
 * Pins or unpins one message, or every loaded message in its conversation.
 * The choice stays on this computer.
 */
export async function pinLoadedMessages(
  summary: MessageSummary,
  pinned: boolean,
  conversation = false,
): Promise<void> {
  const store = useAppStore.getState();
  const source = conversation
    ? conversationMessages(store.messages, summary)
    : [summary];
  const matches = source.filter((item) => Boolean(item.pinned) !== pinned);
  if (matches.length === 0) return;
  const ids = matches.slice(0, BULK_LIMIT).map((item) => item.id);
  if (matches.length > BULK_LIMIT) store.setError(strings.mail.bulkTooMany);
  await applyPin(summary.accountId, ids, pinned);
}

/** Pins or unpins the checked messages. More than 200 changes none of them. */
export async function pinSelectedMessages(
  accountId: string,
  messageIds: number[],
  pinned: boolean,
): Promise<void> {
  const store = useAppStore.getState();
  const ids = messageIds.filter((id) => {
    const item = store.messages.find(
      (message) => message.id === id && message.accountId === accountId,
    );
    return item ? Boolean(item.pinned) !== pinned : false;
  });
  if (ids.length === 0) return;
  if (ids.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    return;
  }
  await applyPin(accountId, ids, pinned);
}
