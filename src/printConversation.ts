import { api } from "./api";
import {
  buildConversationPrintDocument,
  presentPrintDocument,
} from "./components/reader/readerUtils";
import { strings } from "./i18n";
import { sanitizeReceivedHtml } from "./security";
import { useAppStore } from "./store";
import { conversationMessages } from "./threads";
import type { MessageDetail, MessageSummary } from "./types";
import { BULK_LIMIT } from "./bulk";

function printHtml(
  detail: MessageDetail,
  openBody?: { messageId: number; html?: string },
): string | undefined {
  if (openBody && detail.id === openBody.messageId) return openBody.html;
  if (!detail.htmlBody) return undefined;
  return sanitizeReceivedHtml(detail.htmlBody).html;
}

/**
 * Prints every loaded message in this mailbox conversation, oldest first.
 * Messages that are not loaded stay out of the page.
 */
export async function printLoadedConversation(
  summary: MessageSummary,
  openBody?: { messageId: number; html?: string },
): Promise<void> {
  const store = useAppStore.getState();
  const members = conversationMessages(store.messages, summary);
  if (members.length < 2) return;
  let printing = members.slice(0, BULK_LIMIT);
  if (members.length > BULK_LIMIT) {
    store.setError(strings.mail.bulkTooMany);
    if (!printing.some((item) => item.id === summary.id)) {
      printing = [...printing.slice(0, BULK_LIMIT - 1), summary];
    }
  }
  const ordered = [...printing].sort((left, right) =>
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
        open && item.id === open.id
          ? Promise.resolve(open)
          : api.getMessage(item.accountId, item.id),
      ),
    );
    const current = useAppStore.getState();
    if (current.activeAccountId !== summary.accountId) return;
    presentPrintDocument(
      buildConversationPrintDocument(
        details.map((detail) => ({
          message: detail,
          htmlBody: printHtml(detail, openBody),
        })),
        current.settings.textScale,
      ),
    );
  } catch (cause) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== summary.accountId) return;
    current.setError(String(cause));
  }
}

/** Prints the checked messages, oldest first. Messages that are not loaded stay out. */
export async function printSelectedMessages(
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
    presentPrintDocument(
      buildConversationPrintDocument(
        details.map((detail) => ({
          message: detail,
          htmlBody: printHtml(detail),
        })),
        current.settings.textScale,
      ),
    );
  } catch (cause) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== accountId) return;
    current.setError(String(cause));
  }
}
