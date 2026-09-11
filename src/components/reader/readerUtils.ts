import { api } from "../../api";
import { formatFullMessageDate } from "../../format";
import { strings } from "../../i18n";
import { messageFrameDocument } from "../../security";
import { useAppStore } from "../../store";
import type { Attachment, MessageDetail } from "../../types";

export function moveCounts(
  mailboxes: ReturnType<typeof useAppStore.getState>["mailboxes"],
  message: NonNullable<
    ReturnType<typeof useAppStore.getState>["selectedMessage"]
  >,
  destinationId?: number,
) {
  return mailboxes.map((mailbox) => {
    if (mailbox.id === message.mailboxId)
      return {
        ...mailbox,
        totalCount: Math.max(0, mailbox.totalCount - 1),
        unreadCount: Math.max(
          0,
          mailbox.unreadCount - (message.isRead ? 0 : 1),
        ),
      };
    if (mailbox.id === destinationId)
      return {
        ...mailbox,
        totalCount: mailbox.totalCount + 1,
        unreadCount: mailbox.unreadCount + (message.isRead ? 0 : 1),
      };
    return mailbox;
  });
}

export async function hydrateInlineImages(
  doc: Document,
  accountId: string,
  messageId: number,
  attachments: Attachment[],
): Promise<void> {
  await Promise.all(
    [...doc.querySelectorAll<HTMLImageElement>("img[data-inline-cid]")].map(
      async (image) => {
        const contentId = normalizeContentId(image.dataset.inlineCid ?? "");
        const attachment = attachments.find(
          (item) => normalizeContentId(item.contentId ?? "") === contentId,
        );
        if (!attachment) return;
        try {
          image.src = await api.readMessageInlineImage(
            accountId,
            messageId,
            attachment.id,
          );
          image.removeAttribute("data-inline-cid");
        } catch {
          // A broken inline part should not prevent the message from opening.
        }
      },
    ),
  );
}

export function escapePrint(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeContentId(value: string): string {
  return value.trim().replace(/^cid:/i, "").replace(/^<|>$/g, "");
}

export function buildPrintDocument(
  message: MessageDetail,
  loadedHtml: { messageId: number; html: string } | undefined,
  textScale: number,
): string {
  const from = message.senderName
    ? `${message.senderName} <${message.senderAddress}>`
    : message.senderAddress;
  const header = [
    `<p><strong>${escapePrint(strings.reader.from)}</strong> ${escapePrint(from)}</p>`,
    `<p><strong>${escapePrint(strings.reader.to)}</strong> ${escapePrint(message.to.join(", ") || strings.reader.noRecipients)}</p>`,
    message.cc.length
      ? `<p><strong>${escapePrint(strings.reader.cc)}</strong> ${escapePrint(message.cc.join(", "))}</p>`
      : "",
    `<p><strong>${escapePrint(strings.reader.subject)}</strong> ${escapePrint(message.subject || strings.common.noSubject)}</p>`,
    `<p><strong>${escapePrint(strings.reader.date)}</strong> ${escapePrint(formatFullMessageDate(message.receivedAt))}</p>`,
  ].join("");
  const body =
    loadedHtml?.messageId === message.id && loadedHtml.html
      ? loadedHtml.html
      : `<pre style="white-space:pre-wrap;font:inherit">${escapePrint(message.textBody)}</pre>`;
  return messageFrameDocument(
    `<section style="margin:0 0 16px;padding:0 0 12px;border-bottom:1px solid #c8d2dc">${header}</section>${body}`,
    textScale,
  );
}
