export type ProviderKind =
  "icloud" | "manual" | "protonBridge" | "gmail" | "outlook";
export type TlsMode = "tls" | "startTls";
export type MailboxRole =
  "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk" | "other";
export type ReadingPane = "right" | "bottom" | "hidden";
export type UiDensity = "comfortable" | "compact";
export type SyncPhase =
  "idle" | "connecting" | "syncing" | "offline" | "authFailed" | "error";

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
  cachePolicy?: CachePolicy;
  certificateReference?: string;
}

export type MailSettingsDiscovery =
  | {
      status: "found";
      providerId: string;
      providerName: string;
      accountProvider: ProviderKind;
      source: "preset" | "mx" | "autoconfig";
      imap: ServerConfig;
      smtp: ServerConfig;
      appPasswordUrl?: string | null;
    }
  | {
      status: "unsupported";
      providerId: string;
      providerName: string;
      message: string;
    }
  | { status: "notFound"; domain: string };

export type BodyFormat = "html" | "plain";
export type DraftSourceKind = "reply" | "reply_all" | "forward" | "redirect";

export interface AccountSummary {
  id: string;
  provider: ProviderKind;
  email: string;
  displayName: string;
  syncState: SyncPhase;
  error?: string | null;
  aliases?: string[];
  authMethod?: string;
  signature?: string;
  /** Where replies to mail from this account should go. Blank uses From. */
  replyTo?: string;
  color?: string | null;
  defaultBodyFormat?: BodyFormat;
}

export interface AccountRemovalOutcome {
  cleanupPending: boolean;
}

export interface AccountRemovalImpact {
  unsentMessages: number;
  unsyncedDrafts: number;
  queuedChanges: number;
}

export interface AccountInboxCount {
  accountId: string;
  unreadCount: number;
  totalCount: number;
}

export interface MailboxSummary {
  id: number;
  accountId: string;
  name: string;
  displayName: string;
  role: MailboxRole;
  unreadCount: number;
  totalCount: number;
  delimiter?: string | null;
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
  threadRoot?: string | null;
  hasCalendar?: boolean;
  isAnswered?: boolean;
  isForwarded?: boolean;
  /** Later Inbox mail in this conversation is filed to Archive. */
  conversationMuted?: boolean;
  /** `high`, `low`, or empty for a normal message. */
  importance?: string;
  /** Local pin. Mail sync leaves it in place. */
  pinned?: boolean;
  /** The account address or an alias is in the To header. */
  toMe?: boolean;
  /** Server arrival time. Empty when the mailbox has not reported one. */
  arrivedAt?: string;
  /** Regular files. A picture in the letter stays out. */
  attachmentCount?: number;
}

export interface MessageCursor {
  receivedAt: string;
  uid: number;
  sort?: "date" | "sender" | "subject" | "size";
  key?: string;
  pinned?: boolean;
}

export interface BulkOutcome {
  updated: number;
  queued: number;
  failed: number;
}

export interface RecipientSuggestion {
  address: string;
  name: string;
  useCount: number;
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

export interface AttachmentPreview {
  filename: string;
  contentType: string;
  size: number;
  text?: string | null;
  imageDataUrl?: string | null;
}

export interface MessageDetail extends MessageSummary {
  to: string[];
  cc: string[];
  /** People who received a hidden copy. Empty when the message has none. */
  bcc?: string[];
  replyTo?: string | null;
  textBody: string;
  htmlBody?: string | null;
  remoteImagesBlocked: boolean;
  attachments: Attachment[];
  references?: string[];
  /** Why the body is missing when it could not be downloaded. */
  bodyStatus?: "available" | "offline" | "signInNeeded" | "tooLarge";
  /** Raw bounded header values; parsed later. */
  listUnsubscribe?: string | null;
  listUnsubscribePost?: string | null;
  /** Derived in Rust from the stored headers. */
  unsubscribe?: UnsubscribeOptions | null;
  /** List-Post address when the list allows posting. */
  listPost?: string | null;
  invite?: CalendarInvite | null;
  /** Mailbox that asked for a read receipt. */
  dispositionTo?: string;
  /** `sent`, `declined`, or empty when you have not chosen. */
  receiptChoice?: string;
}

export interface UnsubscribeOptions {
  oneClick: boolean;
  httpsUrl?: string | null;
  httpsHost?: string | null;
  mailto?: string | null;
}

export interface IcsTime {
  /** `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS`, or the same with a trailing `Z`. */
  iso: string;
  allDay: boolean;
  utc: boolean;
  tzid?: string | null;
}

export interface CalendarInvite {
  method?: string | null;
  status?: string | null;
  summary?: string | null;
  start?: IcsTime | null;
  end?: IcsTime | null;
  location?: string | null;
  organizerName?: string | null;
  organizerEmail?: string | null;
}

export interface SourceHeader {
  name: string;
  value: string;
}

export interface MessageSource {
  headers: SourceHeader[];
  source: string;
  truncated: boolean;
  size: number;
}

export interface ComposeAttachment {
  token: string;
  filename: string;
  contentType?: string;
  inline: boolean;
  contentId?: string;
  size?: number;
}

export interface ArchiveSource {
  messageId: number;
  mailboxId: number;
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
  sendAt?: string | null;
  bodyFormat?: BodyFormat;
  sourceMessageId?: number | null;
  sourceKind?: DraftSourceKind | null;
  includeSignature?: boolean;
  /** `high` marks the outgoing message important. Empty sends it as normal. */
  importance?: string;
  /** Ask recipients to tell you when they open this message. */
  requestReceipt?: boolean;
  /** Overrides the account Reply-To. An empty string sends no Reply-To header. */
  replyTo?: string;
}

export interface DraftSummary {
  id: string;
  accountId: string;
  recipients: string;
  subject: string;
  updatedAt: string;
  syncState: "localPending" | "synced" | "localOnly" | "conflict";
  syncDetail?: string | null;
  /** First line of the draft. Empty when the draft has no message yet. */
  preview?: string;
  /** Files attached to the draft. Pictures inside the letter are left out. */
  attachmentCount?: number;
  /** Saved From address. Empty when the draft uses the account address. */
  fromAddress?: string;
  /** Message this draft answers, forwards, or redirects. */
  sourceMessageId?: number | null;
  sourceKind?: DraftSourceKind | null;
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
  state:
    | "queued"
    | "sending"
    | "sent_copy_pending"
    | "archive_pending"
    | "needs_attention"
    | "scheduled";
  detail?: string | null;
  createdAt: string;
  sendAt?: string | null;
  /** First line of the queued message. Empty when the message has no text yet. */
  preview?: string;
  /** Files on the queued message. Pictures inside the letter are left out. */
  attachmentCount?: number;
}

export interface SnoozedSummary {
  message: MessageSummary;
  snoozedUntil: string;
}

export interface FilterRule {
  id: string;
  accountId: string;
  name: string;
  field: "from" | "to" | "subject" | "domain";
  contains: string;
  action:
    "mark_read" | "move_archive" | "move_trash" | "move_junk" | "move_mailbox";
  targetMailbox?: string | null;
  enabled: boolean;
}

export interface FilterMatchPreview {
  matched: number;
  capped: boolean;
  subjects: string[];
}

export interface SendOutcome {
  id: string;
  state:
    | "queued"
    | "sent"
    | "sent_copy_pending"
    | "archive_pending"
    | "needs_attention"
    | "scheduled"
    | "sending"
    | "removed";
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

/** Window drag-drop from Rust. Positions are CSS pixels; no paths. */
export interface ComposeDragEvent {
  phase: "over" | "drop" | "leave";
  x: number;
  y: number;
  count: number;
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

export interface SyncProgress {
  accountId: string;
  folder?: string | null;
  envelopesDone: number;
  envelopesTotal: number;
  bodiesDone: number;
  bodiesTotal: number;
  backfilling: boolean;
}

export type SettingsPatch = Partial<Omit<AppSettings, "cachePolicy">> & {
  cachePolicy?: Partial<CachePolicy>;
};

export type SetupStep = "welcome" | "appearance" | "comfort" | "account";

export type UpdateCheckInterval =
  "startupAnd6h" | "startupAnd12h" | "startupAnd24h" | "startup" | "manual";

export interface LastFromAddress {
  accountId: string;
  address: string;
}

export interface PinnedMailbox {
  accountId: string;
  mailboxId: number;
}

/** List order and filter remembered for one folder. */
export interface MailboxView {
  accountId: string;
  mailboxId: number;
  sort: AppSettings["mailboxSort"];
  filter: AppSettings["mailboxFilter"];
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
  windowEffects: boolean;
  sidebarVisible: boolean;
  undoSendSeconds: number;
  blockAdvertisingAndTracking: boolean;
  blockReportedThreats: boolean;
  /** Senders whose pictures load when a message opens. Checks still apply. */
  imageSenders: string[];
  groupThreads: boolean;
  /** Put this account's address on Bcc for a new message. */
  bccSelf: boolean;
  /** Keep the signature above a trailing reply or forward quote. */
  signatureAboveQuote: boolean;
  /** The Reply button and the R key write to everyone on the message. */
  replyToAll: boolean;
  /** The folder list shows Inbox, the open folder, and folders with unread mail. */
  unreadFoldersOnly: boolean;
  /** Floating compose window size. Zero uses the default layout. */
  composerWidth: number;
  composerHeight: number;
  /** From address last chosen for each account. */
  lastFromAddresses: LastFromAddress[];
  /** Mailbox order kept for the next launch. */
  mailboxSort:
    | "date"
    | "dateOldest"
    | "sender"
    | "senderDesc"
    | "subject"
    | "subjectDesc"
    | "size"
    | "sizeAsc";
  /** Mailbox filter kept for the next launch. */
  mailboxFilter:
    | "all"
    | "unread"
    | "starred"
    | "attachments"
    | "pinned"
    | "toMe"
    | "invitations";
  /** List order and filter for folders that differ from the saved default. */
  mailboxViews: MailboxView[];
  /** Mailboxes kept at the top of each account's folder list. */
  pinnedMailboxes: PinnedMailbox[];
  /** Mailboxes left out of the folder list. */
  hiddenMailboxes: PinnedMailbox[];
  /** Nested folders kept closed. */
  collapsedMailboxes: PinnedMailbox[];
  /** Last folder chosen from Move to. */
  recentMoveMailboxId: number | null;
  /** List rows include the first line of each message. */
  showMessagePreviews: boolean;
  /** Play the system mail sound with a new-mail alert. */
  newMailSound: boolean;
  /** Local HH:MM when new-mail alerts go quiet. Blank stays off. */
  quietHoursStart: string;
  /** Local HH:MM when new-mail alerts resume. Blank stays off. */
  quietHoursEnd: string;
  /** When an opened message becomes read. */
  markRead: "open" | "after2s" | "manual";
  notifyNewMail: boolean;
  closeToTray: boolean;
  updateCheckInterval: UpdateCheckInterval;
  setupCompleted: boolean;
  setupStep?: SetupStep | null;
}

export interface DistributionChannel {
  kind: "direct" | "macAppStore" | "microsoftStore" | "flatpak";
  updatesManagedBy: "postalSnap" | "store" | "githubDownload";
}

export interface LicenseCredit {
  id: string;
  title: string;
  body: string;
}

export interface LicensePackage {
  id: string;
  licenses: string;
  repository?: string | null;
  licenseText?: string | null;
  licenseTextStatus?: string | null;
}

export interface LicenseCredits {
  notices: LicenseCredit[];
  packages: LicensePackage[];
}

export interface OfflineOperationsDroppedEvent {
  accountId: string;
  count: number;
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
  | "certificateInvalid"
  | "pendingOperations"
  | "folderAttention"
  | "identityConfirmation"
  | "certificateFailed"
  | "connectionFailed"
  | "localStorageFailed"
  | "invalidInput"
  | "operationFailed";

export interface IpcErrorPayload {
  code: IpcErrorCode;
  message: string;
  retryable: boolean;
  stage?: "imap" | "smtp";
}

export interface CacheUsage {
  bytes: number;
  maxBytes: number;
  messageCount: number;
}
export type RemoteImageResult =
  | { status: "loaded"; dataUrl: string }
  | { status: "blocked" }
  | { status: "reportedThreat" };

export interface ExternalLinkCheck {
  url: string;
  hostname: string;
  reportedThreat: boolean;
}

export interface BridgeCertificate {
  reference: string;
  fingerprint: string;
  expiresAt: string;
}
export interface AccountConnection {
  imap: ServerConfig;
  smtp: ServerConfig;
  certificate?: BridgeCertificate | null;
  blockers?: { queuedChanges: number; unsentMessages: number };
}
export interface FolderAssignment {
  role: "sent" | "drafts" | "archive" | "junk" | "trash";
  mailboxId: number | null;
  missing: boolean;
}
