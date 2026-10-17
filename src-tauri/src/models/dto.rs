use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Icloud,
    Manual,
    ProtonBridge,
    Gmail,
    Outlook,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Icloud => "icloud",
            Self::Manual => "manual",
            Self::ProtonBridge => "protonBridge",
            Self::Gmail => "gmail",
            Self::Outlook => "outlook",
        }
    }
}

fn default_auth_method() -> String {
    "password".to_string()
}

fn default_undo_send_seconds() -> u32 {
    10
}

fn default_true() -> bool {
    true
}

fn default_group_threads() -> bool {
    true
}

fn default_notify_new_mail() -> bool {
    true
}

fn default_update_check_interval() -> String {
    "startupAnd6h".into()
}

fn default_update_channel() -> String {
    "auto".into()
}

fn default_badge_scope() -> String {
    "activeInbox".into()
}

fn default_mark_read() -> String {
    "open".into()
}

fn default_mailbox_sort() -> String {
    "date".into()
}

fn default_mailbox_filter() -> String {
    "all".into()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TlsMode {
    Tls,
    StartTls,
}

impl TlsMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Tls => "tls",
            Self::StartTls => "startTls",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub tls_mode: TlsMode,
    pub username: String,
    #[serde(skip)]
    pub trusted_certificate: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSetupRequest {
    pub provider: ProviderKind,
    pub email: String,
    pub display_name: String,
    pub password: String,
    pub imap: Option<ServerConfig>,
    pub smtp: Option<ServerConfig>,
    /// Download policy chosen during setup; `None` uses the app default.
    #[serde(default)]
    pub cache_policy: Option<CachePolicy>,
    #[serde(default)]
    pub certificate_reference: Option<String>,
}

impl std::fmt::Debug for AccountSetupRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountSetupRequest")
            .field("provider", &self.provider)
            .field("email", &self.email)
            .field("display_name", &self.display_name)
            .field("password", &"[REDACTED]")
            .field("imap", &self.imap)
            .field("smtp", &self.smtp)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub provider: ProviderKind,
    pub email: String,
    pub display_name: String,
    pub sync_state: String,
    pub error: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_auth_method")]
    pub auth_method: String,
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub signature_html: String,
    /// Where replies to mail from this account should go. Empty uses From.
    #[serde(default)]
    pub reply_to: String,
    /// Avatar color token chosen by the user; `None` uses the automatic color.
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub default_body_format: BodyFormat,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRemovalOutcome {
    pub cleanup_pending: bool,
    /// Compaction failed; removed mail may stay on disk until the next launch.
    pub disk_space_pending: bool,
}

/// Local-only work that removing an account would discard. Mail on the server
/// is unaffected; these items exist only on this computer.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRemovalImpact {
    pub unsent_messages: u32,
    pub unsynced_drafts: u32,
    pub queued_changes: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionBlockers {
    pub queued_changes: u32,
    pub unsent_messages: u32,
}

/// Avatar colors an account may use. Kept in sync with the frontend tokens.
pub const ACCOUNT_COLORS: [&str; 8] = [
    "blue", "teal", "green", "amber", "orange", "red", "pink", "purple",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInboxCount {
    pub account_id: String,
    pub unread_count: u32,
    pub total_count: u32,
}

#[derive(Clone, Debug)]
pub struct AccountRecord {
    pub summary: AccountSummary,
    pub imap: ServerConfig,
    pub smtp: ServerConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MailboxRole {
    Inbox,
    Sent,
    Drafts,
    Archive,
    Trash,
    Junk,
    Other,
}

impl MailboxRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Sent => "sent",
            Self::Drafts => "drafts",
            Self::Archive => "archive",
            Self::Trash => "trash",
            Self::Junk => "junk",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxSummary {
    pub id: i64,
    pub account_id: String,
    pub name: String,
    pub display_name: String,
    pub role: MailboxRole,
    pub unread_count: u32,
    pub total_count: u32,
    /// IMAP hierarchy delimiter from LIST, when the server reported one.
    pub delimiter: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub id: i64,
    pub account_id: String,
    pub mailbox_id: i64,
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: String,
    pub sender_name: String,
    pub sender_address: String,
    pub recipients: String,
    pub received_at: String,
    pub preview: String,
    pub is_read: bool,
    pub is_starred: bool,
    pub has_attachments: bool,
    pub size: u64,
    #[serde(default)]
    pub thread_root: Option<String>,
    #[serde(default)]
    pub has_calendar: bool,
    #[serde(default)]
    pub is_answered: bool,
    #[serde(default)]
    pub is_forwarded: bool,
    /// Later Inbox mail in this conversation is filed to Archive.
    #[serde(default)]
    pub conversation_muted: bool,
    /// `high`, `low`, or empty for normal. Unknown values stay empty.
    #[serde(default)]
    pub importance: String,
    /// Local pin. Mail sync does not clear it.
    #[serde(default)]
    pub pinned: bool,
    /// The account address or an alias is in the To header.
    #[serde(default)]
    pub to_me: bool,
    /// Server arrival time. Empty when the mailbox has not reported one.
    #[serde(default)]
    pub arrived_at: String,
    /// Regular files. A picture in the letter stays out. Zero until the message is downloaded.
    #[serde(default)]
    pub attachment_count: usize,
}

/// Keep only the two importance words a message may store or send.
pub(crate) fn canonical_importance(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "high" => "high",
        "low" => "low",
        _ => "",
    }
}

/// One bare mailbox, or nothing. Display names, lists, and header text stay out.
pub(crate) fn receipt_mailbox(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() > 254
        || trimmed.matches('@').count() != 1
        || trimmed.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '<' | '>' | ',' | ';' | '"' | '\\')
        })
    {
        return None;
    }
    let (local, domain) = trimmed.split_once('@')?;
    if local.is_empty() || domain.is_empty() || domain.starts_with('.') || domain.ends_with('.') {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

/// Which cached messages a mailbox list includes. `All` is the normal list.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MessageListFilter {
    #[default]
    All,
    Unread,
    Starred,
    Attachments,
    Pinned,
    ToMe,
    Invitations,
}

/// Mailbox list order. Date is newest first. DateOldest is oldest first.
/// From and subject are A to Z; the Desc variants are Z to A. Size is
/// largest first; SizeAsc is smallest first. UID order breaks ties and
/// flips with the direction.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MessageListSort {
    #[default]
    Date,
    DateOldest,
    Sender,
    SenderDesc,
    Subject,
    SubjectDesc,
    Size,
    SizeAsc,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCursor {
    pub received_at: String,
    pub uid: u32,
    /// Which order produced this page. Older cursors are date order.
    #[serde(default)]
    pub sort: MessageListSort,
    /// From, subject, or size of the last row. Date order uses `received_at`.
    #[serde(default)]
    pub key: String,
    /// Whether the last row was pinned. Older cursors are unpinned pages.
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub items: Vec<MessageSummary>,
    pub next_cursor: Option<MessageCursor>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub content_id: Option<String>,
    pub inline: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    #[serde(flatten)]
    pub summary: MessageSummary,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub reply_to: Option<String>,
    pub text_body: String,
    pub html_body: Option<String>,
    pub remote_images_blocked: bool,
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub references: Vec<String>,
    /// `available`, or why the body is missing: `offline`, `signInNeeded`,
    /// `tooLarge`.
    #[serde(default = "default_body_status")]
    pub body_status: String,
    /// Raw bounded List-Unsubscribe / List-Unsubscribe-Post header values.
    #[serde(default)]
    pub list_unsubscribe: Option<String>,
    #[serde(default)]
    pub list_unsubscribe_post: Option<String>,
    /// Derived from the stored headers by Rust; the frontend never parses them.
    #[serde(default)]
    pub unsubscribe: Option<crate::mail::list_unsubscribe::UnsubscribeOptions>,
    /// List-Post mailto address, when the list allows posting.
    #[serde(default)]
    pub list_post: Option<String>,
    #[serde(default)]
    pub invite: Option<crate::mail::ics::CalendarInvite>,
    /// Single mailbox from Disposition-Notification-To. Empty when unusable.
    #[serde(default)]
    pub disposition_to: String,
    /// `sent`, `declined`, or empty when the reader has not chosen.
    #[serde(default)]
    pub receipt_choice: String,
    /// Only the first part of a large message is stored; the full body downloads on demand.
    #[serde(default)]
    pub body_partial: bool,
}

fn default_body_status() -> String {
    "available".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeAttachment {
    pub token: String,
    pub filename: String,
    pub content_type: Option<String>,
    pub inline: bool,
    pub content_id: Option<String>,
    #[serde(default)]
    pub size: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDraft {
    pub id: Option<String>,
    pub account_id: String,
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html_body: String,
    pub text_body: String,
    pub attachments: Vec<ComposeAttachment>,
    pub in_reply_to: Option<String>,
    pub references: Option<Vec<String>>,
    #[serde(default)]
    pub send_at: Option<String>,
    #[serde(default)]
    pub body_format: BodyFormat,
    #[serde(default)]
    pub source_message_id: Option<i64>,
    #[serde(default)]
    pub source_kind: Option<DraftSourceKind>,
    /// Missing on older drafts, which still receive the account signature.
    #[serde(default = "include_signature_default")]
    pub include_signature: bool,
    /// `high` or `low`. Empty and anything else send as a normal message.
    #[serde(default)]
    pub importance: String,
    /// Ask recipients to send a read receipt. Older drafts do not ask.
    #[serde(default)]
    pub request_receipt: bool,
    /// Overrides the account Reply-To. Missing keeps the account address.
    /// An empty string sends no Reply-To header.
    #[serde(default)]
    pub reply_to: Option<String>,
}

fn include_signature_default() -> bool {
    true
}

/// Compose body format; unknown values fail IPC deserialization.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BodyFormat {
    #[default]
    Html,
    Plain,
}

impl BodyFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Plain => "plain",
        }
    }

    /// Unknown stored values fall back to HTML.
    pub fn from_db(value: &str) -> Self {
        if value == "plain" {
            Self::Plain
        } else {
            Self::Html
        }
    }
}

/// What a draft answers; unknown values fail IPC deserialization.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DraftSourceKind {
    Reply,
    ReplyAll,
    Forward,
    /// The original message is sent unchanged. Replies go to its sender.
    Redirect,
}

impl DraftSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::ReplyAll => "reply_all",
            Self::Forward => "forward",
            Self::Redirect => "redirect",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub account_id: String,
    pub recipients: String,
    pub subject: String,
    pub updated_at: String,
    pub sync_state: String,
    pub sync_detail: Option<String>,
    /// First line of the draft, capped for the list.
    #[serde(default)]
    pub preview: String,
    /// Files attached to the draft. Pictures inside the letter are left out.
    #[serde(default)]
    pub attachment_count: usize,
    /// Saved From address. Empty when the draft uses the account address.
    #[serde(default)]
    pub from_address: String,
    /// Message this draft answers, forwards, or redirects. Empty for a new message.
    #[serde(default)]
    pub source_message_id: Option<i64>,
    #[serde(default)]
    pub source_kind: Option<DraftSourceKind>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSaveOutcome {
    pub id: String,
    pub sync_state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxSummary {
    pub id: String,
    pub account_id: String,
    pub recipients: String,
    pub subject: String,
    pub state: String,
    pub detail: Option<String>,
    pub reason_code: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub send_at: Option<String>,
    /// First line of the queued message, capped for the list.
    #[serde(default)]
    pub preview: String,
    /// Files on the queued message. Pictures inside the letter are left out.
    #[serde(default)]
    pub attachment_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub id: String,
    pub state: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub account_id: String,
    pub mailbox_id: Option<i64>,
    pub text: String,
    pub all_folders: bool,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub account_id: String,
    pub phase: String,
    pub detail: Option<String>,
    pub last_success_at: Option<String>,
}

/// Download progress for one account. Envelope totals are only known for
/// "Download all"; Recent mode reports the envelopes already cached.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub account_id: String,
    pub folder: Option<String>,
    pub envelopes_done: u64,
    pub envelopes_total: u64,
    pub bodies_done: u64,
    pub bodies_total: u64,
    pub backfilling: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct CachePolicy {
    pub mode: String,
    pub days: u32,
    pub max_bytes: u64,
}

impl Default for CachePolicy {
    fn default() -> Self {
        Self {
            mode: "recent".into(),
            days: 90,
            max_bytes: 1_073_741_824,
        }
    }
}

impl CachePolicy {
    pub fn is_unlimited(&self) -> bool {
        self.mode == "full" && self.max_bytes == 0
    }

    /// Valid policies: `recent` keeps 1..=3650 days, `full` ignores days, and
    /// the size cap is either off (0) or 100 MiB..=100 GiB.
    pub fn is_valid(&self) -> bool {
        let valid_max_bytes = self.max_bytes == 0
            || (100 * 1024 * 1024..=100 * 1024 * 1024 * 1024).contains(&self.max_bytes);
        let valid_days = match self.mode.as_str() {
            "full" => true,
            "recent" => (1..=3650).contains(&self.days),
            _ => false,
        };
        valid_max_bytes && valid_days
    }

    /// Oldest server arrival time whose body belongs in the cache, if any.
    pub fn cutoff(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        (self.mode == "recent")
            .then(|| chrono::Utc::now() - chrono::Duration::days(i64::from(self.days)))
    }

    /// True when `self` keeps mail that `previous` did not, so backfill that
    /// stopped at the old cutoff has to resume.
    pub fn widens(&self, previous: &CachePolicy) -> bool {
        match (previous.mode.as_str(), self.mode.as_str()) {
            ("recent", "full") => true,
            ("recent", "recent") => self.days > previous.days,
            _ => false,
        }
    }
}

/// The From address last chosen for one account.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastFromAddress {
    pub account_id: String,
    pub address: String,
}

/// A mailbox kept at the top of one account's folder list.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinnedMailbox {
    pub account_id: String,
    pub mailbox_id: i64,
}

/// List order and filter remembered for one folder.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailboxView {
    pub account_id: String,
    pub mailbox_id: i64,
    pub sort: String,
    pub filter: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u32,
    pub reading_pane: String,
    pub text_scale: f64,
    pub private_notifications: bool,
    pub theme: String,
    pub density: String,
    pub cache_policy: CachePolicy,
    pub last_account_id: Option<String>,
    pub last_mailbox_id: Option<i64>,
    pub folder_pane_width: u32,
    pub message_pane_width: u32,
    pub reader_pane_height: u32,
    #[serde(default)]
    pub window_effects: bool,
    #[serde(default = "default_true")]
    pub sidebar_visible: bool,
    #[serde(default = "default_undo_send_seconds")]
    pub undo_send_seconds: u32,
    #[serde(default = "default_true")]
    pub block_advertising_and_tracking: bool,
    #[serde(default = "default_true")]
    pub block_reported_threats: bool,
    /// Senders whose remote images may load when a message opens.
    /// Consent only: advertising, threat, and private-network checks stay on.
    #[serde(default)]
    pub image_senders: Vec<String>,
    #[serde(default = "default_group_threads")]
    pub group_threads: bool,
    /// Put this account's address on Bcc for a new message.
    #[serde(default)]
    pub bcc_self: bool,
    /// Keep the signature above a trailing reply or forward quote.
    #[serde(default = "default_true")]
    pub signature_above_quote: bool,
    /// The Reply button and the R key write to everyone on the message.
    #[serde(default)]
    pub reply_to_all: bool,
    /// The folder list shows Inbox, the open folder, and folders with unread mail.
    #[serde(default)]
    pub unread_folders_only: bool,
    /// Floating compose window width. Zero uses the default layout.
    #[serde(default)]
    pub composer_width: u32,
    /// Floating compose window height. Zero uses the default layout.
    #[serde(default)]
    pub composer_height: u32,
    /// From address last chosen for each account.
    #[serde(default)]
    pub last_from_addresses: Vec<LastFromAddress>,
    /// Mailbox order kept for the next launch.
    #[serde(default = "default_mailbox_sort")]
    pub mailbox_sort: String,
    /// Mailbox filter kept for the next launch.
    #[serde(default = "default_mailbox_filter")]
    pub mailbox_filter: String,
    /// List order and filter for folders that differ from the saved default.
    #[serde(default)]
    pub mailbox_views: Vec<MailboxView>,
    /// Mailboxes kept at the top of each account's folder list.
    #[serde(default)]
    pub pinned_mailboxes: Vec<PinnedMailbox>,
    /// Mailboxes left out of the folder list. Inbox stays visible.
    #[serde(default)]
    pub hidden_mailboxes: Vec<PinnedMailbox>,
    /// Nested folders kept closed.
    #[serde(default)]
    pub collapsed_mailboxes: Vec<PinnedMailbox>,
    /// Last folder chosen from Move to. Inbox, Archive, Junk, and Trash stay off this list.
    #[serde(default)]
    pub recent_move_mailbox_id: Option<i64>,
    /// List rows include the first line of each message.
    #[serde(default = "default_true")]
    pub show_message_previews: bool,
    /// Play the system mail sound with a new-mail alert.
    #[serde(default = "default_true")]
    pub new_mail_sound: bool,
    /// Local HH:MM when new-mail alerts go quiet. Empty with the end stays off.
    #[serde(default)]
    pub quiet_hours_start: String,
    /// Local HH:MM when new-mail alerts resume. Empty with the start stays off.
    #[serde(default)]
    pub quiet_hours_end: String,
    /// When an opened message becomes read: `open`, `after2s`, or `manual`.
    #[serde(default = "default_mark_read")]
    pub mark_read: String,
    #[serde(default = "default_notify_new_mail")]
    pub notify_new_mail: bool,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default = "default_badge_scope")]
    pub badge_scope: String,
    /// Download whole messages instead of the first 256 KiB of large ones.
    #[serde(default)]
    pub keep_attachments_offline: bool,
    #[serde(default = "default_update_check_interval")]
    pub update_check_interval: String,
    /// Update channel: `auto`, `stable`, or `beta`. Not portable: import
    /// must never switch a user's channel.
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    #[serde(default)]
    pub setup_completed: bool,
    #[serde(default)]
    pub setup_step: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableCachePolicy {
    pub mode: String,
    pub days: u32,
    pub max_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSettings {
    pub reading_pane: String,
    pub text_scale: f64,
    pub private_notifications: bool,
    pub theme: String,
    pub density: String,
    pub cache_policy: PortableCachePolicy,
    pub folder_pane_width: u32,
    pub message_pane_width: u32,
    pub reader_pane_height: u32,
    #[serde(default)]
    pub window_effects: bool,
    #[serde(default = "default_true")]
    pub sidebar_visible: bool,
    #[serde(default = "default_undo_send_seconds")]
    pub undo_send_seconds: u32,
    #[serde(default = "default_true")]
    pub block_advertising_and_tracking: bool,
    #[serde(default = "default_true")]
    pub block_reported_threats: bool,
    #[serde(default)]
    pub image_senders: Vec<String>,
    #[serde(default = "default_group_threads")]
    pub group_threads: bool,
    /// Put this account's address on Bcc for a new message.
    #[serde(default)]
    pub bcc_self: bool,
    /// Keep the signature above a trailing reply or forward quote.
    #[serde(default = "default_true")]
    pub signature_above_quote: bool,
    /// The Reply button and the R key write to everyone on the message.
    #[serde(default)]
    pub reply_to_all: bool,
    /// The folder list shows Inbox, the open folder, and folders with unread mail.
    #[serde(default)]
    pub unread_folders_only: bool,
    /// Floating compose window width. Zero uses the default layout.
    #[serde(default)]
    pub composer_width: u32,
    /// Floating compose window height. Zero uses the default layout.
    #[serde(default)]
    pub composer_height: u32,
    /// From address last chosen for each account.
    #[serde(default)]
    pub last_from_addresses: Vec<LastFromAddress>,
    /// Mailbox order kept for the next launch.
    #[serde(default = "default_mailbox_sort")]
    pub mailbox_sort: String,
    /// Mailbox filter kept for the next launch.
    #[serde(default = "default_mailbox_filter")]
    pub mailbox_filter: String,
    /// List order and filter for folders that differ from the saved default.
    #[serde(default)]
    pub mailbox_views: Vec<MailboxView>,
    /// Mailboxes kept at the top of each account's folder list.
    #[serde(default)]
    pub pinned_mailboxes: Vec<PinnedMailbox>,
    /// Mailboxes left out of the folder list. Inbox stays visible.
    #[serde(default)]
    pub hidden_mailboxes: Vec<PinnedMailbox>,
    /// Nested folders kept closed.
    #[serde(default)]
    pub collapsed_mailboxes: Vec<PinnedMailbox>,
    /// Last folder chosen from Move to. Inbox, Archive, Junk, and Trash stay off this list.
    #[serde(default)]
    pub recent_move_mailbox_id: Option<i64>,
    /// List rows include the first line of each message.
    #[serde(default = "default_true")]
    pub show_message_previews: bool,
    /// Play the system mail sound with a new-mail alert.
    #[serde(default = "default_true")]
    pub new_mail_sound: bool,
    /// Local HH:MM when new-mail alerts go quiet. Empty with the end stays off.
    #[serde(default)]
    pub quiet_hours_start: String,
    /// Local HH:MM when new-mail alerts resume. Empty with the start stays off.
    #[serde(default)]
    pub quiet_hours_end: String,
    /// When an opened message becomes read: `open`, `after2s`, or `manual`.
    #[serde(default = "default_mark_read")]
    pub mark_read: String,
    #[serde(default = "default_notify_new_mail")]
    pub notify_new_mail: bool,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default = "default_badge_scope")]
    pub badge_scope: String,
    #[serde(default)]
    pub keep_attachments_offline: bool,
    #[serde(default = "default_update_check_interval")]
    pub update_check_interval: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSettingsFile {
    pub application: String,
    pub format_version: u32,
    pub preferences: PortableSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: 2,
            reading_pane: "right".into(),
            text_scale: 1.0,
            private_notifications: false,
            theme: "system".into(),
            density: "comfortable".into(),
            cache_policy: CachePolicy::default(),
            last_account_id: None,
            last_mailbox_id: None,
            folder_pane_width: 264,
            message_pane_width: 400,
            reader_pane_height: 360,
            window_effects: true,
            sidebar_visible: true,
            undo_send_seconds: default_undo_send_seconds(),
            block_advertising_and_tracking: true,
            block_reported_threats: true,
            image_senders: Vec::new(),
            group_threads: true,
            bcc_self: false,
            signature_above_quote: true,
            reply_to_all: false,
            unread_folders_only: false,
            composer_width: 0,
            composer_height: 0,
            last_from_addresses: Vec::new(),
            mailbox_sort: default_mailbox_sort(),
            mailbox_filter: default_mailbox_filter(),
            mailbox_views: Vec::new(),
            pinned_mailboxes: Vec::new(),
            hidden_mailboxes: Vec::new(),
            collapsed_mailboxes: Vec::new(),
            recent_move_mailbox_id: None,
            show_message_previews: true,
            new_mail_sound: true,
            quiet_hours_start: String::new(),
            quiet_hours_end: String::new(),
            mark_read: default_mark_read(),
            notify_new_mail: true,
            close_to_tray: true,
            badge_scope: default_badge_scope(),
            keep_attachments_offline: false,
            update_check_interval: default_update_check_interval(),
            update_channel: default_update_channel(),
            setup_completed: false,
            setup_step: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    pub bytes: u64,
    pub max_bytes: u64,
    pub message_count: u64,
    /// Removed account folders that a sweep could not delete.
    pub attachment_leftovers: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecipientSuggestion {
    pub address: String,
    pub name: String,
    pub use_count: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreview {
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub text: Option<String>,
    pub image_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoozedSummary {
    pub message: MessageSummary,
    pub snoozed_until: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FilterRule {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub field: String,
    pub contains: String,
    pub action: String,
    pub target_mailbox: Option<String>,
    pub enabled: bool,
}

/// Unread Inbox messages a rule would catch. Does not file them.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterMatchPreview {
    pub matched: u32,
    pub capped: bool,
    pub subjects: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionChannel {
    pub kind: String,
    pub updates_managed_by: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LicenseCredit {
    pub id: String,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LicensePackage {
    pub id: String,
    pub licenses: String,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub license_text: Option<String>,
    #[serde(default)]
    pub license_text_status: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LicenseCredits {
    pub notices: Vec<LicenseCredit>,
    pub packages: Vec<LicensePackage>,
}
