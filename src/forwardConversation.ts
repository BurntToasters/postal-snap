import { api } from "./api";
import { forwardConversationBody } from "./components/composer/composerSeed";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationMessages } from "./threads";
import type { MessageSummary } from "./types";
import { BULK_LIMIT } from "./bulk";

/**
 * Opens a forward that quotes every loaded message in this mailbox
 * conversation, oldest first. Messages that are not loaded stay out.
 * Files stay with the original messages.
 */
export async function forwardLoadedConversation(
  summary: MessageSummary,
): Promise<void> {
  const store = useAppStore.getState();
  const members = conversationMessages(store.messages, summary);
  if (members.length < 2) return;
  let quoting = members.slice(0, BULK_LIMIT);
  if (members.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    if (!quoting.some((item) => item.id === summary.id)) {
      quoting = [...quoting.slice(0, BULK_LIMIT - 1), summary];
    }
  }
  const ordered = [...quoting].sort((left, right) =>
    left.receivedAt < right.receivedAt
      ? -1
      : left.receivedAt > right.receivedAt
        ? 1
        : left.id - right.id,
  );
  try {
    const open = store.selectedMessage;
    const details = await Promise.all(
      ordered.map((item) =>
        open && item.id === open.id && item.accountId === open.accountId
          ? Promise.resolve(open)
          : api.getMessage(item.accountId, item.id),
      ),
    );
    const current = useAppStore.getState();
    if (current.activeAccountId !== summary.accountId) return;
    const html = forwardConversationBody(details);
    if (!html) {
      current.setError(strings.composer.conversationTooLarge);
      return;
    }
    current.openComposer({
      sourceMessage: details[details.length - 1],
      composeMode: "forward",
      forwardMessages: details,
    });
  } catch (cause) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== summary.accountId) return;
    current.setError(String(cause));
  }
}

/** Forwards the checked messages, oldest first. Messages that are not loaded stay out. */
export async function forwardSelectedMessages(
  accountId: string,
  messageIds: number[],
): Promise<void> {
  const store = useAppStore.getState();
  const chosen = messageIds.flatMap((id) => {
    const item = store.messages.find(
      (message) => message.id === id && message.accountId === accountId,
    );
    return item ? [item] : [];
  });
  if (chosen.length === 0) return;
  if (chosen.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    return;
  }
  const mailboxId = store.activeMailboxId;
  const ordered = [...chosen].sort((left, right) =>
    left.receivedAt < right.receivedAt
      ? -1
      : left.receivedAt > right.receivedAt
        ? 1
        : left.id - right.id,
  );
  try {
    const open = store.selectedMessage;
    const details = await Promise.all(
      ordered.map((item) =>
        open && item.id === open.id && open.accountId === accountId
          ? Promise.resolve(open)
          : api.getMessage(accountId, item.id),
      ),
    );
    const current = useAppStore.getState();
    if (
      current.activeAccountId !== accountId ||
      current.activeMailboxId !== mailboxId ||
      current.activeLocalView
    )
      return;
    const newest = details[details.length - 1];
    if (!newest) return;
    if (details.length > 1) {
      const html = forwardConversationBody(details);
      if (!html) {
        current.setError(strings.composer.selectionTooLarge);
        return;
      }
      current.openComposer({
        sourceMessage: newest,
        composeMode: "forward",
        forwardMessages: details,
      });
      return;
    }
    current.openComposer({
      sourceMessage: newest,
      composeMode: "forward",
    });
  } catch (cause) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== accountId) return;
    current.setError(String(cause));
  }
}
