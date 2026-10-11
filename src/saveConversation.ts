import { api } from "./api";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationMessages } from "./threads";
import type { MessageSummary } from "./types";

const BULK_LIMIT = 200;

/**
 * Saves every regular file from the loaded messages in this conversation
 * into one folder. Messages that are not loaded stay out of the save.
 */
export async function saveLoadedConversationFiles(
  summary: MessageSummary,
): Promise<void> {
  const store = useAppStore.getState();
  const members = conversationMessages(store.messages, summary);
  if (members.length < 2 || !members.some((item) => item.hasAttachments))
    return;
  let saving = members.slice(0, BULK_LIMIT);
  if (members.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    if (!saving.some((item) => item.id === summary.id)) {
      saving = [...saving.slice(0, BULK_LIMIT - 1), summary];
    }
  }
  try {
    await api.saveConversationAttachments(
      summary.accountId,
      saving.map((item) => item.id),
    );
  } catch (cause) {
    useAppStore.getState().setError(String(cause));
  }
}

/** Saves each checked message as an `.eml` file in one folder. */
export async function saveSelectedMessages(
  accountId: string,
  messageIds: number[],
): Promise<void> {
  const store = useAppStore.getState();
  const ids = messageIds.filter((id) =>
    store.messages.some(
      (message) => message.id === id && message.accountId === accountId,
    ),
  );
  if (ids.length === 0) return;
  if (ids.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    return;
  }
  try {
    await api.saveMessagesEml(accountId, ids);
  } catch (cause) {
    useAppStore.getState().setError(String(cause));
  }
}

/** Saves files from the checked messages into one folder. Messages without files are left out. */
export async function saveSelectedFiles(
  accountId: string,
  messageIds: number[],
): Promise<void> {
  const store = useAppStore.getState();
  const ids = messageIds.filter((id) => {
    const item = store.messages.find(
      (message) => message.id === id && message.accountId === accountId,
    );
    return Boolean(item?.hasAttachments);
  });
  if (ids.length === 0) {
    store.setError(strings.reader.noSelectedFiles);
    return;
  }
  if (ids.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    return;
  }
  try {
    await api.saveConversationAttachments(accountId, ids);
  } catch (cause) {
    useAppStore.getState().setError(String(cause));
  }
}
