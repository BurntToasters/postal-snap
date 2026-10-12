import type { MessageSummary } from "./types";

/** Cached mailbox browse. Search keeps its own operators. */
export type MessageListFilter =
  | "all"
  | "unread"
  | "starred"
  | "attachments"
  | "pinned"
  | "toMe"
  | "invitations";

const filters = new Set<string>([
  "all",
  "unread",
  "starred",
  "attachments",
  "pinned",
  "toMe",
  "invitations",
]);

/** A saved mailbox filter, or every message when the value is unknown. */
export function rememberedFilter(value: string | undefined): MessageListFilter {
  return value && filters.has(value) ? (value as MessageListFilter) : "all";
}

export function matchesListFilter(
  message: MessageSummary,
  filter: MessageListFilter,
): boolean {
  if (filter === "unread") return !message.isRead;
  if (filter === "starred") return message.isStarred;
  if (filter === "attachments") return message.hasAttachments;
  if (filter === "pinned") return Boolean(message.pinned);
  if (filter === "toMe") return Boolean(message.toMe);
  if (filter === "invitations") return Boolean(message.hasCalendar);
  return true;
}
