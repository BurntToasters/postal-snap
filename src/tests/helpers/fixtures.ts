import type {
  AccountSummary,
  MailboxSummary,
  MessageDetail,
  MessageSummary,
  ProviderKind,
} from "../../types";

export function makeAccount(
  id = "account-1",
  provider: ProviderKind = "manual",
  overrides: Partial<AccountSummary> = {},
): AccountSummary {
  const finalId = overrides.id ?? id;
  const finalProvider = overrides.provider ?? provider;
  const isDefaultId = finalId === "account-1";
  return {
    email: isDefaultId ? "sam@example.test" : `${finalId}@example.test`,
    displayName: isDefaultId ? "Sam" : finalId,
    syncState: "idle",
    ...overrides,
    id: finalId,
    provider: finalProvider,
  };
}

export function makeMailbox(
  overrides: Partial<MailboxSummary> = {},
): MailboxSummary {
  return {
    id: 1,
    accountId: "account-1",
    name: "INBOX",
    displayName: "Inbox",
    role: "inbox",
    unreadCount: 2,
    totalCount: 2,
    ...overrides,
  };
}

export function makeMessage(
  overrides: Partial<MessageSummary> = {},
): MessageSummary {
  const id = overrides.id ?? 1;
  const uid = overrides.uid ?? id;
  const messageId =
    overrides.messageId ??
    (id === 1
      ? "<first@example.test>"
      : id === 2
        ? "<second@example.test>"
        : `<${id}@example.test>`);
  const subject =
    overrides.subject ??
    (id === 1
      ? "First message"
      : id === 2
        ? "Second message"
        : `Subject ${id}`);
  const preview =
    overrides.preview ??
    (id === 1 ? "First preview" : id === 2 ? "Second preview" : "");
  return {
    accountId: "account-1",
    mailboxId: 1,
    senderName: "Jane",
    senderAddress: "jane@example.test",
    recipients: "sam@example.test",
    receivedAt: "2026-08-18T12:00:00Z",
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    size: 100,
    ...overrides,
    id,
    uid,
    messageId,
    subject,
    preview,
  };
}

export function messageDetail(
  summary: MessageSummary,
  overrides: Partial<MessageDetail> = {},
): MessageDetail {
  return {
    ...summary,
    to: [summary.recipients],
    cc: [],
    replyTo: null,
    textBody: summary.preview,
    htmlBody: null,
    remoteImagesBlocked: false,
    attachments: [],
    ...overrides,
  };
}
