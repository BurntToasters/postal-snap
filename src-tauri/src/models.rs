use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Icloud,
    Manual,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Icloud => "icloud",
            Self::Manual => "manual",
        }
    }
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub tls_mode: TlsMode,
    pub username: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSetupRequest {
    pub provider: ProviderKind,
    pub email: String,
    pub display_name: String,
    pub password: String,
    pub imap: Option<ServerConfig>,
    pub smtp: Option<ServerConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub provider: ProviderKind,
    pub email: String,
    pub display_name: String,
    pub sync_state: String,
    pub error: Option<String>,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCursor {
    pub received_at: String,
    pub uid: u32,
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
    pub reply_to: Option<String>,
    pub text_body: String,
    pub html_body: Option<String>,
    pub remote_images_blocked: bool,
    pub attachments: Vec<Attachment>,
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
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html_body: String,
    pub text_body: String,
    pub attachments: Vec<ComposeAttachment>,
    pub in_reply_to: Option<String>,
    pub references: Option<Vec<String>>,
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
    pub created_at: String,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
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
            folder_pane_width: 248,
            message_pane_width: 390,
            reader_pane_height: 360,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    pub bytes: u64,
    pub max_bytes: u64,
    pub message_count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionChannel {
    pub kind: String,
    pub updates_managed_by: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl From<String> for IpcError {
    fn from(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let (code, retryable) = if lower.contains("does not belong")
            || lower.contains("between accounts")
            || lower.contains("permission has expired")
        {
            ("accessDenied", false)
        } else if lower.contains("not found") {
            ("notFound", false)
        } else if lower.contains("too large")
            || lower.contains("too many")
            || lower.contains("exceeded safe")
        {
            ("limitExceeded", false)
        } else if lower.contains("sign-in")
            || lower.contains("password")
            || lower.contains("credential")
        {
            ("authenticationFailed", true)
        } else if lower.contains("timed out")
            || lower.contains("connection")
            || lower.contains("mail server")
            || lower.contains("offline")
        {
            ("connectionFailed", true)
        } else if lower.contains("database") || lower.contains("settings") {
            ("localStorageFailed", true)
        } else if lower.contains("invalid")
            || lower.starts_with("enter ")
            || lower.starts_with("choose ")
            || lower.starts_with("add ")
            || lower.contains("required")
            || lower.contains("unsupported")
            || lower.starts_with("only ")
        {
            ("invalidInput", false)
        } else {
            ("operationFailed", true)
        };
        let message = match code {
            "accessDenied" => "That item is not available for this account.",
            "notFound" => "That item is no longer available. Refresh mail and try again.",
            "limitExceeded" => "That item exceeds Postal Snap's safety limit.",
            "authenticationFailed" => {
                "Sign-in failed. Check the email address and password."
            }
            "connectionFailed" => "Could not reach the mail server. Check your connection.",
            "localStorageFailed" => "Postal Snap could not save this change on your computer.",
            "invalidInput" => "Check the highlighted information and try again.",
            _ => "Postal Snap could not finish that action. Try again.",
        };
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }
}

impl From<&str> for IpcError {
    fn from(message: &str) -> Self {
        message.to_string().into()
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
                    host: "imap.mail.me.com".into(),
                    port: 993,
                    tls_mode: TlsMode::Tls,
                    username: local,
                },
                ServerConfig {
                    host: "smtp.mail.me.com".into(),
                    port: 587,
                    tls_mode: TlsMode::StartTls,
                    username: full,
                },
            )
        }
        ProviderKind::Manual => (
            request
                .imap
                .clone()
                .ok_or("Incoming server settings are required.")?,
            request
                .smtp
                .clone()
                .ok_or("Outgoing server settings are required.")?,
        ),
    };
    validate_server(&imap)?;
    validate_server(&smtp)?;
    Ok((imap, smtp))
}

fn validate_server(server: &ServerConfig) -> Result<(), String> {
    if server.host.trim().is_empty()
        || server.host.len() > 253
        || server.host.contains('/')
        || server.host.contains(char::is_whitespace)
    {
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

pub fn validate_compose_draft(draft: &ComposeDraft) -> Result<(), String> {
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
                    .is_some_and(|value| value.len() > 998)
        })
    {
        return Err("The attachment list is too large or invalid.".into());
    }
    Ok(())
}

pub fn mailbox_role(name: &str, attributes: &[String]) -> MailboxRole {
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
    let leaf = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
    match leaf.as_str() {
        "inbox" => MailboxRole::Inbox,
        "sent" | "sent messages" | "sent mail" => MailboxRole::Sent,
        "drafts" => MailboxRole::Drafts,
        "archive" | "all mail" => MailboxRole::Archive,
        "trash" | "deleted messages" => MailboxRole::Trash,
        "junk" | "spam" => MailboxRole::Junk,
        _ => MailboxRole::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icloud_uses_local_part_for_imap_and_full_address_for_smtp() {
        let request = AccountSetupRequest {
            provider: ProviderKind::Icloud,
            email: "Jane@icloud.com".into(),
            display_name: "Jane".into(),
            password: "secret".into(),
            imap: None,
            smtp: None,
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
            provider: ProviderKind::Manual,
            email: "sam@example.com".into(),
            display_name: "Sam".into(),
            password: "secret".into(),
            imap: Some(ServerConfig {
                host: "http://imap.example.com".into(),
                port: 143,
                tls_mode: TlsMode::StartTls,
                username: "sam".into(),
            }),
            smtp: Some(ServerConfig {
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam".into(),
            }),
        };
        assert!(validated_setup(&request).is_err());
    }

    #[test]
    fn compose_limits_reject_header_injection_and_excessive_recipients() {
        let mut draft = ComposeDraft {
            id: None,
            account_id: "account-1".into(),
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello\r\nBcc: attacker@example.com".into(),
            html_body: "<p>Hello</p>".into(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
        };
        assert!(validate_compose_draft(&draft).is_err());
        draft.subject = "Hello".into();
        draft.to = vec!["a@example.com".into(); 501];
        assert!(validate_compose_draft(&draft).is_err());
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
    }

    #[test]
    fn icloud_accepts_me_and_mac_addresses() {
        for email in ["Pat@me.com", "pat@mac.com"] {
            let request = AccountSetupRequest {
                provider: ProviderKind::Icloud,
                email: email.into(),
                display_name: "Pat".into(),
                password: "secret".into(),
                imap: None,
                smtp: None,
            };
            let (imap, smtp) = validated_setup(&request).unwrap();
            assert_eq!(imap.username, "pat");
            assert_eq!(smtp.username, email.to_ascii_lowercase());
            assert_eq!(imap.host, "imap.mail.me.com");
            assert_eq!(smtp.host, "smtp.mail.me.com");
        }
    }
}
