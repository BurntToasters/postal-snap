import { api } from "./api";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationMessages } from "./threads";
import type { MessageSummary } from "./types";
import { BULK_LIMIT } from "./bulk";

/** Snoozes every loaded message in this mailbox conversation until the same time. */
export async function snoozeLoadedConversation(
  summary: MessageSummary,
  untilIso: string,
): Promise<number[] | undefined> {
  const store = useAppStore.getState();
  const members = conversationMessages(store.messages, summary);
  if (members.length < 2) return undefined;
  let snoozing = members.slice(0, BULK_LIMIT);
  if (members.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    if (!snoozing.some((item) => item.id === summary.id)) {
      snoozing = [...snoozing.slice(0, BULK_LIMIT - 1), summary];
    }
  }
  const ids = snoozing.map((item) => item.id);
  await api.snoozeMessages(summary.accountId, ids, untilIso);
  return ids;
}
