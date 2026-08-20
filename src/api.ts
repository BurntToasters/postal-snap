import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { normalizeIpcError } from "./errors";
import type {
  AccountChangeEvent,
  AccountSetupRequest,
  AccountSummary,
  AppSettings,
  CacheUsage,
  ComposeAttachment,
  ComposeDraft,
  DistributionChannel,
  DraftSaveOutcome,
  DraftSummary,
  DraftSyncEvent,
  MailboxSummary,
  MessageDetail,
  MessageCursor,
  MessageChangeEvent,
  MessagePage,
  MessageSummary,
  OutboxSummary,
  OutboxChangeEvent,
  SearchQuery,
  SyncState,
  SendOutcome,
} from "./types";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!inTauri())
    throw new Error(
      "Postal Snap native service is unavailable in browser preview.",
    );
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    throw normalizeIpcError(cause);
  }
}

export const api = {
  listAccounts: () => call<AccountSummary[]>("list_accounts"),
  testAccount: (request: AccountSetupRequest) =>
    call<void>("test_account", { request }),
  addAccount: (request: AccountSetupRequest) =>
    call<AccountSummary>("add_account", { request }),
  removeAccount: (accountId: string) =>
    call<void>("remove_account", { accountId }),
  listMailboxes: (accountId: string) =>
    call<MailboxSummary[]>("list_mailboxes", { accountId }),
  syncAccount: (accountId: string) => call<void>("sync_account", { accountId }),
  listMessages: (
    accountId: string,
    mailboxId: number,
    cursor?: MessageCursor,
    limit = 100,
  ) =>
    call<MessagePage>("list_messages", { accountId, mailboxId, cursor, limit }),
  getMessage: (accountId: string, messageId: number) =>
    call<MessageDetail>("get_message", { accountId, messageId }),
  setMessageFlags: (
    accountId: string,
    messageId: number,
    isRead?: boolean,
    isStarred?: boolean,
  ) =>
    call<void>("set_message_flags", {
      accountId,
      messageId,
      isRead,
      isStarred,
    }),
  moveMessage: (accountId: string, messageId: number, role: string) =>
    call<void>("move_message", { accountId, messageId, role }),
  moveMessageToMailbox: (
    accountId: string,
    messageId: number,
    destinationMailboxId: number,
  ) =>
    call<void>("move_message_to_mailbox", {
      accountId,
      messageId,
      destinationMailboxId,
    }),
  searchCached: (query: SearchQuery) =>
    call<MessageSummary[]>("search_cached_messages", { query }),
  searchServer: (query: SearchQuery) =>
    call<MessageSummary[]>("search_server_messages", { query }),
  saveDraft: (draft: ComposeDraft) =>
    call<DraftSaveOutcome>("save_draft", { draft }),
  listDrafts: (accountId: string) =>
    call<DraftSummary[]>("list_drafts", { accountId }),
  getDraft: (draftId: string, accountId: string) =>
    call<ComposeDraft>("get_draft", { draftId, accountId }),
  deleteDraft: (draftId: string, accountId: string) =>
    call<void>("delete_draft", { draftId, accountId }),
  sendMessage: (draft: ComposeDraft) =>
    call<SendOutcome>("send_message", { draft }),
  listOutbox: (accountId: string) =>
    call<OutboxSummary[]>("list_outbox", { accountId }),
  getOutbox: (outboxId: string, accountId: string) =>
    call<ComposeDraft>("get_outbox", { outboxId, accountId }),
  retryOutbox: (outboxId: string, accountId: string) =>
    call<SendOutcome>("retry_outbox", { outboxId, accountId }),
  retrySentCopy: (outboxId: string, accountId: string) =>
    call<SendOutcome>("retry_sent_copy", { outboxId, accountId }),
  deleteOutbox: (outboxId: string, accountId: string) =>
    call<void>("delete_outbox", { outboxId, accountId }),
  saveAttachment: (
    accountId: string,
    messageId: number,
    attachmentId: string,
    suggestedFilename: string,
  ) =>
    call<void>("save_attachment", {
      messageId,
      accountId,
      attachmentId,
      suggestedFilename,
    }),
  prepareForwardAttachments: (accountId: string, messageId: number) =>
    call<ComposeAttachment[]>("prepare_forward_attachments", {
      accountId,
      messageId,
    }),
  chooseAttachments: (accountId: string, inline: boolean) =>
    call<ComposeAttachment[]>("choose_attachments", { accountId, inline }),
  fetchRemoteImage: (url: string) =>
    call<string>("fetch_remote_image", { url }),
  readMessageInlineImage: (
    accountId: string,
    messageId: number,
    attachmentId: string,
  ) =>
    call<string>("read_message_inline_image", {
      accountId,
      messageId,
      attachmentId,
    }),
  readComposeImage: (accountId: string, token: string) =>
    call<string>("read_compose_image", { accountId, token }),
  releaseComposeAttachments: (accountId: string, tokens: string[]) =>
    call<void>("release_compose_attachments", { accountId, tokens }),
  getSettings: () => call<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) =>
    call<AppSettings>("save_settings", { settings }),
  getStartupNotice: () => call<string | null>("get_startup_notice"),
  cacheUsage: () => call<CacheUsage>("get_cache_usage"),
  clearCache: () => call<void>("clear_downloaded_mail"),
  distribution: () => call<DistributionChannel>("get_distribution_channel"),
  async onSyncState(handler: (state: SyncState) => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<SyncState>("sync-state", ({ payload }) => handler(payload));
  },
  async onFolderCountsChanged(
    handler: (event: AccountChangeEvent) => void,
  ): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<AccountChangeEvent>("folder-counts-changed", ({ payload }) =>
      handler(payload),
    );
  },
  async onMessageChanged(
    handler: (event: MessageChangeEvent) => void,
  ): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<MessageChangeEvent>("message-changed", ({ payload }) =>
      handler(payload),
    );
  },
  async onDraftSyncChanged(
    handler: (event: DraftSyncEvent) => void,
  ): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<DraftSyncEvent>("draft-sync-changed", ({ payload }) =>
      handler(payload),
    );
  },
  async onOutboxChanged(
    handler: (event: OutboxChangeEvent) => void,
  ): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<OutboxChangeEvent>("outbox-changed", ({ payload }) =>
      handler(payload),
    );
  },
  async onMenuAction(handler: (action: string) => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<string>("menu-action", ({ payload }) => handler(payload));
  },
};

export { inTauri };
