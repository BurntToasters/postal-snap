import { api } from "./api";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationMessages } from "./threads";
import type { MessageSummary } from "./types";

const BULK_LIMIT = 200;

/**
 * Copies every loaded message in this mailbox conversation into another folder.
 * The originals stay where they are. Messages that are not loaded stay out.
 */
export async function copyLoadedConversation(
  summary: MessageSummary,
  mailboxId: number,
): Promise<void> {
  const store = useAppStore.getState();
  const members = conversationMessages(store.messages, summary);
  if (members.length < 2) return;
  const destination = store.mailboxes.find(
    (mailbox) =>
      mailbox.accountId === summary.accountId && mailbox.id === mailboxId,
  );
  if (!destination) {
    store.setError(strings.mail.noTargetFolder);
    return;
  }
  if (destination.id === summary.mailboxId) return;
  let copying = members.slice(0, BULK_LIMIT);
  if (members.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    if (!copying.some((item) => item.id === summary.id)) {
      copying = [...copying.slice(0, BULK_LIMIT - 1), summary];
    }
  }
  try {
    const outcome = await api.copyMessagesToMailbox(
      summary.accountId,
      copying.map((item) => item.id),
      destination.id,
    );
    const current = useAppStore.getState();
    if (current.activeAccountId !== summary.accountId) return;
    if (outcome.failed > 0)
      current.setError(strings.mail.bulkPartial(outcome.failed));
    else if (outcome.queued > 0) current.setError(strings.mail.copyQueued);
    window.dispatchEvent(
      new CustomEvent("postal:local-mail-changed", {
        detail: summary.accountId,
      }),
    );
  } catch (cause) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== summary.accountId) return;
    current.setError(String(cause));
  }
}
