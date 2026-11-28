import { api } from "./api";
import { BULK_LIMIT, createOptimisticGate } from "./bulk";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationMessages } from "./threads";
import type { MessageSummary } from "./types";
import { errorText } from "./errors";

const listedStar = createOptimisticGate<number>();

function applyListedStar(
  messageId: number,
  starred: boolean,
  flagColor = 0,
): void {
  const store = useAppStore.getState();
  store.setMessages(
    store.messages.map((item) =>
      item.id === messageId
        ? {
            ...item,
            isStarred: starred,
            flagColor,
          }
        : item,
    ),
    store.messageCursor,
    store.hasMoreMessages,
  );
  const selected = store.selectedMessage;
  if (selected?.id === messageId) {
    store.selectMessage({
      ...selected,
      isStarred: starred,
      flagColor,
    });
  }
}

/** Stars or unstars one listed message without opening it. */
export async function toggleListedStar(messageId: number): Promise<void> {
  const store = useAppStore.getState();
  const summary =
    store.messages.find((item) => item.id === messageId) ??
    (store.selectedMessage?.id === messageId
      ? store.selectedMessage
      : undefined);
  if (!summary) return;
  const next = !summary.isStarred;
  const generation = listedStar.begin(messageId);
  const viewMailboxId = store.activeMailboxId;
  const viewLocal = store.activeLocalView;
  applyListedStar(messageId, next, 0);
  try {
    await api.setMessageFlags(summary.accountId, messageId, undefined, next);
  } catch (cause) {
    const current = useAppStore.getState();
    if (
      !listedStar.isLatest(messageId, generation) ||
      current.activeAccountId !== summary.accountId ||
      current.activeMailboxId !== viewMailboxId ||
      current.activeLocalView !== viewLocal
    ) {
      return;
    }
    applyListedStar(messageId, !next, summary.flagColor);
    current.setError(errorText(cause));
  }
}

/** Stars or unstars loaded messages in this conversation that are not already in that state. */
export async function starLoadedConversation(
  summary: MessageSummary,
  starred: boolean,
): Promise<void> {
  const store = useAppStore.getState();
  const matches = conversationMessages(store.messages, summary).filter(
    (item) => item.isStarred !== starred,
  );
  if (matches.length === 0) return;
  const ids = matches.slice(0, BULK_LIMIT).map((item) => item.id);
  if (matches.length > BULK_LIMIT) store.setError(strings.mail.bulkTooMany);
  const idSet = new Set(ids);
  const previousColorById = new Map(
    matches.slice(0, BULK_LIMIT).map((item) => [item.id, item.flagColor]),
  );
  const viewMailboxId = store.activeMailboxId;
  const viewLocal = store.activeLocalView;
  store.setMessages(
    store.messages.map((item) =>
      idSet.has(item.id)
        ? {
            ...item,
            isStarred: starred,
            flagColor: 0,
          }
        : item,
    ),
    store.messageCursor,
    store.hasMoreMessages,
  );
  const selected = store.selectedMessage;
  if (selected && idSet.has(selected.id)) {
    store.selectMessage({
      ...selected,
      isStarred: starred,
      flagColor: 0,
    });
  }
  try {
    const outcome = await api.setMessagesFlags(
      summary.accountId,
      ids,
      undefined,
      starred,
    );
    if (outcome.failed > 0) {
      const current = useAppStore.getState();
      if (
        current.activeAccountId === summary.accountId &&
        current.activeMailboxId === viewMailboxId &&
        current.activeLocalView === viewLocal
      ) {
        current.setError(strings.mail.bulkPartial(outcome.failed));
      }
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
        idSet.has(item.id) && item.isStarred === starred
          ? {
              ...item,
              isStarred: !starred,
              flagColor: previousColorById.get(item.id) ?? item.flagColor,
            }
          : item,
      ),
      current.messageCursor,
      current.hasMoreMessages,
    );
    const open = current.selectedMessage;
    if (open && idSet.has(open.id) && open.isStarred === starred) {
      current.selectMessage({
        ...open,
        isStarred: !starred,
        flagColor: previousColorById.get(open.id) ?? open.flagColor,
      });
    }
    current.setError(errorText(cause));
  }
}
