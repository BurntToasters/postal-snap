import { api } from "../../api";
import { addressMailbox } from "../../contextMenu";
import {
  formatBytes,
  formatFullMessageDate,
  notableArrival,
} from "../../format";
import { listPostAddress } from "../composer/composerSeed";
import { conflictingNameAddress } from "../../senderName";
import { strings } from "../../i18n";
import { messageFrameDocument, sanitizeReceivedHtml } from "../../security";
import { useAppStore } from "../../store";
import type { Attachment, MessageDetail } from "../../types";

/** Case-insensitive matches in visible text, without overlapping. */
export function countTextMatches(root: Node, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length < 1) return 0;
  let count = 0;
  const walker = root.ownerDocument?.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  if (!walker) return 0;
  while (walker.nextNode()) {
    const text = (walker.currentNode.textContent ?? "").toLowerCase();
    let index = 0;
    while (index <= text.length) {
      const found = text.indexOf(needle, index);
      if (found < 0) break;
      count += 1;
      index = found + needle.length;
    }
  }
  return count;
}

/** Select the 1-based match in this document and scroll it into view. */
export function selectTextMatch(
  root: HTMLElement,
  query: string,
  which: number,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle || which < 1) return false;
  const doc = root.ownerDocument;
  const selection = doc.getSelection();
  selection?.removeAllRanges();
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = (node.textContent ?? "").toLowerCase();
    let index = 0;
    while (index <= text.length) {
      const found = text.indexOf(needle, index);
      if (found < 0) break;
      seen += 1;
      if (seen === which) {
        const range = doc.createRange();
        range.setStart(node, found);
        range.setEnd(node, found + needle.length);
        selection?.addRange(range);
        (node.parentElement as HTMLElement | null)?.scrollIntoView({
          block: "center",
        });
        return true;
      }
      index = found + needle.length;
    }
  }
  return false;
}

/** Remaining scroll in one direction. Null when the document has no layout yet. */
export function scrollRoom(
  scrollTop: number,
  scrollHeight: number,
  viewport: number,
  direction: 1 | -1,
): number | null {
  if (scrollHeight <= 0 || viewport <= 0) return null;
  const max = Math.max(0, scrollHeight - viewport);
  const top = Math.min(Math.max(0, scrollTop), max);
  return direction > 0 ? max - top : top;
}

const QUOTE_CLASS =
  /(?:^|\s)(?:gmail_quote|gmail_attr|protonmail_quote|yahoo_quoted|moz-cite-prefix)(?:\s|$)/i;
const WROTE_LINE = /\bwrote:\s*$/i;

function meaningfulChildren(parent: ParentNode): ChildNode[] {
  return [...parent.childNodes].filter(
    (node) =>
      node.nodeType !== Node.TEXT_NODE || Boolean(node.textContent?.trim()),
  );
}

function isQuotedElement(node: ChildNode): node is Element {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (element.tagName === "BLOCKQUOTE") return true;
  return QUOTE_CLASS.test(element.getAttribute("class") ?? "");
}

/** Hide a trailing reply quote behind a disclosure. A message that is only a quote stays visible. */
function collapseTrailingQuote(
  parent: HTMLElement,
  doc: Document,
  label: string,
): boolean {
  const children = meaningfulChildren(parent);
  if (children.length < 2) return false;
  let start = children.length;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const node = children[index];
    if (isQuotedElement(node)) {
      start = index;
      continue;
    }
    if (
      start < children.length &&
      node.nodeType === Node.ELEMENT_NODE &&
      WROTE_LINE.test(node.textContent ?? "")
    ) {
      start = index;
      continue;
    }
    break;
  }
  if (start === 0 || start === children.length) return false;
  const quoted = children.slice(start);
  const quotedText = quoted.map((node) => node.textContent ?? "").join("");
  if (quotedText.trim().length < 40) return false;
  const details = doc.createElement("details");
  details.className = "quoted-mail";
  const summary = doc.createElement("summary");
  summary.textContent = label;
  details.append(summary);
  for (const node of quoted) details.append(node);
  parent.append(details);
  return true;
}

export function collapseQuotedMail(html: string, label: string): string {
  if (!html || !label.trim()) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (collapseTrailingQuote(doc.body, doc, label)) return doc.body.innerHTML;
  const only = meaningfulChildren(doc.body);
  if (
    only.length === 1 &&
    only[0].nodeType === Node.ELEMENT_NODE &&
    (only[0] as Element).tagName === "DIV" &&
    collapseTrailingQuote(only[0] as HTMLElement, doc, label)
  ) {
    return doc.body.innerHTML;
  }
  return html;
}

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

/** To and Cc addresses, one per line, without blanks or repeated addresses. */
/** First two addresses, then a count when the line would be long. */
export function recipientPreview(addresses: readonly string[]): string {
  if (addresses.length <= 2) return addresses.join(", ");
  return strings.reader.recipientsAndMore(
    addresses.slice(0, 2).join(", "),
    addresses.length - 2,
  );
}

export function recipientLines(
  to: readonly string[],
  cc: readonly string[] = [],
  bcc: readonly string[] = [],
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const address of [...to, ...cc, ...bcc]) {
    const trimmed = address.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    lines.push(trimmed);
  }
  return lines.join("\n");
}

/** The letter as text: the plain part, or the words left after sanitizing HTML. */
export function readableMessageText(message: {
  textBody?: string | null;
  htmlBody?: string | null;
}): string {
  const text = message.textBody?.replace(/\r\n/g, "\n").trim() ?? "";
  if (text) return text;
  const html = message.htmlBody?.trim();
  if (!html) return "";
  return htmlToPlainText(sanitizeReceivedHtml(html).html);
}

/** Plain text from sanitized HTML, for the reader’s text view. */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style").forEach((node) => node.remove());
  doc.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  doc
    .querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote")
    .forEach((node) => node.append("\n"));
  return (doc.body.textContent ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when sanitized HTML still shows text or an image. */
export function hasVisibleHtml(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (
    (doc.body.textContent ?? "").trim().length > 0 ||
    doc.body.querySelector("img, hr") !== null
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

export function messagePrintSection(
  message: MessageDetail,
  htmlBody?: string,
): string {
  const from = message.senderName
    ? `${message.senderName} <${message.senderAddress}>`
    : message.senderAddress;
  const nameConflict = conflictingNameAddress(
    message.senderName,
    message.senderAddress,
  );
  const listAddress = listPostAddress(message.listPost);
  const arrived = notableArrival(message.receivedAt, message.arrivedAt);
  const header = [
    `<p><strong>${escapePrint(strings.reader.from)}</strong> ${escapePrint(from)}</p>`,
    nameConflict
      ? `<p>${escapePrint(strings.reader.nameIncludesDifferentAddress(nameConflict))}</p>`
      : "",
    listAddress
      ? `<p>${escapePrint(strings.reader.mailingList(listAddress))}</p>`
      : "",
    `<p><strong>${escapePrint(strings.reader.to)}</strong> ${escapePrint(message.to.join(", ") || strings.reader.noRecipients)}</p>`,
    message.cc.length
      ? `<p><strong>${escapePrint(strings.reader.cc)}</strong> ${escapePrint(message.cc.join(", "))}</p>`
      : "",
    message.bcc?.length
      ? `<p><strong>${escapePrint(strings.reader.bcc)}</strong> ${escapePrint(message.bcc.join(", "))}</p>`
      : "",
    `<p><strong>${escapePrint(strings.reader.subject)}</strong> ${escapePrint(message.subject || strings.common.noSubject)}</p>`,
    `<p><strong>${escapePrint(strings.reader.date)}</strong> ${escapePrint(formatFullMessageDate(message.receivedAt))}</p>`,
    arrived
      ? `<p><strong>${escapePrint(strings.reader.arrived)}</strong> ${escapePrint(formatFullMessageDate(arrived))}</p>`
      : "",
    printedFiles(message),
  ].join("");
  const body = htmlBody
    ? htmlBody
    : `<pre style="white-space:pre-wrap;font:inherit">${escapePrint(message.textBody)}</pre>`;
  return `<section style="margin:0 0 16px;padding:0 0 12px;border-bottom:1px solid #c8d2dc">${header}</section>${body}`;
}

export function buildPrintDocument(
  message: MessageDetail,
  loadedHtml: { messageId: number; html: string } | undefined,
  textScale: number,
  sanitizedHtml?: string,
): string {
  const htmlBody =
    loadedHtml?.messageId === message.id && loadedHtml.html
      ? loadedHtml.html
      : sanitizedHtml;
  return messageFrameDocument(
    messagePrintSection(message, htmlBody),
    textScale,
  );
}

/** One print document for a loaded conversation, oldest message first. */
export function buildConversationPrintDocument(
  messages: Array<{ message: MessageDetail; htmlBody?: string }>,
  textScale: number,
): string {
  const body = messages
    .map((entry, index) => {
      const section = messagePrintSection(entry.message, entry.htmlBody);
      const page = index === 0 ? "" : ' style="break-before:page"';
      return `<article${page}>${section}</article>`;
    })
    .join("");
  return messageFrameDocument(body, textScale);
}

export function presentPrintDocument(html: string): void {
  document.querySelector(".print-host")?.remove();
  if (document.documentElement.dataset.platform === "macos") {
    // WebKit on macOS ignores print() from a frame, so print the window
    // natively and let @media print show only this sandboxed host. It
    // stays until the next print because the sheet renders pages later.
    const host = document.createElement("div");
    host.className = "print-host";
    host.setAttribute("aria-hidden", "true");
    const printer = document.createElement("iframe");
    printer.setAttribute("sandbox", "allow-same-origin");
    printer.tabIndex = -1;
    printer.srcdoc = html;
    printer.addEventListener("load", () => {
      const height = printer.contentDocument?.documentElement.scrollHeight;
      printer.style.height = `${height ?? 0}px`;
      void api.printWebview().catch((cause) => {
        useAppStore.getState().setError(String(cause));
      });
    });
    host.appendChild(printer);
    document.body.appendChild(host);
    return;
  }
  const printer = document.createElement("iframe");
  // Intentionally unsandboxed: the parent calls contentWindow.print(), but a
  // sandboxed srcdoc frame is cross-origin (print() is not exposed on the
  // cross-origin WindowProxy) and its modals flag blocks window.print(), so
  // sandbox="allow-modals" alone would break printing. The document wraps
  // sanitized HTML in a restrictive CSP, and this frame is removed
  // immediately after printing.
  printer.setAttribute("aria-hidden", "true");
  printer.style.position = "fixed";
  printer.style.width = "0";
  printer.style.height = "0";
  printer.style.border = "0";
  printer.srcdoc = html;
  printer.addEventListener("load", () => {
    printer.contentWindow?.focus();
    printer.contentWindow?.print();
    window.setTimeout(() => printer.remove(), 1500);
  });
  document.body.appendChild(printer);
}

/** Regular files only. A picture inside the letter stays in the body. */
function printedFiles(message: MessageDetail): string {
  const files = message.attachments.filter((item) => !item.inline);
  if (files.length === 0) return "";
  const names = files
    .map(
      (item) =>
        `${escapePrint(item.filename)} (${escapePrint(formatBytes(item.size))})`,
    )
    .join(", ");
  return `<p><strong>${escapePrint(strings.reader.attachments)}</strong> ${names}</p>`;
}

function ownMailbox(value: string | undefined): string | undefined {
  const mailbox = value ? addressMailbox(value)?.toLowerCase() : undefined;
  return mailbox?.includes("@") ? mailbox : undefined;
}

/** Whether the open message should ask before a read receipt is sent. */
export function readReceiptState(
  message: {
    dispositionTo?: string;
    receiptChoice?: string;
    senderAddress: string;
  },
  account: { email: string; aliases?: string[] } | undefined,
  mailboxRole: string | undefined,
): "ask" | "sent" | null {
  const asked = ownMailbox(message.dispositionTo);
  if (!asked || !account || mailboxRole === "sent" || mailboxRole === "junk") {
    return null;
  }
  const ours = new Set(
    [account.email, ...(account.aliases ?? [])]
      .map((value) => ownMailbox(value))
      .filter((value): value is string => Boolean(value)),
  );
  if (ours.has(asked) || ours.has(ownMailbox(message.senderAddress) ?? "")) {
    return null;
  }
  if (message.receiptChoice === "sent") return "sent";
  if (message.receiptChoice) return null;
  return "ask";
}
