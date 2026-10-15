use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

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

pub fn validate_filter_rule(rule: &FilterRule, account_id: &str) -> Result<(), String> {
    if rule.account_id != account_id {
        return Err("Rule does not belong to this account.".into());
    }
    let name = rule.name.trim();
    if name.is_empty() || name.len() > 80 || name.contains(char::is_control) {
        return Err("Name the rule in up to 80 characters.".into());
    }
    if !matches!(rule.field.as_str(), "from" | "to" | "subject" | "domain") {
        return Err("Rules can match sender, recipient, subject, or a sender domain.".into());
    }
    let needle = rule.contains.trim();
    if needle.is_empty() || needle.len() > 200 || needle.contains(char::is_control) {
        return Err("Match text must be 1 to 200 characters.".into());
    }
    if rule.field == "domain" && !valid_sender_domain(needle) {
        return Err("Enter a domain such as example.com.".into());
    }
    if !matches!(
        rule.action.as_str(),
        "mark_read" | "move_archive" | "move_trash" | "move_junk" | "move_mailbox"
    ) {
        return Err("That rule action is not supported.".into());
    }
    if rule.action == "move_mailbox"
        && rule
            .target_mailbox
            .as_deref()
            .is_none_or(|target| target.is_empty())
    {
        return Err("Choose the folder to move matching mail into.".into());
    }
    Ok(())
}

/// Host written in a domain rule: labels, a dot, and no address punctuation.
pub(crate) fn valid_sender_domain(value: &str) -> bool {
    let domain = value.trim();
    if domain.len() > 200
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains("..")
        || !domain.contains('.')
    {
        return false;
    }
    domain.split('.').all(|label| {
        let bytes = label.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 63
            && bytes[0] != b'-'
            && *bytes.last().unwrap_or(&b'-') != b'-'
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
    })
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<ConnectionTestStage>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionTestStage {
    Imap,
    Smtp,
}

impl From<String> for IpcError {
    fn from(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let stage = if lower.starts_with("imap connection test failed") {
            Some(ConnectionTestStage::Imap)
        } else if lower.starts_with("smtp connection test failed") {
            Some(ConnectionTestStage::Smtp)
        } else {
            None
        };
        let (code, retryable) = classify_ipc_message(&lower);
        let generic = match code {
            "accessDenied" => "That item is not available for this account.",
            "notFound" => "That item is no longer available. Refresh mail and try again.",
            "limitExceeded" => "That item exceeds Postal Snap's safety limit.",
            "settingsNotFound" => {
                "Settings file could not be found. Choose a Postal Snap settings export."
            }
            "settingsTooLarge" => {
                "That settings file is too large. Choose a file smaller than 64 KiB."
            }
            "settingsInvalid" => "That file is not a valid Postal Snap settings export.",
            "settingsMigrationFailed" => {
                "Postal Snap could not migrate saved settings. Restart Postal Snap, or import/reset settings."
            }
            "settingsReadFailed" => {
                "Postal Snap could not read that settings file. Check its permissions and try again."
            }
            "settingsWriteFailed" => {
                "Postal Snap could not save settings. Check the destination and available disk space, then try again."
            }
            "authenticationFailed" => "Sign-in failed. Check the email address and password.",
            "certificateInvalid" => "Choose one valid, unexpired public PEM certificate exported by Bridge, without a private key.",
            "folderAttention" => "Assigned folder needs attention. Choose another folder or Automatic in Settings.",
            "identityConfirmation" => "Confirm the incoming server identity change before saving.",
            "pendingOperations" => "Resolve queued changes and unsent mail before changing the incoming server identity.",
            "certificateFailed" => "Certificate verification failed. Check the trusted server certificate.",
            "connectionFailed" => "Could not reach the mail server. Check your connection.",
            "localStorageFailed" => "Postal Snap could not access local mail data on your computer.",
            "invalidInput" => "Check the highlighted information and try again.",
            _ => "Postal Snap could not finish that action. Try again.",
        };
        Self {
            code: code.into(),
            // Category guidance beats detail for sign-in, network, and storage.
            message: matches!(code, "operationFailed" | "invalidInput" | "limitExceeded")
                .then(|| authored_detail(&message))
                .flatten()
                .unwrap_or_else(|| generic.into()),
            retryable,
            stage,
        }
    }
}

/// Authored prose passes through so errors stay specific. Anything that may
/// carry data (addresses, names, paths, hosts, server text) is replaced.
fn authored_detail(message: &str) -> Option<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() || trimmed.len() > 300 || !trimmed.is_ascii() {
        return None;
    }
    let chars = trimmed.as_bytes();
    for (index, &byte) in chars.iter().enumerate() {
        let unsafe_byte = byte.is_ascii_control()
            || matches!(
                byte,
                b'"' | b'`' | b'@' | b'/' | b'\\' | b'<' | b'[' | b'{' | b'=' | b'%' | b'#'
            );
        // Only a contraction apostrophe, never a quoted name.
        let quote = byte == b'\''
            && !(index > 0
                && chars[index - 1].is_ascii_alphabetic()
                && chars.get(index + 1).is_some_and(u8::is_ascii_alphabetic));
        if unsafe_byte || quote {
            return None;
        }
    }
    let dotted = trimmed.split_whitespace().any(|word| {
        let core = word.trim_end_matches(['.', ',', ';', '!', '?', ')']);
        core.contains('.') || core.contains(':')
    });
    (!dotted).then(|| trimmed.to_string())
}

impl From<&str> for IpcError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

fn classify_ipc_message(lower: &str) -> (&'static str, bool) {
    if lower.contains("settings could not be migrated")
        || lower.contains("saved application settings could not be migrated")
    {
        return ("settingsMigrationFailed", true);
    }
    if lower.contains("settings file was not found") {
        return ("settingsNotFound", false);
    }
    if lower.contains("settings file is too large")
        || lower.contains("settings payload is too large")
    {
        return ("settingsTooLarge", false);
    }
    if lower.contains("settings export is invalid")
        || lower.contains("invalid application settings")
        || lower.contains("settings path is invalid")
        || lower.contains("settings json is invalid")
    {
        return ("settingsInvalid", false);
    }
    if lower.contains("could not inspect application settings")
        || lower.contains("could not open application settings")
        || lower.contains("could not read application settings")
        || lower.contains("settings path is not a regular file")
        || lower.contains("choose a valid settings file")
    {
        return ("settingsReadFailed", true);
    }
    if lower.contains("could not create application data directory") {
        return ("localStorageFailed", true);
    }
    if lower.contains("could not replace application settings")
        || lower.contains("could not save settings")
        || lower.contains("could not write application settings")
        || lower.contains("settings path has no parent directory")
    {
        return ("settingsWriteFailed", true);
    }
    if lower.contains("assigned folder needs attention") {
        return ("folderAttention", false);
    }
    if lower.contains("confirm the incoming server identity change") {
        return ("identityConfirmation", false);
    }
    if lower.contains("resolve queued changes and unsent mail") {
        return ("pendingOperations", false);
    }
    if lower.contains("public pem certificate")
        || lower.contains("public certificate")
        || lower.contains("selected certificate")
        || lower.contains("one public pem")
    {
        return ("certificateInvalid", false);
    }
    if let Some(action) = redacted_mail_action(lower) {
        return classify_mail_action(action);
    }
    if lower.contains("certificate verification") {
        return ("certificateFailed", true);
    }
    if lower.contains("does not belong")
        || lower.contains("between accounts")
        || lower.contains("permission has expired")
    {
        return ("accessDenied", false);
    }
    if lower.contains("not found") {
        return ("notFound", false);
    }
    if lower.contains("too large") || lower.contains("too many") || lower.contains("exceeded safe")
    {
        return ("limitExceeded", false);
    }
    if lower.contains("sign-in") || lower.contains("credential") || lower.contains("app-specific") {
        return ("authenticationFailed", true);
    }
    if lower.contains("timed out")
        || lower.contains("connection")
        || lower.contains("mail server")
        || lower.contains("offline")
    {
        return ("connectionFailed", true);
    }
    if lower.contains("invalid")
        || lower.starts_with("enter ")
        || lower.starts_with("choose ")
        || lower.starts_with("add ")
        || lower.contains("required")
        || lower.contains("unsupported")
        || lower.starts_with("only ")
    {
        return ("invalidInput", false);
    }
    if lower.contains("database")
        || lower.contains("password vault")
        || lower.contains("account password store")
        || lower.contains("password is unavailable")
    {
        return ("localStorageFailed", true);
    }
    ("operationFailed", true)
}

fn redacted_mail_action(lower: &str) -> Option<&str> {
    let (action, rest) = lower.split_once(" failed.")?;
    if rest.contains("check the")
        && (rest.contains("mail server")
            || rest.contains("internet")
            || rest.contains("password")
            || rest.contains("server settings"))
    {
        Some(action)
    } else {
        None
    }
}

fn classify_mail_action(action: &str) -> (&'static str, bool) {
    if action.contains("sign-in") {
        ("authenticationFailed", true)
    } else if action.contains("certificate") {
        ("invalidInput", false)
    } else if action.contains("connection")
        || action.contains("tls")
        || action.contains("greeting")
        || action.contains("starttls")
        || action.contains("inbox monitoring")
    {
        ("connectionFailed", true)
    } else {
        ("operationFailed", true)
    }
}

pub fn validated_setup(
    request: &AccountSetupRequest,
) -> Result<(ServerConfig, ServerConfig), String> {
    if request.email.trim().parse::<lettre::Address>().is_err()
        || request.email.len() > 320
        || request.display_name.len() > 200
        || request.display_name.contains(char::is_control)
    {
        return Err("Enter a valid email address.".into());
    }
    if request.password.is_empty() || request.password.len() > 4096 {
        return Err("Enter the app-specific or email password.".into());
    }
    let (imap, smtp) = match request.provider {
        ProviderKind::Icloud => {
            let full = request.email.trim().to_lowercase();
            let local = full.split('@').next().unwrap_or(&full).to_string();
            (
                ServerConfig {
                    trusted_certificate: None,
                    host: "imap.mail.me.com".into(),
                    port: 993,
                    tls_mode: TlsMode::Tls,
                    username: local,
                },
                ServerConfig {
                    trusted_certificate: None,
                    host: "smtp.mail.me.com".into(),
                    port: 587,
                    tls_mode: TlsMode::StartTls,
                    username: full,
                },
            )
        }
        ProviderKind::Manual | ProviderKind::ProtonBridge => (
            request
                .imap
                .clone()
                .ok_or("Incoming server settings are required.")?,
            request
                .smtp
                .clone()
                .ok_or("Outgoing server settings are required.")?,
        ),
        ProviderKind::Gmail | ProviderKind::Outlook => {
            return Err(
                "This mailbox signs in through its provider. A password cannot be saved for it."
                    .into(),
            );
        }
    };
    validate_server(&imap)?;
    validate_server(&smtp)?;
    if request.provider == ProviderKind::ProtonBridge {
        crate::bridge::validate_loopback(&imap.host)?;
        crate::bridge::validate_loopback(&smtp.host)?;
    }
    Ok((imap, smtp))
}

pub fn normalize_setup_password(provider: &ProviderKind, password: &str) -> String {
    match provider {
        ProviderKind::Icloud => password.chars().filter(|ch| !ch.is_whitespace()).collect(),
        ProviderKind::Manual
        | ProviderKind::ProtonBridge
        | ProviderKind::Gmail
        | ProviderKind::Outlook => password.trim().to_string(),
    }
}

pub fn take_validated_setup(
    request: &mut AccountSetupRequest,
) -> Result<(ServerConfig, ServerConfig, Zeroizing<String>), String> {
    let (imap, smtp) = validated_setup(request)?;
    let password = Zeroizing::new(normalize_setup_password(
        &request.provider,
        &request.password,
    ));
    request.password.zeroize();
    if password.is_empty() || password.len() > 4096 {
        return Err("Enter the app-specific or email password.".into());
    }
    Ok((imap, smtp, password))
}

pub(crate) fn validate_server(server: &ServerConfig) -> Result<(), String> {
    let host = server.host.trim();
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && !host.contains(char::is_whitespace)
        && !host.contains(char::is_control)
        && (host.parse::<std::net::IpAddr>().is_ok() || {
            !host.contains(['/', '\\', '@', ':', '?', '#', '[', ']'])
                && host.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && label
                            .chars()
                            .all(|character| character.is_alphanumeric() || character == '-')
                })
                && !host.starts_with('-')
                && !host.ends_with('-')
        });
    if !host_ok {
        return Err("Enter a valid mail server name.".into());
    }
    if server.port == 0
        || server.username.trim().is_empty()
        || server.username.len() > 320
        || server.username.contains(char::is_control)
    {
        return Err("Server port and username are required.".into());
    }
    Ok(())
}

/// One mailbox, same rules as the account Reply-To setting.
pub(crate) fn reply_to_is_valid(value: &str) -> bool {
    let trimmed = value.trim();
    !(trimmed.chars().count() > 320
        || trimmed.contains(char::is_control)
        || trimmed.contains(',')
        || trimmed.parse::<lettre::message::Mailbox>().is_err())
}

pub fn validate_compose_draft(draft: &ComposeDraft) -> Result<(), String> {
    if let Some(from) = &draft.from {
        if from.len() > 320
            || from.contains(char::is_control)
            || from.trim().parse::<lettre::message::Mailbox>().is_err()
        {
            return Err("The sender address is invalid.".into());
        }
    }
    let recipients = draft.to.iter().chain(&draft.cc).chain(&draft.bcc);
    if draft.to.len() + draft.cc.len() + draft.bcc.len() > 500
        || recipients
            .clone()
            .any(|value| value.len() > 320 || value.contains(char::is_control))
    {
        return Err("The recipient list is too large or invalid.".into());
    }
    if recipients
        .clone()
        .any(|value| value.trim().parse::<lettre::message::Mailbox>().is_err())
    {
        return Err("Enter valid email addresses for every recipient.".into());
    }
    if let Some(reply_to) = draft.reply_to.as_deref().map(str::trim) {
        if !reply_to.is_empty() && !reply_to_is_valid(reply_to) {
            return Err("Enter one Reply-To address.".into());
        }
    }
    if draft.subject.len() > 998 || draft.subject.contains(char::is_control) {
        return Err("The subject is too long or invalid.".into());
    }
    if draft.html_body.len().saturating_add(draft.text_body.len()) > 50 * 1024 * 1024 {
        return Err("This message is too large.".into());
    }
    if draft.attachments.len() > 100
        || draft.attachments.iter().any(|item| {
            item.token.len() > 4096
                || item.filename.len() > 255
                || item
                    .content_type
                    .as_ref()
                    .is_some_and(|value| value.len() > 255)
                || item
                    .content_id
                    .as_ref()
                    .is_some_and(|value| value.len() > 998 || value.contains(char::is_control))
        })
    {
        return Err("The attachment list is too large or invalid.".into());
    }
    Ok(())
}

pub fn validate_compose_sender(
    from: Option<&str>,
    account_email: &str,
    aliases: &[String],
) -> Result<(), String> {
    let Some(from) = from.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let mailbox: lettre::message::Mailbox = from
        .parse()
        .map_err(|_| "The sender address is invalid.".to_string())?;
    let address = mailbox.email.to_string();
    if sender_address_allowed(&address, account_email, aliases) {
        Ok(())
    } else {
        Err("Choose a From address that belongs to this account.".into())
    }
}

fn sender_address_allowed(address: &str, account_email: &str, aliases: &[String]) -> bool {
    let lower = address.trim().to_ascii_lowercase();
    std::iter::once(account_email)
        .chain(aliases.iter().map(String::as_str))
        .any(|item| item.trim().to_ascii_lowercase() == lower)
}

pub fn validate_folder_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed.contains(char::is_control) {
        return Err("Enter a folder name up to 128 characters.".into());
    }
    if trimmed != name {
        return Err("Remove spaces at the start or end of the folder name.".into());
    }
    if trimmed.eq_ignore_ascii_case("inbox") {
        return Err("That name is reserved for the inbox.".into());
    }
    // Hierarchy separators, LIST wildcards, and quoting characters reach the
    // IMAP session raw; keep names to plain printable text instead.
    if trimmed.contains(['/', '*', '%', '"', '\\'])
        || trimmed.chars().all(|character| character == '.')
    {
        return Err("Folder names cannot contain / * % \" or \\.".into());
    }
    Ok(trimmed.to_string())
}

/// Join a parent mailbox and a leaf into one IMAP name.
/// The leaf follows the same rules as a top-level folder name.
pub fn nested_folder_name(parent: &str, delimiter: &str, leaf: &str) -> Result<String, String> {
    let leaf = validate_folder_name(leaf)?;
    if parent.is_empty() || parent.chars().any(char::is_control) {
        return Err("That folder cannot hold another folder.".into());
    }
    if delimiter.is_empty()
        || delimiter.chars().count() > 4
        || delimiter
            .chars()
            .any(|character| character.is_control() || matches!(character, '*' | '%' | '"' | '\\'))
    {
        return Err("This mail server does not support folders inside folders.".into());
    }
    if leaf.contains(delimiter) {
        return Err("That name cannot contain the folder separator.".into());
    }
    let parent = parent.strip_suffix(delimiter).unwrap_or(parent);
    let name = format!("{parent}{delimiter}{leaf}");
    if name.chars().count() > 400 {
        return Err("That folder name is too long.".into());
    }
    Ok(name)
}

/// A new IMAP name that changes only the last part of a nested folder.
pub fn renamed_folder_name(current: &str, delimiter: &str, leaf: &str) -> Result<String, String> {
    if delimiter.is_empty() || !current.contains(delimiter) {
        return validate_folder_name(leaf);
    }
    match current.rfind(delimiter) {
        Some(index) if index > 0 => nested_folder_name(&current[..index], delimiter, leaf),
        _ => validate_folder_name(leaf),
    }
}

fn folder_leaf(current: &str, delimiter: &str) -> String {
    if delimiter.is_empty() {
        return current.to_string();
    }
    match current.rfind(delimiter) {
        Some(index) => current[index + delimiter.len()..].to_string(),
        None => current.to_string(),
    }
}

/// The IMAP name after moving a folder under `destination_parent`, or to the top.
pub fn moved_folder_name(
    current: &str,
    delimiter: &str,
    destination_parent: Option<&str>,
) -> Result<String, String> {
    let leaf = folder_leaf(current, delimiter);
    let Some(parent) = destination_parent else {
        return validate_folder_name(&leaf);
    };
    if parent == current
        || (!delimiter.is_empty() && parent.starts_with(&format!("{current}{delimiter}")))
    {
        return Err("Choose a different folder.".into());
    }
    nested_folder_name(parent, delimiter, &leaf)
}

pub const ROLE_SOURCE_SPECIAL_USE: &str = "specialUse";
pub const ROLE_SOURCE_NAME: &str = "name";

#[allow(dead_code)]
pub fn mailbox_role(name: &str, attributes: &[String]) -> MailboxRole {
    mailbox_role_assignment(name, attributes).0
}

pub fn mailbox_role_assignment(name: &str, attributes: &[String]) -> (MailboxRole, &'static str) {
    let special_use = mailbox_role_from_attributes(attributes);
    if special_use != MailboxRole::Other {
        return (special_use, ROLE_SOURCE_SPECIAL_USE);
    }
    (mailbox_role_from_name(name), ROLE_SOURCE_NAME)
}

fn mailbox_role_from_attributes(attributes: &[String]) -> MailboxRole {
    let has = |expected: &str| {
        attributes.iter().any(|attribute| {
            attribute
                .trim()
                .trim_start_matches('\\')
                .eq_ignore_ascii_case(expected)
        })
    };
    if has("inbox") {
        return MailboxRole::Inbox;
    }
    if has("sent") {
        return MailboxRole::Sent;
    }
    if has("drafts") {
        return MailboxRole::Drafts;
    }
    if has("archive") || has("all") {
        return MailboxRole::Archive;
    }
    if has("trash") {
        return MailboxRole::Trash;
    }
    if has("junk") || has("spam") {
        return MailboxRole::Junk;
    }
    MailboxRole::Other
}

fn mailbox_role_from_name(name: &str) -> MailboxRole {
    let leaf = name
        .rsplit(['/', '.'])
        .next()
        .unwrap_or(name)
        .to_ascii_lowercase();
    match leaf.as_str() {
        "inbox" | "posteingang" | "boîte de réception" => MailboxRole::Inbox,
        "sent" | "sent messages" | "sent mail" | "sent items" | "gesendet" | "gesendete"
        | "gesendete objekte" | "messages envoyés" | "enviados" => MailboxRole::Sent,
        "drafts" | "entwürfe" | "entwurfe" | "brouillons" | "borradores" => MailboxRole::Drafts,
        "archive" | "all mail" | "archiv" | "alle e-mails" | "tous les messages" | "archivados" => {
            MailboxRole::Archive
        }
        "trash" | "deleted messages" | "deleted items" | "bin" | "papierkorb"
        | "gelöschte objekte" | "corbeille" | "papelera" => MailboxRole::Trash,
        "junk" | "spam" | "junk email" | "junk e-mail" | "spamverdacht" | "indésirables"
        | "correo no deseado" => MailboxRole::Junk,
        _ => MailboxRole::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icloud_uses_local_part_for_imap_and_full_address_for_smtp() {
        let request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Icloud,
            email: "Jane@icloud.com".into(),
            display_name: "Jane".into(),
            password: "secret".into(),
            imap: None,
            smtp: None,
            cache_policy: None,
        };
        let (imap, smtp) = validated_setup(&request).unwrap();
        assert_eq!(imap.username, "jane");
        assert_eq!(smtp.username, "jane@icloud.com");
        assert_eq!(smtp.tls_mode, TlsMode::StartTls);
    }

    #[test]
    fn maps_special_use_before_fallback_names() {
        assert_eq!(mailbox_role("Bin", &["Trash".into()]), MailboxRole::Trash);
        assert_eq!(mailbox_role("Bin", &["\\Trash".into()]), MailboxRole::Trash);
        assert_eq!(mailbox_role("Folder/Sent Messages", &[]), MailboxRole::Sent);
    }

    #[test]
    fn manual_setup_rejects_unsafe_or_incomplete_servers() {
        let request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Manual,
            email: "sam@example.com".into(),
            display_name: "Sam".into(),
            password: "secret".into(),
            imap: Some(ServerConfig {
                trusted_certificate: None,
                host: "http://imap.example.com".into(),
                port: 143,
                tls_mode: TlsMode::StartTls,
                username: "sam".into(),
            }),
            smtp: Some(ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam".into(),
            }),
            cache_policy: None,
        };
        assert!(validated_setup(&request).is_err());
    }

    #[test]
    fn server_names_reject_credentials_ports_and_paths() {
        let valid = |host: &str| {
            validate_server(&ServerConfig {
                trusted_certificate: None,
                host: host.into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam".into(),
            })
            .is_ok()
        };
        assert!(valid("imap.example.com"));
        assert!(valid("mail"));
        assert!(valid("192.0.2.10"));
        assert!(valid("::1"));
        assert!(!valid("user@imap.example.com"));
        assert!(!valid("imap.example.com:993"));
        assert!(!valid("http://imap.example.com"));
        assert!(!valid("imap.example.com/path"));
        assert!(!valid("imap example.com"));
        assert!(!valid("-imap.example.com"));
        assert!(!valid(""));
    }

    #[test]
    fn compose_limits_reject_header_injection_and_excessive_recipients() {
        let mut draft = ComposeDraft {
            body_format: crate::models::BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            include_signature: true,
            importance: String::new(),
            request_receipt: false,
            reply_to: None,
            id: None,
            account_id: "account-1".into(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello\r\nBcc: attacker@example.com".into(),
            html_body: "<p>Hello</p>".into(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
        };
        assert!(validate_compose_draft(&draft).is_err());
        draft.subject = "Hello".into();
        draft.to = vec!["a@example.com".into(); 501];
        assert!(validate_compose_draft(&draft).is_err());
    }

    #[test]
    fn compose_rejects_an_invalid_reply_to() {
        // Failure modes:
        // 1. A two-address Reply-To is accepted.
        // 2. An unparsable Reply-To is accepted and silently dropped.
        // 3. A Reply-To with a control character is accepted.
        // 4. A Reply-To over 320 characters is accepted.
        // 5. A valid Reply-To or an empty one is rejected.
        let mut draft = ComposeDraft {
            body_format: crate::models::BodyFormat::Plain,
            source_message_id: None,
            source_kind: None,
            include_signature: true,
            importance: String::new(),
            request_receipt: false,
            reply_to: Some("a@example.com, b@example.com".into()),
            id: None,
            account_id: "account-1".into(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            html_body: String::new(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
        };
        let message = Err("Enter one Reply-To address.".to_string());
        assert_eq!(validate_compose_draft(&draft), message);
        draft.reply_to = Some("not an address".into());
        assert_eq!(validate_compose_draft(&draft), message);
        draft.reply_to = Some("a@example.com\r\nBcc: x@example.com".into());
        assert_eq!(validate_compose_draft(&draft), message);
        draft.reply_to = Some(format!("{}@example.com", "a".repeat(320)));
        assert_eq!(validate_compose_draft(&draft), message);
        draft.reply_to = Some("Ada <ada@example.com>".into());
        assert!(validate_compose_draft(&draft).is_ok());
        draft.reply_to = Some("   ".into());
        assert!(validate_compose_draft(&draft).is_ok());
        draft.reply_to = None;
        assert!(validate_compose_draft(&draft).is_ok());
    }

    #[test]
    fn ipc_errors_are_structured_and_hide_attachment_names() {
        let ownership = IpcError::from("Message does not belong to this account.");
        assert_eq!(ownership.code, "accessDenied");
        assert!(!ownership.retryable);
        let attachment = IpcError::from("Attachment 'private-name.pdf' is unavailable.");
        assert_eq!(attachment.code, "operationFailed");
        assert!(!attachment.message.contains("private-name.pdf"));
        let connection = IpcError::from("Incoming connection failed.");
        assert_eq!(connection.code, "connectionFailed");
        assert!(connection.retryable);
        let auth = IpcError::from("IMAP sign-in was rejected.");
        assert_eq!(auth.code, "authenticationFailed");
        assert!(auth.message.contains("password"));
        assert!(!auth.message.contains("app-specific"));
        let redacted_auth = IpcError::from(
            "Incoming sign-in failed. Check the server settings, password, and internet connection.",
        );
        assert_eq!(redacted_auth.code, "authenticationFailed");
        let redacted_conn = IpcError::from(
            "Incoming connection failed. Check the server settings, password, and internet connection.",
        );
        assert_eq!(redacted_conn.code, "connectionFailed");
        let redacted_move = IpcError::from(
            "Move failed. Check the server settings, password, and internet connection.",
        );
        assert_eq!(redacted_move.code, "operationFailed");
        let redacted_plain = IpcError::from(crate::security::redact_error(
            &"secret host",
            "Incoming sign-in",
        ));
        assert_eq!(redacted_plain.code, "authenticationFailed");
    }

    // Failure modes for passing authored error text through IPC:
    // 1. A specific, actionable message collapses to "Try again".
    // 2. An address, file name, host, or path reaches the UI.
    // 3. Quoted server text or a template value slips through.
    // 4. Non-ASCII or oversized text reaches the UI.
    #[test]
    fn ipc_errors_keep_authored_text_and_hide_data() {
        let duplicate = IpcError::from("An account with this email address is already set up.");
        assert_eq!(
            duplicate.message,
            "An account with this email address is already set up."
        );
        let restart = IpcError::from(
            "Postal Snap could not safely finish updating this password. Restart Postal Snap before trying again.",
        );
        assert!(restart.message.contains("Restart Postal Snap"));
        assert!(IpcError::from("This message isn't ready.")
            .message
            .contains("isn't"));
        for leaky in [
            "Could not send to jane@example.com.",
            "Attachment 'private-name.pdf' is unavailable.",
            "Could not open C:\\Users\\jane\\mail.eml.",
            "Could not reach imap.example.com right now.",
            "Server said: \"NO quota\"",
            "Folder [Gmail] failed.",
            "Ordner geöffnet.",
        ] {
            let error = IpcError::from(leaky);
            assert!(!error.message.contains("jane"), "{leaky}");
            assert!(!error.message.contains("private-name"), "{leaky}");
            assert!(!error.message.contains("example.com"), "{leaky}");
            assert!(!error.message.contains("quota"), "{leaky}");
            assert!(!error.message.contains("Gmail"), "{leaky}");
            assert!(!error.message.contains("Ordner"), "{leaky}");
        }
        assert!(!IpcError::from("x".repeat(400)).message.contains("xxxx"));
    }

    #[test]
    fn compose_from_must_belong_to_the_account() {
        assert!(validate_compose_sender(None, "sam@example.com", &[]).is_ok());
        assert!(validate_compose_sender(Some("sam@example.com"), "sam@example.com", &[]).is_ok());
        assert!(validate_compose_sender(
            Some("Sam <family@icloud.com>"),
            "sam@example.com",
            &["family@icloud.com".into()]
        )
        .is_ok());
        assert!(
            validate_compose_sender(Some("attacker@example.com"), "sam@example.com", &[]).is_err()
        );
    }

    #[test]
    fn settings_errors_use_safe_actionable_categories() {
        assert_eq!(
            IpcError::from("Settings export is invalid or unsupported.").code,
            "settingsInvalid"
        );
        assert_eq!(
            IpcError::from("Settings file is too large.").code,
            "settingsTooLarge"
        );
        assert_eq!(
            IpcError::from("Could not replace application settings.").code,
            "settingsWriteFailed"
        );
        assert_eq!(
            IpcError::from("Settings file was not found.").code,
            "settingsNotFound"
        );
        assert_eq!(
            IpcError::from("Could not read application settings.").code,
            "settingsReadFailed"
        );
        assert_eq!(
            IpcError::from("Invalid application settings.").code,
            "settingsInvalid"
        );
        assert_eq!(
            IpcError::from("Saved application settings could not be migrated.").code,
            "settingsMigrationFailed"
        );
        assert_eq!(
            IpcError::from("Could not create application data directory.").code,
            "localStorageFailed"
        );
        assert_eq!(
            IpcError::from("The system password vault is unavailable.").code,
            "localStorageFailed"
        );
        assert_eq!(
            IpcError::from("The system password vault could not save this account.").code,
            "localStorageFailed"
        );
        assert_eq!(
            IpcError::from(
                "The password is unavailable. Remove and add this account again.".to_string()
            )
            .code,
            "localStorageFailed"
        );
    }

    #[test]
    fn icloud_accepts_me_and_mac_addresses() {
        for email in ["Pat@me.com", "pat@mac.com"] {
            let request = AccountSetupRequest {
                certificate_reference: None,
                provider: ProviderKind::Icloud,
                email: email.into(),
                display_name: "Pat".into(),
                password: "secret".into(),
                imap: None,
                smtp: None,
                cache_policy: None,
            };
            let (imap, smtp) = validated_setup(&request).unwrap();
            assert_eq!(imap.username, "pat");
            assert_eq!(smtp.username, email.to_ascii_lowercase());
            assert_eq!(imap.host, "imap.mail.me.com");
            assert_eq!(smtp.host, "smtp.mail.me.com");
        }
    }

    #[test]
    fn take_validated_setup_keeps_password_until_after_validation() {
        let mut request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Icloud,
            email: "jane@icloud.com".into(),
            display_name: "Jane".into(),
            password: "abcd efgh ijkl mnop".into(),
            imap: None,
            smtp: None,
            cache_policy: None,
        };
        let (_, _, password) = take_validated_setup(&mut request).unwrap();
        assert_eq!(password.as_str(), "abcdefghijklmnop");
        assert!(request.password.is_empty());
    }

    #[test]
    fn take_validated_setup_rejects_whitespace_only_icloud_password() {
        let mut request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Icloud,
            email: "jane@icloud.com".into(),
            display_name: "Jane".into(),
            password: " \t  ".into(),
            imap: None,
            smtp: None,
            cache_policy: None,
        };
        assert!(take_validated_setup(&mut request).is_err());
    }

    #[test]
    fn taking_password_before_validation_would_fail() {
        let mut request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Icloud,
            email: "jane@icloud.com".into(),
            display_name: "Jane".into(),
            password: "secret".into(),
            imap: None,
            smtp: None,
            cache_policy: None,
        };
        let _taken = std::mem::take(&mut request.password);
        assert!(validated_setup(&request).is_err());
    }

    #[test]
    fn manual_setup_trims_password_without_removing_internal_spaces() {
        let mut request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Manual,
            email: "sam@example.com".into(),
            display_name: "Sam".into(),
            password: "  phrase with spaces  ".into(),
            imap: Some(ServerConfig {
                trusted_certificate: None,
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            }),
            smtp: Some(ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
            }),
            cache_policy: None,
        };
        let (_, _, password) = take_validated_setup(&mut request).unwrap();
        assert_eq!(password.as_str(), "phrase with spaces");
    }

    #[test]
    fn maps_dot_hierarchy_and_extended_fallback_roles() {
        assert_eq!(mailbox_role("INBOX.Sent", &[]), MailboxRole::Sent);
        assert_eq!(mailbox_role("INBOX.Drafts", &[]), MailboxRole::Drafts);
        assert_eq!(mailbox_role("INBOX.Trash", &[]), MailboxRole::Trash);
        assert_eq!(mailbox_role("Deleted Items", &[]), MailboxRole::Trash);
        assert_eq!(mailbox_role("Sent Items", &[]), MailboxRole::Sent);
        assert_eq!(mailbox_role("Junk Email", &[]), MailboxRole::Junk);
        assert_eq!(mailbox_role("Bin", &[]), MailboxRole::Trash);
    }

    #[test]
    fn maps_gmail_and_international_fallback_roles() {
        assert_eq!(mailbox_role("[Gmail]/Sent Mail", &[]), MailboxRole::Sent);
        assert_eq!(mailbox_role("[Gmail]/All Mail", &[]), MailboxRole::Archive);
        assert_eq!(mailbox_role("Gesendet", &[]), MailboxRole::Sent);
        assert_eq!(mailbox_role("Entwürfe", &[]), MailboxRole::Drafts);
        assert_eq!(mailbox_role("Papierkorb", &[]), MailboxRole::Trash);
    }

    #[test]
    fn folder_names_reject_blanks_reserved_and_control_chars() {
        assert_eq!(validate_folder_name("Receipts").unwrap(), "Receipts");
        assert_eq!(validate_folder_name("Bills 2026").unwrap(), "Bills 2026");
        assert!(validate_folder_name("").is_err());
        assert!(validate_folder_name("   ").is_err());
        assert!(validate_folder_name("INBOX").is_err());
        assert!(validate_folder_name("inbox").is_err());
        assert!(validate_folder_name(" Receipts").is_err());
        assert!(validate_folder_name("Receipts ").is_err());
        assert!(validate_folder_name("a\nb").is_err());
        assert!(validate_folder_name(&"a".repeat(129)).is_err());
        assert!(validate_folder_name("a/b").is_err());
        assert!(validate_folder_name("a*b").is_err());
        assert!(validate_folder_name("a%b").is_err());
        assert!(validate_folder_name("a\"b").is_err());
        assert_eq!(
            nested_folder_name("Projects", "/", "2026").unwrap(),
            "Projects/2026"
        );
        assert_eq!(
            nested_folder_name("Projects/", "/", "Notes").unwrap(),
            "Projects/Notes"
        );
        assert_eq!(
            nested_folder_name("INBOX", ".", "Receipts").unwrap(),
            "INBOX.Receipts"
        );
        assert!(nested_folder_name("Projects", "/", "a/b").is_err());
        assert!(nested_folder_name("Projects", "", "Notes").is_err());
        assert!(nested_folder_name("Projects", "/", "inbox").is_err());
        assert!(nested_folder_name("INBOX", ".", "a.b").is_err());
        assert_eq!(
            renamed_folder_name("Projects/2026", "/", "Notes").unwrap(),
            "Projects/Notes"
        );
        assert_eq!(
            renamed_folder_name("Projects/2026/Launch", "/", "Kickoff").unwrap(),
            "Projects/2026/Kickoff"
        );
        assert_eq!(
            renamed_folder_name("Projects", "/", "Client work").unwrap(),
            "Client work"
        );
        assert!(renamed_folder_name("Projects/2026", "/", "a/b").is_err());
        assert_eq!(
            moved_folder_name("Projects/2026", "/", Some("Archive")).unwrap(),
            "Archive/2026"
        );
        assert_eq!(
            moved_folder_name("Projects/2026", "/", None).unwrap(),
            "2026"
        );
        assert_eq!(
            moved_folder_name("Projects", "/", Some("Archive")).unwrap(),
            "Archive/Projects"
        );
        assert_eq!(
            moved_folder_name("Projects/2026", "/", Some("Projects")).unwrap(),
            "Projects/2026"
        );
        assert!(moved_folder_name("Projects", "/", Some("Projects")).is_err());
        assert!(moved_folder_name("Projects", "/", Some("Projects/2026")).is_err());
    }

    fn valid_rule() -> FilterRule {
        FilterRule {
            id: String::new(),
            account_id: "account-1".into(),
            name: "Bills".into(),
            field: "from".into(),
            contains: "power".into(),
            action: "move_archive".into(),
            target_mailbox: None,
            enabled: true,
        }
    }

    #[test]
    fn filter_rules_validate_fields_actions_and_ownership() {
        assert!(validate_filter_rule(&valid_rule(), "account-1").is_ok());
        assert!(validate_filter_rule(&valid_rule(), "other").is_err());
        let mut rule = valid_rule();
        rule.field = "body".into();
        assert!(validate_filter_rule(&rule, "account-1").is_err());
        rule.field = "to".into();
        assert!(validate_filter_rule(&rule, "account-1").is_ok());
        rule = valid_rule();
        rule.action = "move_mailbox".into();
        assert!(validate_filter_rule(&rule, "account-1").is_err());
        rule.target_mailbox = Some("".into());
        assert!(validate_filter_rule(&rule, "account-1").is_err());
        rule.target_mailbox = Some("7".into());
        assert!(validate_filter_rule(&rule, "account-1").is_ok());
        rule = valid_rule();
        rule.contains = "   ".into();
        assert!(validate_filter_rule(&rule, "account-1").is_err());
        rule = valid_rule();
        rule.field = "domain".into();
        rule.contains = "example.com".into();
        assert!(validate_filter_rule(&rule, "account-1").is_ok());
        rule.contains = "example".into();
        assert!(validate_filter_rule(&rule, "account-1").is_err());
        rule.contains = "jane@example.com".into();
        assert!(validate_filter_rule(&rule, "account-1").is_err());
    }

    #[test]
    fn timeouts_are_not_authentication_failures() {
        // W6: a slow network must never park the account as "Sign-in failed".
        for transient in [
            "Incoming server timed out.",
            "Incoming connection failed. Check the mail server, password, and internet connection.",
            "Incoming TLS negotiation timed out.",
        ] {
            assert_eq!(
                IpcError::from(transient).code,
                "connectionFailed",
                "{transient}"
            );
        }
        assert_eq!(
            IpcError::from(
                "Incoming sign-in failed. Check the mail server, password, and internet connection."
            )
            .code,
            "authenticationFailed"
        );
    }
}
