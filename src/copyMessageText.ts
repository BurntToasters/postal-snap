import { api } from "./api";
import { readableMessageText } from "./components/reader/readerUtils";
import { strings } from "./i18n";
import { useAppStore } from "./store";
import { conversationMessages } from "./threads";
import type { MessageSummary } from "./types";

const BULK_LIMIT = 200;

function oldestFirst(messages: MessageSummary[]): MessageSummary[] {
  return [...messages].sort((left, right) =>
    left.receivedAt < right.receivedAt
      ? -1
      : left.receivedAt > right.receivedAt
        ? 1
        : left.id - right.id,
  );
}

function labeledText(
  detail: {
    subject: string;
    textBody?: string | null;
    htmlBody?: string | null;
  },
  labeled: boolean,
): string | undefined {
  const text = readableMessageText(detail);
  if (!text) return undefined;
  if (!labeled) return text;
  const subject = detail.subject.trim();
  return subject ? `${subject}\n\n${text}` : text;
}

async function copyOrderedMessages(
  accountId: string,
  ordered: MessageSummary[],
  mailboxId: number | undefined,
  emptyError: string,
): Promise<void> {
  const open = useAppStore.getState().selectedMessage;
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
  const labeled = details.length > 1;
  const blocks = details.flatMap((detail) => {
    const text = labeledText(detail, labeled);
    return text ? [text] : [];
  });
  if (blocks.length === 0) {
    current.setError(emptyError);
    return;
  }
  await navigator.clipboard.writeText(blocks.join("\n\n"));
}

/** Copies the checked messages, oldest first. A message with no text is left out. */
export async function copySelectedMessageText(
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
  try {
    await copyOrderedMessages(
      accountId,
      oldestFirst(chosen),
      store.activeMailboxId,
      strings.reader.noSelectedText,
    );
  } catch (cause) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== accountId) return;
    current.setError(String(cause));
  }
}

/**
 * Copies every loaded message in this mailbox conversation, oldest first.
 * Messages that are not loaded stay out. A message with no text is left out.
 */
export async function copyLoadedConversationText(
  summary: MessageSummary,
): Promise<void> {
  const store = useAppStore.getState();
  const members = conversationMessages(store.messages, summary);
  if (members.length < 2) return;
  let copying = members.slice(0, BULK_LIMIT);
  if (members.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    if (!copying.some((item) => item.id === summary.id)) {
      copying = [...copying.slice(0, BULK_LIMIT - 1), summary];
    }
  }
  try {
    await copyOrderedMessages(
      summary.accountId,
      oldestFirst(copying),
      store.activeMailboxId,
      strings.reader.noConversationText,
    );
  } catch (cause) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== summary.accountId) return;
    current.setError(String(cause));
  }
}
