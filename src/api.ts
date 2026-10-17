import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { normalizeIpcError } from "./errors";
import type { MessageListFilter } from "./listFilter";
import type { MessageListSort } from "./listSort";
import type {
  AccountConnection,
  BridgeCertificate,
  FolderAssignment,
  ServerConfig,
  AccountChangeEvent,
  AccountInboxCount,
  AccountRemovalOutcome,
  AccountRemovalImpact,
  AccountSetupRequest,
  AccountSummary,
  ArchiveSource,
  BodyFormat,
  ComposeDragEvent,
  MailSettingsDiscovery,
  AppSettings,
  CachePolicy,
  CacheUsage,
  ComposeAttachment,
  ComposeDraft,
  DistributionChannel,
  DraftSaveOutcome,
  DraftSummary,
  DraftSyncEvent,
  MailboxSummary,
  MessageDetail,
  MessageSource,
  MessageCursor,
  AttachmentPreview,
  BulkOutcome,
  RecipientSuggestion,
  ExternalLinkCheck,
  LicenseCredits,
  RemoteImageResult,
  MessageChangeEvent,
  MessagePage,
  MessageSummary,
  OfflineOperationsDroppedEvent,
  OutboxSummary,
  OutboxChangeEvent,
  SnoozedSummary,
  FilterMatchPreview,
  FilterRule,
  SearchQuery,
  SyncState,
  SyncProgress,
  SendOutcome,
} from "./types";

// Settings mutations share one native write queue. This keeps an autosave from
// racing an import/reset dialog and preserves invocation order across views.
let settingsQueue: Promise<unknown> = Promise.resolve();
let settingsGeneration = 0;

function queueSettings<T>(
  operation: () => Promise<T>,
  generation = settingsGeneration,
  staleOperation?: () => Promise<T>,
): Promise<T> {
  const next = settingsQueue
    .catch(() => undefined)
    .then(() =>
      generation === settingsGeneration || !staleOperation
        ? operation()
        : staleOperation(),
    );
  settingsQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type NativeCommand =
  | "get_account_connection"
  | "update_account_connection"
  | "import_bridge_certificate"
  | "approve_bridge_certificate"
  | "remove_bridge_certificate"
  | "get_folder_assignments"
  | "set_folder_assignment"
  | "list_accounts"
  | "get_message_source"
  | "save_message_eml"
  | "unsubscribe_one_click"
  | "test_account"
  | "discover_mail_settings"
  | "test_saved_account"
  | "update_account_password"
  | "add_account"
  | "remove_account"
  | "get_account_removal_impact"
  | "erase_all_data"
  | "update_account_display_name"
  | "update_account_reply_to"
  | "update_account_signature"
  | "update_account_default_body_format"
  | "attach_dropped_files"
  | "get_account_inbox_counts"
  | "list_mailboxes"
  | "list_all_mailboxes"
  | "load_older_messages"
  | "sync_account"
  | "sync_all_accounts"
  | "list_messages"
  | "get_message"
  | "download_full_message"
  | "set_message_flags"
  | "move_message"
  | "move_message_to_mailbox"
  | "copy_message_to_mailbox"
  | "copy_messages_to_mailbox"
  | "set_messages_flags"
  | "set_messages_pinned"
  | "move_messages_to_mailbox"
  | "undo_deferred"
  | "commit_deferred"
  | "set_visible_folder"
  | "mark_mailbox_read"
  | "suggest_recipients"
  | "create_folder"
  | "rename_folder"
  | "move_folder"
  | "delete_folder"
  | "delete_trash_messages"
  | "empty_trash"
  | "empty_junk"
  | "search_cached_messages"
  | "search_server_messages"
  | "find_cached_message"
  | "snooze_messages"
  | "stage_pasted_image"
  | "list_recent_searches"
  | "remember_search"
  | "forget_recent_search"
  | "forget_recent_searches"
  | "set_unread_badge"
  | "save_draft"
  | "list_drafts"
  | "get_draft"
  | "delete_draft"
  | "send_message"
  | "send_read_receipt"
  | "decline_read_receipt"
  | "list_outbox"
  | "get_outbox"
  | "restore_outbox"
  | "retry_outbox"
  | "retry_sent_copy"
  | "retry_archive_after_send"
  | "dismiss_archive_warning"
  | "send_scheduled_outbox"
  | "snooze_message"
  | "unsnooze_message"
  | "list_snoozed"
  | "list_filter_rules"
  | "mute_conversation"
  | "unmute_conversation"
  | "create_filter_rule"
  | "update_filter_rule"
  | "delete_filter_rule"
  | "update_account_color"
  | "get_account_cache_policy"
  | "set_account_cache_policy"
  | "get_account_cache_usage"
  | "clear_account_downloads"
  | "reorder_accounts"
  | "reorder_filter_rules"
  | "preview_filter_rule"
  | "delete_outbox"
  | "save_attachment"
  | "save_all_attachments"
  | "save_chosen_attachments"
  | "save_conversation_attachments"
  | "save_messages_eml"
  | "preview_attachment"
  | "prepare_forward_attachments"
  | "prepare_reply_attachments"
  | "prepare_forwarded_message"
  | "choose_attachments"
  | "fetch_remote_image"
  | "inspect_external_url"
  | "open_external_url"
  | "open_help_url"
  | "read_message_inline_image"
  | "read_compose_image"
  | "release_compose_attachments"
  | "get_settings"
  | "save_settings"
  | "set_mail_shortcut_guard"
  | "set_composer_open"
  | "export_settings"
  | "import_settings"
  | "get_startup_notice"
  | "get_startup_error"
  | "get_cache_usage"
  | "clear_downloaded_mail"
  | "retry_attachment_cleanup"
  | "get_distribution_channel"
  | "get_beta_updater_target"
  | "get_license_credits"
  | "get_sync_progress"
  | "discover_account_aliases"
  | "update_account_aliases"
  | "show_native_confirm"
  | "show_native_message"
  | "print_webview"
  | "relaunch_app"
  | "quit_app"
  | "tray_is_active"
  | "prepare_update_relaunch"
  | "clear_update_relaunch"
  | "get_update_relaunch"
  | "set_update_ready"
  | "background_update_allowed"
  | "begin_update_install"
  | "release_update_install"
  | "schedule_background_update"
  | "mark_update_checked"
  | "supports_workspace_window_fx"
  | "accessibility_reduce_transparency"
  | "set_snap_overlay_bounds"
  | "set_workspace_window_fx";

async function call<T>(
  command: NativeCommand,
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
  getAccountConnection: (accountId: string) =>
    call<AccountConnection>("get_account_connection", { accountId }),
  updateAccountConnection: (
    accountId: string,
    imap: ServerConfig,
    smtp: ServerConfig,
    confirmIdentityChange = false,
  ) =>
    call<AccountConnection>("update_account_connection", {
      accountId,
      imap,
      smtp,
      confirmIdentityChange,
    }),
  importBridgeCertificate: () =>
    call<BridgeCertificate | null>("import_bridge_certificate"),
  approveBridgeCertificate: (reference: string, accountId?: string) =>
    call<string>("approve_bridge_certificate", {
      reference,
      accountId: accountId ?? null,
    }),
  removeBridgeCertificate: (accountId: string) =>
    call<void>("remove_bridge_certificate", { accountId }),
  getFolderAssignments: (accountId: string) =>
    call<FolderAssignment[]>("get_folder_assignments", { accountId }),
  setFolderAssignment: (
    accountId: string,
    role: FolderAssignment["role"],
    mailboxId: number | null,
  ) =>
    call<FolderAssignment[]>("set_folder_assignment", {
      accountId,
      role,
      mailboxId,
    }),
  listAccounts: () => call<AccountSummary[]>("list_accounts"),
  reorderAccounts: (accountIds: string[]) =>
    call<AccountSummary[]>("reorder_accounts", { accountIds }),
  updateAccountColor: (accountId: string, color: string) =>
    call<AccountSummary>("update_account_color", { accountId, color }),
  getAccountCachePolicy: (accountId: string) =>
    call<CachePolicy>("get_account_cache_policy", { accountId }),
  setAccountCachePolicy: (accountId: string, policy: CachePolicy) =>
    call<CachePolicy>("set_account_cache_policy", { accountId, policy }),
  getAccountCacheUsage: (accountId: string) =>
    call<CacheUsage>("get_account_cache_usage", { accountId }),
  clearAccountDownloads: (accountId: string) =>
    call<void>("clear_account_downloads", { accountId }),
  testAccount: (request: AccountSetupRequest) =>
    call<void>("test_account", { request }),
  discoverMailSettings: (email: string) =>
    call<MailSettingsDiscovery>("discover_mail_settings", { email }),
  testSavedAccount: (accountId: string) =>
    call<void>("test_saved_account", { accountId }),
  updateAccountPassword: (accountId: string, password: string) =>
    call<AccountSummary>("update_account_password", { accountId, password }),
  addAccount: (request: AccountSetupRequest) =>
    call<AccountSummary>("add_account", { request }),
  removeAccount: (accountId: string) =>
    call<AccountRemovalOutcome>("remove_account", { accountId }),
  getAccountRemovalImpact: (accountId: string) =>
    call<AccountRemovalImpact>("get_account_removal_impact", { accountId }),
  eraseAllData: () => {
    return queueSettings(async () => {
      const removed = await call<number>("erase_all_data");
      settingsGeneration += 1;
      return removed;
    });
  },
  updateAccountDisplayName: (accountId: string, displayName: string) =>
    call<AccountSummary>("update_account_display_name", {
      accountId,
      displayName,
    }),
  updateAccountReplyTo: (accountId: string, replyTo: string) =>
    call<AccountSummary>("update_account_reply_to", { accountId, replyTo }),
  updateAccountSignature: (
    accountId: string,
    signature: string,
    signatureHtml?: string,
  ) =>
    call<AccountSummary>("update_account_signature", {
      accountId,
      signature,
      ...(signatureHtml === undefined ? {} : { signatureHtml }),
    }),
  updateAccountDefaultBodyFormat: (accountId: string, format: BodyFormat) =>
    call<AccountSummary>("update_account_default_body_format", {
      accountId,
      format,
    }),
  getAccountInboxCounts: () =>
    call<AccountInboxCount[]>("get_account_inbox_counts"),
  listMailboxes: (accountId: string) =>
    call<MailboxSummary[]>("list_mailboxes", { accountId }),
  listAllMailboxes: () => call<MailboxSummary[]>("list_all_mailboxes"),
  syncAccount: (accountId: string) => call<void>("sync_account", { accountId }),
  syncAllAccounts: () => call<string[]>("sync_all_accounts"),
  loadOlderMessages: (accountId: string, mailboxId: number) =>
    call<{ added: number; hasMore: boolean }>("load_older_messages", {
      accountId,
      mailboxId,
    }),
  listMessages: (
    accountId: string,
    mailboxId: number,
    cursor?: MessageCursor,
    limit = 100,
    filter?: MessageListFilter,
    sort?: MessageListSort,
  ) =>
    call<MessagePage>("list_messages", {
      accountId,
      mailboxId,
      cursor,
      limit,
      filter: filter && filter !== "all" ? filter : undefined,
      sort: sort && sort !== "date" ? sort : undefined,
    }),
  getMessage: (accountId: string, messageId: number) =>
    call<MessageDetail>("get_message", { accountId, messageId }),
  downloadFullMessage: (accountId: string, messageId: number) =>
    call<MessageDetail>("download_full_message", { accountId, messageId }),
  findCachedMessage: (accountId: string, headerId: string) =>
    call<MessageSummary | null>("find_cached_message", { accountId, headerId }),
  getMessageSource: (accountId: string, messageId: number) =>
    call<MessageSource>("get_message_source", { accountId, messageId }),
  saveMessageEml: (accountId: string, messageId: number) =>
    call<void>("save_message_eml", { accountId, messageId }),
  unsubscribeOneClick: (accountId: string, messageId: number) =>
    call<void>("unsubscribe_one_click", { accountId, messageId }),
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
  moveMessage: (
    accountId: string,
    messageId: number,
    role: string,
    undoToken?: string,
  ) =>
    call<number | null | undefined>("move_message", {
      accountId,
      messageId,
      role,
      undoToken,
    }),
  moveMessageToMailbox: (
    accountId: string,
    messageId: number,
    destinationMailboxId: number,
    undoToken?: string,
  ) =>
    call<void>("move_message_to_mailbox", {
      accountId,
      messageId,
      destinationMailboxId,
      undoToken,
    }),
  /** Cancels a move still inside its undo window. */
  undoDeferred: (accountId: string, undoToken: string) =>
    call<{ restored: number; alreadyCommitted: boolean }>("undo_deferred", {
      accountId,
      undoToken,
    }),
  /** Sends a move from its undo window to the server now. */
  commitDeferred: (accountId: string, undoToken: string) =>
    call<void>("commit_deferred", { accountId, undoToken }),
  setVisibleFolder: (accountId: string, mailboxId: number | null) =>
    call<void>("set_visible_folder", { accountId, mailboxId }),
  copyMessageToMailbox: (
    accountId: string,
    messageId: number,
    destinationMailboxId: number,
  ) =>
    call<void>("copy_message_to_mailbox", {
      accountId,
      messageId,
      destinationMailboxId,
    }),
  setMessagesFlags: (
    accountId: string,
    messageIds: number[],
    isRead?: boolean,
    isStarred?: boolean,
  ) =>
    call<BulkOutcome>("set_messages_flags", {
      accountId,
      messageIds,
      isRead,
      isStarred,
    }),
  setMessagesPinned: (
    accountId: string,
    messageIds: number[],
    pinned: boolean,
  ) =>
    call<number>("set_messages_pinned", {
      accountId,
      messageIds,
      pinned,
    }),
  copyMessagesToMailbox: (
    accountId: string,
    messageIds: number[],
    destinationMailboxId: number,
  ) =>
    call<BulkOutcome>("copy_messages_to_mailbox", {
      accountId,
      messageIds,
      destinationMailboxId,
    }),
  moveMessagesToMailbox: (
    accountId: string,
    messageIds: number[],
    destinationMailboxId: number,
    undoToken?: string,
  ) =>
    call<BulkOutcome>("move_messages_to_mailbox", {
      accountId,
      messageIds,
      destinationMailboxId,
      undoToken,
    }),
  markMailboxRead: (accountId: string, mailboxId: number) =>
    call<BulkOutcome>("mark_mailbox_read", { accountId, mailboxId }),
  suggestRecipients: (accountId: string, prefix: string, limit?: number) =>
    call<RecipientSuggestion[]>("suggest_recipients", {
      accountId,
      prefix,
      limit,
    }),
  createFolder: (accountId: string, name: string, parentMailboxId?: number) =>
    call<void>(
      "create_folder",
      parentMailboxId == null
        ? { accountId, name }
        : { accountId, name, parentMailboxId },
    ),
  renameFolder: (accountId: string, mailboxId: number, name: string) =>
    call<void>("rename_folder", { accountId, mailboxId, name }),
  moveFolder: (
    accountId: string,
    mailboxId: number,
    parentMailboxId?: number,
  ) =>
    call<void>(
      "move_folder",
      parentMailboxId == null
        ? { accountId, mailboxId }
        : { accountId, mailboxId, parentMailboxId },
    ),
  deleteFolder: (accountId: string, mailboxId: number) =>
    call<void>("delete_folder", { accountId, mailboxId }),
  deleteTrashMessages: (accountId: string, messageIds: number[]) =>
    call<void>("delete_trash_messages", { accountId, messageIds }),
  emptyTrash: (accountId: string) => call<void>("empty_trash", { accountId }),
  emptyJunk: (accountId: string) => call<void>("empty_junk", { accountId }),
  searchCached: (query: SearchQuery) =>
    call<MessageSummary[]>("search_cached_messages", { query }),
  searchServer: (query: SearchQuery) =>
    call<MessageSummary[]>("search_server_messages", { query }),
  listRecentSearches: (accountId: string) =>
    call<string[]>("list_recent_searches", { accountId }),
  rememberSearch: (accountId: string, query: string) =>
    call<string[]>("remember_search", { accountId, query }),
  forgetRecentSearch: (accountId: string, query: string) =>
    call<string[]>("forget_recent_search", { accountId, query }),
  forgetRecentSearches: (accountId: string) =>
    call<void>("forget_recent_searches", { accountId }),
  setUnreadBadge: (count: number) => call<void>("set_unread_badge", { count }),
  saveDraft: (draft: ComposeDraft) =>
    call<DraftSaveOutcome>("save_draft", { draft }),
  listDrafts: (accountId: string) =>
    call<DraftSummary[]>("list_drafts", { accountId }),
  getDraft: (draftId: string, accountId: string) =>
    call<ComposeDraft>("get_draft", { draftId, accountId }),
  deleteDraft: (draftId: string, accountId: string) =>
    call<void>("delete_draft", { draftId, accountId }),
  sendMessage: (draft: ComposeDraft, archiveSource?: ArchiveSource) =>
    call<SendOutcome>("send_message", { draft, archiveSource }),
  sendReadReceipt: (accountId: string, messageId: number) =>
    call<string>("send_read_receipt", { accountId, messageId }),
  declineReadReceipt: (accountId: string, messageId: number) =>
    call<string>("decline_read_receipt", { accountId, messageId }),
  listOutbox: (accountId: string) =>
    call<OutboxSummary[]>("list_outbox", { accountId }),
  getOutbox: (outboxId: string, accountId: string) =>
    call<ComposeDraft>("get_outbox", { outboxId, accountId }),
  restoreOutbox: (outboxId: string, accountId: string) =>
    call<ComposeDraft>("restore_outbox", { outboxId, accountId }),
  retryOutbox: (outboxId: string, accountId: string) =>
    call<SendOutcome>("retry_outbox", { outboxId, accountId }),
  retrySentCopy: (outboxId: string, accountId: string) =>
    call<SendOutcome>("retry_sent_copy", { outboxId, accountId }),
  retryArchiveAfterSend: (outboxId: string, accountId: string) =>
    call<SendOutcome>("retry_archive_after_send", { outboxId, accountId }),
  dismissArchiveWarning: (outboxId: string, accountId: string) =>
    call<void>("dismiss_archive_warning", { outboxId, accountId }),
  sendScheduledOutbox: (outboxId: string, accountId: string) =>
    call<SendOutcome>("send_scheduled_outbox", { outboxId, accountId }),
  snoozeMessage: (accountId: string, messageId: number, untilIso: string) =>
    call<void>("snooze_message", { accountId, messageId, untilIso }),
  snoozeMessages: (accountId: string, messageIds: number[], untilIso: string) =>
    call<void>("snooze_messages", { accountId, messageIds, untilIso }),
  unsnoozeMessage: (accountId: string, messageId: number) =>
    call<void>("unsnooze_message", { accountId, messageId }),
  listSnoozed: (accountId: string) =>
    call<SnoozedSummary[]>("list_snoozed", { accountId }),
  listFilterRules: (accountId: string) =>
    call<FilterRule[]>("list_filter_rules", { accountId }),
  muteConversation: (accountId: string, messageId: number) =>
    call<number[]>("mute_conversation", { accountId, messageId }),
  unmuteConversation: (accountId: string, messageId: number) =>
    call<void>("unmute_conversation", { accountId, messageId }),
  createFilterRule: (rule: FilterRule) =>
    call<FilterRule>("create_filter_rule", { rule }),
  updateFilterRule: (rule: FilterRule) =>
    call<FilterRule>("update_filter_rule", { rule }),
  deleteFilterRule: (accountId: string, ruleId: string) =>
    call<void>("delete_filter_rule", { accountId, ruleId }),
  reorderFilterRules: (accountId: string, orderedIds: string[]) =>
    call<FilterRule[]>("reorder_filter_rules", { accountId, orderedIds }),
  previewFilterRule: (rule: FilterRule) =>
    call<FilterMatchPreview>("preview_filter_rule", { rule }),
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
  saveAllAttachments: (accountId: string, messageId: number) =>
    call<number>("save_all_attachments", { accountId, messageId }),
  saveChosenAttachments: (
    accountId: string,
    messageId: number,
    attachmentIds: string[],
  ) =>
    call<number>("save_chosen_attachments", {
      accountId,
      messageId,
      attachmentIds,
    }),
  saveConversationAttachments: (accountId: string, messageIds: number[]) =>
    call<number>("save_conversation_attachments", { accountId, messageIds }),
  saveMessagesEml: (accountId: string, messageIds: number[]) =>
    call<number>("save_messages_eml", { accountId, messageIds }),
  previewAttachment: (
    accountId: string,
    messageId: number,
    attachmentId: string,
  ) =>
    call<AttachmentPreview>("preview_attachment", {
      accountId,
      messageId,
      attachmentId,
    }),
  prepareForwardAttachments: (accountId: string, messageId: number) =>
    call<ComposeAttachment[]>("prepare_forward_attachments", {
      accountId,
      messageId,
    }),
  prepareReplyAttachments: (accountId: string, messageId: number) =>
    call<ComposeAttachment[]>("prepare_reply_attachments", {
      accountId,
      messageId,
    }),
  prepareForwardedMessage: (accountId: string, messageId: number) =>
    call<ComposeAttachment>("prepare_forwarded_message", {
      accountId,
      messageId,
    }),
  chooseAttachments: (accountId: string, inline: boolean) =>
    call<ComposeAttachment[]>("choose_attachments", { accountId, inline }),
  stagePastedImage: (accountId: string, data: string) =>
    call<ComposeAttachment>("stage_pasted_image", { accountId, data }),
  attachDroppedFiles: (accountId: string) =>
    call<ComposeAttachment[]>("attach_dropped_files", { accountId }),
  fetchRemoteImage: (url: string) =>
    call<RemoteImageResult>("fetch_remote_image", { url }),
  inspectExternalUrl: (url: string) =>
    call<ExternalLinkCheck>("inspect_external_url", { url }),
  openExternalUrl: (url: string, openAnyway = false) =>
    call<void>("open_external_url", { url, openAnyway }),
  openHelpUrl: () => call<void>("open_help_url"),
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
  saveSettings: (settings: AppSettings, confirmToken?: string) =>
    queueSettings(
      () =>
        call<AppSettings>(
          "save_settings",
          confirmToken ? { settings, confirmToken } : { settings },
        ),
      settingsGeneration,
      () => call<AppSettings>("get_settings"),
    ),
  setMailShortcutGuard: (guarded: boolean) =>
    inTauri()
      ? call<void>("set_mail_shortcut_guard", { guarded })
      : Promise.resolve(),
  exportSettings: () => queueSettings(() => call<boolean>("export_settings")),
  importSettings: () => {
    return queueSettings(async () => {
      const imported = await call<AppSettings | null>("import_settings");
      if (imported) settingsGeneration += 1;
      return imported;
    });
  },
  getStartupNotice: () => call<string | null>("get_startup_notice"),
  getStartupError: () => call<string | null>("get_startup_error"),
  cacheUsage: () => call<CacheUsage>("get_cache_usage"),
  clearCache: () => call<void>("clear_downloaded_mail"),
  retryAttachmentCleanup: () => call<boolean>("retry_attachment_cleanup"),
  distribution: () => call<DistributionChannel>("get_distribution_channel"),
  getBetaUpdaterTarget: () => call<string>("get_beta_updater_target"),
  getLicenseCredits: () => call<LicenseCredits>("get_license_credits"),
  getSyncProgress: (accountId: string) =>
    call<SyncProgress>("get_sync_progress", { accountId }),
  async onFrameLink(handler: (url: string) => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<string>("frame-link", ({ payload }) => handler(payload));
  },
  async onSyncState(handler: (state: SyncState) => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<SyncState>("sync-state", ({ payload }) => handler(payload));
  },
  async onSyncProgress(
    handler: (progress: SyncProgress) => void,
  ): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<SyncProgress>("sync-progress", ({ payload }) =>
      handler(payload),
    );
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
  /** Native drag-drop position and count. Never file paths. */
  async onComposeDrag(
    handler: (event: ComposeDragEvent) => void,
  ): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<ComposeDragEvent>("compose-drag", ({ payload }) =>
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
  async onAppWarning(handler: (warning: string) => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<string>("app-warning", ({ payload }) => handler(payload));
  },
  async onOfflineOperationsDropped(
    handler: (event: OfflineOperationsDroppedEvent) => void,
  ): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen<OfflineOperationsDroppedEvent>(
      "offline-operations-dropped",
      ({ payload }) => handler(payload),
    );
  },
  /** Maximize-overlay hit area in physical pixels. Zero size hides it. */
  setSnapOverlayBounds: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => call<void>("set_snap_overlay_bounds", bounds),
  discoverAccountAliases: (accountId: string) =>
    call<AccountSummary>("discover_account_aliases", { accountId }),
  updateAccountAliases: (accountId: string, aliases: string[]) =>
    call<AccountSummary>("update_account_aliases", { accountId, aliases }),
  showNativeConfirm: (
    title: string,
    message: string,
    labels?: { ok: string; cancel: string },
  ) => {
    if (!inTauri())
      return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    return call<boolean>("show_native_confirm", {
      title,
      message,
      okLabel: labels?.ok,
      cancelLabel: labels?.cancel,
    });
  },
  showNativeMessage: (title: string, message: string) => {
    if (!inTauri()) {
      window.alert(`${title}\n\n${message}`);
      return Promise.resolve();
    }
    return call<void>("show_native_message", { title, message });
  },
  printWebview: () => call<void>("print_webview"),
  relaunch: () => {
    if (!inTauri()) {
      window.location.reload();
      return Promise.resolve();
    }
    return call<void>("relaunch_app");
  },
  quitApp: () => {
    if (!inTauri()) {
      window.close();
      return Promise.resolve();
    }
    return call<void>("quit_app");
  },
  trayIsActive: () => {
    if (!inTauri()) return Promise.resolve(false);
    return call<boolean>("tray_is_active");
  },
  async onTrayQuit(handler: () => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen("tray-quit", () => handler());
  },
  async onBackgroundUpdateDue(handler: () => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen("background-update-due", () => handler());
  },
  async onUpdateCheckDue(handler: () => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => undefined;
    return listen("update-check-due", () => handler());
  },
  markUpdateChecked: () => {
    if (!inTauri()) return Promise.resolve();
    return call<void>("mark_update_checked");
  },
  scheduleBackgroundUpdate: () => {
    if (!inTauri()) return Promise.resolve();
    return call<void>("schedule_background_update");
  },
  prepareUpdateRelaunch: (mode: "window" | "background") => {
    if (!inTauri()) return Promise.resolve();
    return call<void>("prepare_update_relaunch", { mode });
  },
  clearUpdateRelaunch: () => {
    if (!inTauri()) return Promise.resolve();
    return call<void>("clear_update_relaunch");
  },
  updateRelaunch: () => {
    if (!inTauri()) return Promise.resolve(null);
    return call<"window" | "background" | null>("get_update_relaunch");
  },
  setComposerOpen: (open: boolean) =>
    inTauri() ? call<void>("set_composer_open", { open }) : Promise.resolve(),
  setUpdateReady: (ready: boolean) => {
    if (!inTauri()) return Promise.resolve();
    return call<void>("set_update_ready", { ready });
  },
  backgroundUpdateAllowed: () => {
    if (!inTauri()) return Promise.resolve(false);
    return call<boolean>("background_update_allowed");
  },
  beginUpdateInstall: () => {
    if (!inTauri()) return Promise.resolve();
    return call<void>("begin_update_install");
  },
  releaseUpdateInstall: () => {
    if (!inTauri()) return Promise.resolve();
    return call<void>("release_update_install");
  },
};

export { inTauri };
