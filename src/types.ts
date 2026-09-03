export type ProviderKind = "icloud" | "manual";
export type TlsMode = "tls" | "startTls";
export type MailboxRole =
  "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk" | "other";
export type ReadingPane = "right" | "bottom" | "hidden";
export type UiDensity = "comfortable" | "compact";
export type SyncPhase = "idle" | "connecting" | "syncing" | "offline" | "error";

export interface ServerConfig {
  host: string;
  port: number;
  tlsMode: TlsMode;
  username: string;
}

export interface AccountSetupRequest {
  provider: ProviderKind;
  email: string;
  displayName: string;
  password: string;
  imap?: ServerConfig;
  smtp?: ServerConfig;
}

export interface AccountSummary {
  id: string;
  provider: ProviderKind;
  email: string;
  displayName: string;
  syncState: SyncPhase;
  error?: string | null;
  aliases?: string[];
}

export interface AccountRemovalOutcome {
  cleanupPending: boolean;
}

export interface MailboxSummary {
  id: number;
  accountId: string;
  name: string;
  displayName: string;
  role: MailboxRole;
  unreadCount: number;
  totalCount: number;
}

export interface MessageSummary {
  id: number;
  accountId: string;
  mailboxId: number;
  uid: number;
  messageId?: string | null;
  subject: string;
  senderName: string;
  senderAddress: string;
  recipients: string;
  receivedAt: string;
  preview: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  size: number;
}

export interface MessageCursor {
  receivedAt: string;
  uid: number;
}

export interface MessagePage {
  items: MessageSummary[];
  nextCursor?: MessageCursor | null;
  hasMore: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string | null;
  inline: boolean;
}

export interface MessageDetail extends MessageSummary {
  to: string[];
  cc: string[];
  replyTo?: string | null;
  textBody: string;
  htmlBody?: string | null;
  remoteImagesBlocked: boolean;
  attachments: Attachment[];
}

export interface ComposeAttachment {
  token: string;
  filename: string;
  contentType?: string;
  inline: boolean;
  contentId?: string;
  size?: number;
}

export interface ComposeDraft {
  id?: string;
  accountId: string;
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  htmlBody: string;
  textBody: string;
  attachments: ComposeAttachment[];
  inReplyTo?: string;
  references?: string[];
}

export interface DraftSummary {
  id: string;
  accountId: string;
  recipients: string;
  subject: string;
  updatedAt: string;
  syncState: "localPending" | "synced" | "localOnly" | "conflict";
  syncDetail?: string | null;
}

export interface DraftSaveOutcome {
  id: string;
  syncState: DraftSummary["syncState"];
}

export interface OutboxSummary {
  id: string;
  accountId: string;
  recipients: string;
  subject: string;
  state: "queued" | "sending" | "sent_copy_pending" | "needs_attention";
  detail?: string | null;
  createdAt: string;
}

export interface SendOutcome {
  id: string;
  state: "queued" | "sent" | "sentCopyPending" | "needsAttention";
  detail?: string | null;
}

export interface SearchQuery {
  accountId: string;
  mailboxId?: number;
  text: string;
  allFolders: boolean;
  limit: number;
}

export interface SyncState {
  accountId: string;
  phase: SyncPhase;
  detail?: string;
  lastSuccessAt?: string;
}

export interface AccountChangeEvent {
  accountId: string;
}

export interface MessageChangeEvent extends AccountChangeEvent {
  messageId?: number | null;
  kind: "flags" | "moved" | "synced";
}

export interface DraftSyncEvent extends AccountChangeEvent {
  draftId?: string | null;
  syncState?: DraftSummary["syncState"] | "deletePending" | null;
}

export interface OutboxChangeEvent extends AccountChangeEvent {
  outboxId?: string | null;
  state?: SendOutcome["state"] | "removed" | null;
}

export interface CachePolicy {
  mode: "recent" | "full";
  days: number;
  maxBytes: number;
}

export interface AppSettings {
  schemaVersion: 2;
  readingPane: ReadingPane;
  textScale: number;
  privateNotifications: boolean;
  theme: "system" | "light" | "dark";
  density: UiDensity;
  cachePolicy: CachePolicy;
  lastAccountId?: string | null;
  lastMailboxId?: number | null;
  folderPaneWidth: number;
  messagePaneWidth: number;
  readerPaneHeight: number;
}

export interface DistributionChannel {
  kind: "direct" | "macAppStore" | "microsoftStore" | "flatpak";
  updatesManagedBy: "postalSnap" | "store";
}

export type IpcErrorCode =
  | "accessDenied"
  | "notFound"
  | "limitExceeded"
  | "settingsNotFound"
  | "settingsTooLarge"
  | "settingsInvalid"
  | "settingsMigrationFailed"
  | "settingsReadFailed"
  | "settingsWriteFailed"
  | "authenticationFailed"
  | "connectionFailed"
  | "localStorageFailed"
  | "invalidInput"
  | "operationFailed";

export interface IpcErrorPayload {
  code: IpcErrorCode;
  message: string;
  retryable: boolean;
}

export interface CacheUsage {
  bytes: number;
  maxBytes: number;
  messageCount: number;
}
