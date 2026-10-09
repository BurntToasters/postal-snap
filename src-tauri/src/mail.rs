pub mod flowed;
pub mod folders;
pub mod icloud;
pub mod ics;
pub mod list_unsubscribe;
pub mod parse;
pub mod pool;
pub mod qresync;
pub mod remote_drafts;
pub mod send;
pub mod source;
pub mod sync;
pub mod utf7;

use std::time::Duration;

use async_imap::Session;
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const IMAP_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
pub const MAX_MESSAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_MIME_PARTS: usize = 500;
const MAX_MULTIPART_DECLARATIONS: usize = 64;
const MAX_ATTACHMENTS: usize = 100;
pub const MAX_OUTGOING_BYTES: usize = 100 * 1024 * 1024;
const INITIAL_MESSAGE_BATCH: u32 = 150;
const BACKFILL_MESSAGE_BATCH: u32 = 75;

type ImapSession = Session<TlsStream<TcpStream>>;

/// Admission control for streamed IMAP body responses. A server-declared
/// RFC822.SIZE is never trusted: only the actual delivered length counts, and
/// the cumulative total bounds how much a single fetch cycle retains.
#[derive(Default)]
pub(crate) struct BodyBudget {
    consumed: usize,
}

impl BodyBudget {
    pub(crate) fn admit(&mut self, actual_len: usize, max_item: usize, max_total: usize) -> bool {
        if actual_len > max_item {
            return false;
        }
        let next = self.consumed.saturating_add(actual_len);
        if next > max_total {
            return false;
        }
        self.consumed = next;
        true
    }
}

pub struct PreparedMessage {
    pub message_id: String,
    pub bytes: Vec<u8>,
}

pub struct RemoteDraftLocation {
    pub uid: u32,
    pub uid_validity: Option<u32>,
}

pub struct RemoteDraftAttachment {
    pub filename: String,
    pub content_type: String,
    pub inline: bool,
    pub content_id: Option<String>,
    pub bytes: Vec<u8>,
}

pub struct RemoteDraftData {
    pub uid: u32,
    pub message_id: Option<String>,
    pub updated_at: String,
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html_body: String,
    pub text_body: String,
    pub in_reply_to: Option<String>,
    pub references: Option<Vec<String>>,
    pub attachments: Vec<RemoteDraftAttachment>,
}

pub struct RemoteDraftSnapshot {
    pub uid_validity: Option<u32>,
    pub uids: Vec<u32>,
    pub drafts: Vec<RemoteDraftData>,
}

pub use folders::{
    create_folder, delete_folder, empty_folder, mark_folder_read, move_remote, move_remote_uids,
    rename_folder, set_remote_flags, set_remote_keyword, set_remote_uid_flags, MoveOptions,
    SourceKeyword,
};
pub use icloud::discover_icloud_aliases;
pub use remote_drafts::{
    delete_remote_draft, extract_attachment, fetch_remote_drafts, upsert_remote_draft,
};
pub use send::{
    apply_signature, ensure_sent_copy, prepare_draft_message, prepare_message, send_prepared,
    SendFailure,
};
#[cfg(test)]
pub use sync::Uncontended;
pub use sync::{
    download_message, idle_inbox, load_older_messages, refresh_mailbox_envelopes, server_search,
    sync_account, test_account, IdleOutcome, SyncHooks, SyncOutcome,
};

#[cfg(test)]
mod tests {
    use super::icloud::{
        extract_tag_value, icloud_follow_up_url, is_allowed_icloud_principal_host,
    };
    use super::parse::{
        attachment_id, decode_imap_text, normalize_rfc_message_id, parse_message,
        validate_mime_resource_shape,
    };
    use super::remote_drafts::parse_remote_draft;
    use super::send::{build_message, connect_imap, message_envelope};
    use super::*;
    use crate::db::{CachedMessage, Database};
    use crate::models::{
        AccountRecord, AccountSetupRequest, AccountSummary, CachePolicy, ComposeAttachment,
        ComposeDraft, FilterRule, MailboxRole, ProviderKind, SearchQuery, ServerConfig, TlsMode,
    };
    use futures_util::TryStreamExt;
    use std::time::Duration;
    use tokio::sync::Notify;

    // Failure scenarios for the populated recovery fixture:
    // - nested and modified-UTF-7 folder names disappear or are decoded incorrectly
    // - advertised UTF8=ACCEPT is enabled before quoted UTF-8 responses parse safely
    // - prior-version encoded names orphan IDs, roles, drafts, UIDs, or queued operations
    // - hierarchical rename fails to encode decoded non-ASCII mailbox names
    // - a reconnect reuses stale UIDs after the server changes UIDVALIDITY
    // - a non-ASCII move commits its COPY but drops the tagged response
    // - a draft APPEND commits but drops its tagged response, so retry uploads another copy
    #[tokio::test]
    #[ignore = "requires npm run test:mail-integration"]
    async fn bridge_recovery_protocol_integration() {
        let mut recovery_findings = Vec::<(&'static str, bool)>::new();
        let certificate = std::fs::read_to_string(
            std::env::var("POSTAL_SNAP_MAIL_TEST_CA_CERT").expect("fixture certificate required"),
        )
        .unwrap();
        let server = |name: &str| ServerConfig {
            host: "127.0.0.1".into(),
            port: std::env::var(name)
                .unwrap_or_else(|_| panic!("missing fixture port {name}"))
                .parse()
                .unwrap(),
            tls_mode: TlsMode::Tls,
            username: "fixture@example.test".into(),
            trusted_certificate: Some(certificate.clone()),
        };
        let account = AccountRecord {
            summary: AccountSummary {
                id: "bridge-recovery-fixture".into(),
                provider: ProviderKind::ProtonBridge,
                email: "fixture@example.test".into(),
                display_name: "Fixture".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
                default_body_format: crate::models::BodyFormat::Plain,
            },
            imap: server("POSTAL_SNAP_BRIDGE_IMAP_RECOVERY"),
            smtp: server("POSTAL_SNAP_BRIDGE_SMTP_RECOVERY"),
        };
        let password = "fixture-password";
        let db = Database::memory();
        db.insert_account(&account).unwrap();

        sync_account(
            &db,
            &account,
            password,
            &CachePolicy::default(),
            &mut Uncontended,
        )
        .await
        .unwrap();
        let folders = db.list_mailboxes(&account.summary.id).unwrap();
        let localized = folders
            .iter()
            .find(|folder| folder.name == "Projects/日本語")
            .unwrap_or_else(|| {
                panic!(
                    "nested modified-UTF-7 folder should keep its Unicode name: {:?}",
                    folders
                        .iter()
                        .map(|folder| &folder.name)
                        .collect::<Vec<_>>()
                )
            });
        assert_eq!(localized.total_count, 1);
        let localized_rows = db.list_messages(localized.id, None, 10).unwrap().items;
        assert_eq!(localized_rows.len(), 1);
        assert_eq!(localized_rows[0].subject, "Project fixture");

        let mut legacy_account = account.clone();
        legacy_account.summary.id = "bridge-legacy-cache-fixture".into();
        legacy_account.summary.email = "legacy@example.test".into();
        let legacy_dir = tempfile::tempdir().unwrap();
        let legacy_path = legacy_dir.path().join("legacy-mail.sqlite");
        let legacy_db = Database::open(&legacy_path).unwrap();
        legacy_db.insert_account(&legacy_account).unwrap();
        let legacy_japanese_wire = super::utf7::encode("Projects/日本語");
        let legacy_ampersand_wire = super::utf7::encode("&ZeVnLIqe-");
        let legacy_japanese_id = legacy_db
            .upsert_mailbox_with_source(
                &legacy_account.summary.id,
                &legacy_japanese_wire,
                &MailboxRole::Other,
                "name",
                Some(1),
                Some(2),
                Some(0),
                1,
            )
            .unwrap();
        let legacy_ampersand_id = legacy_db
            .upsert_mailbox_with_source(
                &legacy_account.summary.id,
                &legacy_ampersand_wire,
                &MailboxRole::Other,
                "name",
                Some(1),
                Some(2),
                Some(0),
                1,
            )
            .unwrap();
        legacy_db
            .set_mailbox_listing(legacy_japanese_id, Some("/"))
            .unwrap();
        legacy_db
            .set_mailbox_listing(legacy_ampersand_id, Some("/"))
            .unwrap();
        let legacy_message = |uid, subject: &str| CachedMessage {
            uid,
            internal_at: None,
            message_id: Some(format!("<legacy-{uid}@example.test>")),
            subject: subject.into(),
            sender_name: "Fixture".into(),
            sender_address: "fixture@example.test".into(),
            recipients: "legacy@example.test".into(),
            received_at: "2026-01-01T12:00:00Z".into(),
            preview: "Legacy cached message".into(),
            is_read: false,
            is_starred: false,
            size: 48,
            to: vec!["legacy@example.test".into()],
            cc: vec![],
            reply_to: None,
            thread_parent: None,
            text_body: "Legacy cached message".into(),
            html_body: None,
            attachments: vec![],
            raw_message: format!("Subject: {subject}\\r\\n\\r\\nLegacy cached message")
                .into_bytes(),
            has_attachments: false,
            is_answered: false,
            is_forwarded: false,
            has_calendar: false,
            calendar_json: None,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
        };
        legacy_db
            .upsert_message(
                &legacy_account.summary.id,
                legacy_japanese_id,
                &legacy_message(1, "Legacy Japanese cache"),
            )
            .unwrap();
        legacy_db
            .upsert_message(
                &legacy_account.summary.id,
                legacy_ampersand_id,
                &legacy_message(1, "Legacy ampersand cache"),
            )
            .unwrap();
        let legacy_japanese_message_id = legacy_db
            .message_summary_by_uid(legacy_japanese_id, 1)
            .unwrap()
            .unwrap()
            .id;
        let legacy_ampersand_message_id = legacy_db
            .message_summary_by_uid(legacy_ampersand_id, 1)
            .unwrap()
            .unwrap()
            .id;
        legacy_db
            .set_folder_assignment(
                &legacy_account.summary.id,
                "sent",
                Some(legacy_ampersand_id),
            )
            .unwrap();
        let legacy_draft = ComposeDraft {
            id: None,
            account_id: legacy_account.summary.id.clone(),
            from: None,
            to: vec![legacy_account.summary.email.clone()],
            cc: vec![],
            bcc: vec![],
            subject: "Legacy remote draft".into(),
            html_body: String::new(),
            text_body: "Legacy remote draft body".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
            body_format: crate::models::BodyFormat::Plain,
            source_message_id: None,
            source_kind: None,
        };
        let legacy_draft_id = legacy_db.save_draft(&legacy_draft).unwrap();
        legacy_db
            .conn()
            .unwrap()
            .execute(
                "UPDATE drafts SET remote_mailbox=?2,remote_uid=9,remote_uid_validity=1,sync_state='synced' WHERE id=?1",
                rusqlite::params![legacy_draft_id, legacy_japanese_wire],
            )
            .unwrap();
        legacy_db
            .queue_operation(
                &legacy_account.summary.id,
                "flags",
                &serde_json::json!({"mailbox": legacy_japanese_wire, "uid": 1, "read": true}),
                Some("legacy-utf7-flags"),
            )
            .unwrap();
        legacy_db
            .queue_operation(
                &legacy_account.summary.id,
                "move",
                &serde_json::json!({"source": legacy_japanese_wire, "destination": legacy_ampersand_wire, "uid": 1}),
                Some("legacy-utf7-move"),
            )
            .unwrap();
        legacy_db
            .queue_operation(
                &legacy_account.summary.id,
                "keyword",
                &serde_json::json!({"mailbox": legacy_japanese_wire, "uid": 1, "keyword": "fixture"}),
                Some("legacy-utf7-keyword"),
            )
            .unwrap();
        legacy_db
            .create_filter_rule(&FilterRule {
                id: String::new(),
                account_id: legacy_account.summary.id.clone(),
                name: "Legacy folder target".into(),
                field: "subject".into(),
                contains: "fixture".into(),
                action: "move_mailbox".into(),
                target_mailbox: Some(legacy_japanese_wire.clone()),
                enabled: true,
            })
            .unwrap();
        drop(legacy_db);
        let old_connection = rusqlite::Connection::open(&legacy_path).unwrap();
        old_connection
            .pragma_update(None, "user_version", 22)
            .unwrap();
        drop(old_connection);
        let legacy_db = Database::open(&legacy_path).unwrap();
        let migrated_schema_version: u32 = legacy_db
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        recovery_findings.push((
            "legacy mailbox cache migration runs before mailbox sync",
            migrated_schema_version == 23
                && legacy_db
                    .mailbox_id_for_name(&legacy_account.summary.id, "Projects/日本語")
                    .unwrap()
                    == Some(legacy_japanese_id)
                && legacy_db
                    .mailbox_id_for_name(&legacy_account.summary.id, "&ZeVnLIqe-")
                    .unwrap()
                    == Some(legacy_ampersand_id),
        ));
        recovery_findings.push((
            "legacy message IDs survive startup migration before sync",
            legacy_db
                .message_summary_by_uid(legacy_japanese_id, 1)
                .unwrap()
                .is_some_and(|message| message.id == legacy_japanese_message_id)
                && legacy_db
                    .message_summary_by_uid(legacy_ampersand_id, 1)
                    .unwrap()
                    .is_some_and(|message| message.id == legacy_ampersand_message_id),
        ));
        recovery_findings.push((
            "legacy UID state survives startup migration before sync",
            legacy_db
                .mailbox_sync_meta(legacy_japanese_id)
                .unwrap()
                .uid_validity
                == Some(1)
                && legacy_db
                    .mailbox_sync_meta(legacy_japanese_id)
                    .unwrap()
                    .uid_next
                    == Some(2),
        ));
        recovery_findings.push((
            "legacy folder assignment survives startup migration before sync",
            legacy_db
                .folder_assignments(&legacy_account.summary.id)
                .unwrap()
                .iter()
                .any(|assignment| {
                    assignment.role == "sent" && assignment.mailbox_id == Some(legacy_ampersand_id)
                }),
        ));
        recovery_findings.push((
            "legacy remote draft target is decoded before sync",
            legacy_db
                .conn()
                .unwrap()
                .query_row(
                    "SELECT remote_mailbox FROM drafts WHERE id=?1",
                    [&legacy_draft_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap()
                .as_deref()
                == Some("Projects/日本語"),
        ));
        recovery_findings.push((
            "legacy filter target is decoded before sync",
            legacy_db
                .list_filter_rules(&legacy_account.summary.id)
                .unwrap()
                .iter()
                .any(|rule| rule.target_mailbox.as_deref() == Some("Projects/日本語")),
        ));
        let startup_queued = legacy_db
            .queued_operations(&legacy_account.summary.id)
            .unwrap()
            .into_iter()
            .map(|(_, kind, payload)| {
                (
                    kind,
                    serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        recovery_findings.push((
            "legacy queued move and flag targets are decoded before sync",
            startup_queued.len() == 3
                && startup_queued
                    .iter()
                    .all(|(kind, value)| match kind.as_str() {
                        "flags" => value["mailbox"] == "Projects/日本語",
                        "keyword" => value["mailbox"] == "Projects/日本語",
                        "move" => {
                            value["source"] == "Projects/日本語"
                                && value["destination"] == "&ZeVnLIqe-"
                        }
                        _ => false,
                    }),
        ));
        let legacy_sync = sync_account(
            &legacy_db,
            &legacy_account,
            password,
            &CachePolicy::default(),
            &mut Uncontended,
        )
        .await;
        recovery_findings.push(("legacy cache sync completes", legacy_sync.is_ok()));
        let legacy_japanese_canonical = legacy_db
            .mailbox_id_for_name(&legacy_account.summary.id, "Projects/日本語")
            .unwrap();
        let legacy_ampersand_canonical = legacy_db
            .mailbox_id_for_name(&legacy_account.summary.id, "&ZeVnLIqe-")
            .unwrap();
        recovery_findings.push((
            "legacy non-ASCII mailbox ID survives name normalization",
            legacy_japanese_canonical == Some(legacy_japanese_id),
        ));
        recovery_findings.push((
            "legacy escaped-ampersand mailbox ID survives name normalization",
            legacy_ampersand_canonical == Some(legacy_ampersand_id),
        ));
        let canonical_japanese_message = legacy_japanese_canonical
            .and_then(|id| legacy_db.message_summary_by_uid(id, 1).ok().flatten());
        let canonical_ampersand_message = legacy_ampersand_canonical
            .and_then(|id| legacy_db.message_summary_by_uid(id, 1).ok().flatten());
        recovery_findings.push((
            "legacy cached message remains attached to its mailbox",
            canonical_japanese_message
                .as_ref()
                .is_some_and(|message| message.id == legacy_japanese_message_id),
        ));
        recovery_findings.push((
            "legacy escaped-ampersand message remains attached to its mailbox",
            canonical_ampersand_message
                .as_ref()
                .is_some_and(|message| message.id == legacy_ampersand_message_id),
        ));
        let legacy_uid_state =
            legacy_japanese_canonical.and_then(|id| legacy_db.mailbox_sync_meta(id).ok());
        recovery_findings.push((
            "legacy UIDVALIDITY and UIDNEXT remain attached to the mailbox",
            legacy_uid_state
                .as_ref()
                .is_some_and(|meta| meta.uid_validity == Some(1) && meta.uid_next == Some(2)),
        ));
        let legacy_assignment = legacy_db
            .folder_assignments(&legacy_account.summary.id)
            .unwrap()
            .into_iter()
            .find(|assignment| assignment.role == "sent");
        recovery_findings.push((
            "legacy folder override retains its mailbox ID",
            legacy_assignment
                .as_ref()
                .is_some_and(|assignment| assignment.mailbox_id == legacy_ampersand_canonical),
        ));
        let legacy_draft_mailbox = legacy_db
            .conn()
            .unwrap()
            .query_row(
                "SELECT remote_mailbox FROM drafts WHERE id=?1",
                [&legacy_draft_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap();
        recovery_findings.push((
            "legacy remote draft tracking uses normalized mailbox name",
            legacy_draft_mailbox.as_deref() == Some("Projects/日本語"),
        ));
        let queued = legacy_db
            .queued_operations(&legacy_account.summary.id)
            .unwrap()
            .into_iter()
            .map(|(_, kind, payload)| {
                (
                    kind,
                    serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let queued_names_preserved = queued.len() == 3
            && queued.iter().all(|(kind, value)| match kind.as_str() {
                "flags" => value["mailbox"] == "Projects/日本語",
                "keyword" => value["mailbox"] == "Projects/日本語",
                "move" => {
                    value["source"] == "Projects/日本語" && value["destination"] == "&ZeVnLIqe-"
                }
                _ => false,
            });
        recovery_findings.push((
            "legacy queued move and flag targets are normalized, not dropped",
            queued_names_preserved,
        ));

        let mut utf8_account = account.clone();
        utf8_account.summary.id = "bridge-utf8-fixture".into();
        utf8_account.imap = server("POSTAL_SNAP_BRIDGE_IMAP_UTF8");
        utf8_account.smtp = server("POSTAL_SNAP_BRIDGE_SMTP_UTF8");
        let utf8_db = Database::memory();
        utf8_db.insert_account(&utf8_account).unwrap();
        sync_account(
            &utf8_db,
            &utf8_account,
            password,
            &CachePolicy::default(),
            &mut Uncontended,
        )
        .await
        .unwrap();
        let advertised_folders = utf8_db.list_mailboxes(&utf8_account.summary.id).unwrap();
        let utf8_folder = advertised_folders
            .iter()
            .find(|folder| folder.name == "Projects/日本語");
        let ampersand_folder = advertised_folders
            .iter()
            .find(|folder| folder.name == "&ZeVnLIqe-");
        recovery_findings.push((
            "advertised UTF8=ACCEPT falls back to modified UTF-7 without name corruption",
            utf8_folder.is_some()
                && ampersand_folder.is_some()
                && utf8_folder.map(|folder| folder.id) != ampersand_folder.map(|folder| folder.id),
        ));
        if let Some(utf8_folder) = utf8_folder {
            assert_eq!(utf8_folder.total_count, 1);
            assert_eq!(
                utf8_db
                    .list_messages(utf8_folder.id, None, 10)
                    .unwrap()
                    .items[0]
                    .subject,
                "UTF8 fixture"
            );
        }
        if let Some(ampersand_folder) = ampersand_folder {
            assert_eq!(ampersand_folder.total_count, 1);
            assert_eq!(
                utf8_db
                    .list_messages(ampersand_folder.id, None, 10)
                    .unwrap()
                    .items[0]
                    .subject,
                "Literal ampersand fixture"
            );
        }
        pool::forget(&utf8_account.summary.id);
        let parent_folder = db
            .mailbox_id_for_name(&account.summary.id, "Projects")
            .unwrap()
            .expect("parent folder should be cached");
        assert_eq!(
            db.server_folder_role(parent_folder).unwrap(),
            crate::models::MailboxRole::Other
        );
        super::rename_folder(&account, password, "Projects", "Plan & Roadmap")
            .await
            .expect("hierarchical rename should encode both mailbox names");
        db.rename_mailbox_local(&account.summary.id, "Projects", "Plan & Roadmap")
            .unwrap();
        pool::forget(&account.summary.id);
        sync_account(
            &db,
            &account,
            password,
            &CachePolicy::default(),
            &mut Uncontended,
        )
        .await
        .unwrap();
        let renamed = db
            .list_mailboxes(&account.summary.id)
            .unwrap()
            .into_iter()
            .find(|folder| folder.name == "Plan & Roadmap/日本語")
            .unwrap_or_else(|| {
                panic!(
                    "renamed subtree should retain its non-ASCII child: {:?}",
                    db.list_mailboxes(&account.summary.id)
                        .unwrap()
                        .iter()
                        .map(|folder| &folder.name)
                        .collect::<Vec<_>>()
                )
            });
        let renamed_rows = db.list_messages(renamed.id, None, 10).unwrap().items;
        assert_eq!(renamed_rows.len(), 1);
        assert_eq!(renamed_rows[0].subject, "Project fixture");
        let search = server_search(
            &db,
            &account,
            password,
            &SearchQuery {
                account_id: account.summary.id.clone(),
                mailbox_id: Some(renamed.id),
                text: "subject:Project".into(),
                all_folders: false,
                limit: 10,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            search.len(),
            1,
            "search should select the renamed wire name"
        );
        let inbox = folders
            .iter()
            .find(|folder| folder.name == "INBOX")
            .unwrap();
        let original = db.list_messages(inbox.id, None, 10).unwrap().items[0].clone();
        assert_eq!(
            db.mailbox_uid_validity(&account.summary.id, "INBOX")
                .unwrap(),
            Some(1)
        );

        pool::forget(&account.summary.id);
        let mut session = connect_imap(&account.imap, password).await.unwrap();
        session
            .run_command_and_check_ok("XFIXTURERESTART")
            .await
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if session.noop().await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok());
        let mut reconnected = false;
        for _ in 0..40 {
            if let Ok(mut fresh) = connect_imap(&account.imap, password).await {
                fresh.logout().await.unwrap();
                reconnected = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            reconnected,
            "fixture should accept a fresh connection after restart"
        );

        sync_account(
            &db,
            &account,
            password,
            &CachePolicy::default(),
            &mut Uncontended,
        )
        .await
        .unwrap();
        assert_eq!(
            db.mailbox_uid_validity(&account.summary.id, "INBOX")
                .unwrap(),
            Some(2)
        );
        let inbox = db
            .mailbox_id_for_name(&account.summary.id, "INBOX")
            .unwrap()
            .unwrap();
        let refreshed = db.list_messages(inbox, None, 10).unwrap().items;
        assert_eq!(refreshed.len(), 1, "old-generation cache must be purged");
        assert_eq!(refreshed[0].uid, original.uid);
        assert_eq!(refreshed[0].subject, "After reconnect");

        let renamed = db
            .mailbox_id_for_name(&account.summary.id, "Plan & Roadmap/日本語")
            .unwrap()
            .unwrap();
        let renamed_message = db.list_messages(renamed, None, 10).unwrap().items[0].clone();
        let moved = super::move_remote(
            &account,
            password,
            "Plan & Roadmap/日本語",
            "Archive/受信",
            renamed_message.uid,
            Some(2),
            super::MoveOptions {
                message_id: renamed_message.message_id.as_deref(),
                dedupe_existing: false,
            },
        )
        .await
        .expect_err("the fixture commits COPY then interrupts its reply");
        assert!(
            !moved.terminal,
            "an ambiguous disconnect must remain retryable"
        );
        super::move_remote(
            &account,
            password,
            "Plan & Roadmap/日本語",
            "Archive/受信",
            renamed_message.uid,
            Some(2),
            super::MoveOptions {
                message_id: renamed_message.message_id.as_deref(),
                dedupe_existing: true,
            },
        )
        .await
        .expect("replay should recognize the already-copied message");

        super::move_remote(
            &account,
            password,
            "INBOX",
            "Archive",
            refreshed[0].uid,
            Some(2),
            super::MoveOptions {
                message_id: refreshed[0].message_id.as_deref(),
                dedupe_existing: false,
            },
        )
        .await
        .expect("unrelated move should still complete");
        pool::forget(&account.summary.id);
        let mut session = connect_imap(&account.imap, password).await.unwrap();
        assert_eq!(
            session.status("INBOX", "(MESSAGES)").await.unwrap().exists,
            0
        );
        assert_eq!(
            session
                .status("Archive", "(MESSAGES)")
                .await
                .unwrap()
                .exists,
            1
        );
        assert_eq!(
            session
                .status(&super::utf7::encode("Plan & Roadmap/日本語"), "(MESSAGES)")
                .await
                .unwrap()
                .exists,
            0
        );
        assert_eq!(
            session
                .status(&super::utf7::encode("Archive/受信"), "(MESSAGES)")
                .await
                .unwrap()
                .exists,
            1
        );
        session.logout().await.unwrap();

        let draft_message_id = "<draft-recovery@example.test>";
        let draft = ComposeDraft {
            id: None,
            account_id: account.summary.id.clone(),
            from: None,
            to: vec![account.summary.email.clone()],
            cc: vec![],
            bcc: vec![],
            subject: "Interrupted draft fixture".into(),
            html_body: String::new(),
            text_body: "Draft survived the interrupted upload".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
            body_format: crate::models::BodyFormat::Plain,
            source_message_id: None,
            source_kind: None,
        };
        let bytes = prepare_draft_message(&account, &draft, draft_message_id)
            .await
            .unwrap();
        assert!(
            upsert_remote_draft(
                &account,
                password,
                "Plan & Roadmap/日本語",
                draft_message_id,
                &bytes,
                None,
                None,
            )
            .await
            .is_err(),
            "the first APPEND commits but loses its tagged response"
        );
        let saved = upsert_remote_draft(
            &account,
            password,
            "Plan & Roadmap/日本語",
            draft_message_id,
            &bytes,
            None,
            None,
        )
        .await
        .expect("retry should find the committed draft by Message-ID");
        let snapshot = fetch_remote_drafts(
            &account,
            password,
            "Plan & Roadmap/日本語",
            &std::collections::HashSet::new(),
        )
        .await
        .unwrap();
        assert_eq!(snapshot.uids, vec![saved.uid]);
        assert_eq!(
            snapshot.drafts.len(),
            1,
            "draft retry must not create a duplicate"
        );
        assert_eq!(
            snapshot.drafts[0].message_id.as_deref(),
            Some(draft_message_id)
        );
        let failures = recovery_findings
            .into_iter()
            .filter_map(|(scenario, passed)| (!passed).then_some(scenario))
            .collect::<Vec<_>>();
        assert!(
            failures.is_empty(),
            "IMAP compatibility regressions: {failures:?}"
        );
    }

    #[test]
    fn parses_and_decodes_mime_message() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Hello\r\nMessage-ID: <one@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from Postal Snap";
        let parsed = parse_message(7, raw, false, true, None).unwrap();
        assert_eq!(parsed.uid, 7);
        assert_eq!(parsed.sender_address, "jane@example.com");
        assert_eq!(parsed.subject, "Hello");
        assert!(parsed.text_body.contains("Hello from Postal Snap"));
        assert_eq!(parsed.message_id.as_deref(), Some("<one@example.com>"));
    }

    // parse_message glue failure modes, written before the glue:
    // - List-Unsubscribe is missed when the header name is not lower-case
    // - List-Unsubscribe-Post is read from the wrong header
    // - unsafe URIs (http:, javascript:) reach the stored value
    // - a text/calendar part (alternative or attachment) is not detected
    // - a calendar that fails to parse hides the fact that one exists
    // - the .ics stops being listed as a saveable attachment
    // - a message with neither header nor calendar reports either
    #[test]
    fn stores_bounded_list_unsubscribe_headers() {
        let raw = b"From: a@example.com\r\nSubject: News\r\nLIST-UNSUBSCRIBE: <https://a.example/u>,\r\n <http://a.example/plain>, <javascript:x>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nbody";
        let parsed = parse_message(1, raw, false, false, None).unwrap();
        assert_eq!(
            parsed.list_unsubscribe.as_deref(),
            Some("<https://a.example/u>")
        );
        assert_eq!(
            parsed.list_unsubscribe_post.as_deref(),
            Some("List-Unsubscribe=One-Click")
        );
        let plain = b"From: a@example.com\r\nSubject: Hi\r\n\r\nbody";
        let parsed = parse_message(2, plain, false, false, None).unwrap();
        assert!(parsed.list_unsubscribe.is_none() && parsed.list_unsubscribe_post.is_none());
        assert!(!parsed.has_calendar && parsed.calendar_json.is_none());
    }

    #[test]
    fn detects_calendar_parts_inline_and_attached() {
        let ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nSUMMARY:Lunch\r\nDTSTART:20261001T120000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let inline = format!(
            "From: a@example.com\r\nSubject: Invite\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nLunch\r\n--b\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\n{ics}--b--\r\n"
        );
        let parsed = parse_message(3, inline.as_bytes(), false, false, None).unwrap();
        assert!(parsed.has_calendar);
        let invite: crate::mail::ics::CalendarInvite =
            serde_json::from_str(parsed.calendar_json.as_deref().unwrap()).unwrap();
        assert_eq!(invite.summary.as_deref(), Some("Lunch"));
        assert_eq!(invite.method.as_deref(), Some("REQUEST"));
        let attached = format!(
            "From: a@example.com\r\nSubject: Invite\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nLunch\r\n--b\r\nContent-Type: text/calendar; name=invite.ics\r\nContent-Disposition: attachment; filename=invite.ics\r\n\r\n{ics}--b--\r\n"
        );
        let parsed = parse_message(4, attached.as_bytes(), false, false, None).unwrap();
        assert!(parsed.has_calendar && parsed.calendar_json.is_some());
        assert!(parsed
            .attachments
            .iter()
            .any(|item| item.filename == "invite.ics"));
        let broken = "From: a@example.com\r\nSubject: Invite\r\nContent-Type: text/calendar\r\n\r\nnot a calendar";
        let parsed = parse_message(5, broken.as_bytes(), false, false, None).unwrap();
        assert!(parsed.has_calendar && parsed.calendar_json.is_none());
    }

    #[test]
    fn normalizes_message_ids_with_or_without_brackets() {
        assert_eq!(
            normalize_rfc_message_id("<one@example.com>").as_deref(),
            Some("<one@example.com>")
        );
        assert_eq!(
            normalize_rfc_message_id("one@example.com").as_deref(),
            Some("<one@example.com>")
        );
        assert_eq!(normalize_rfc_message_id("  "), None);
    }

    #[tokio::test]
    async fn parsed_drafts_keep_the_prepared_message_id() {
        let account = AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
            },
        };
        let draft = ComposeDraft {
            body_format: crate::models::BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            id: None,
            account_id: account.summary.id.clone(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Draft identity".into(),
            html_body: "<p>Draft</p>".into(),
            text_body: "Draft".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
        };
        let message_id = "<draft-22222222-2222-4222-8222-222222222222-1@run.rosie.snap>";
        let bytes = prepare_draft_message(&account, &draft, message_id)
            .await
            .unwrap();
        let parsed = parse_remote_draft(1, &bytes, "2026-08-27T00:00:00Z".into()).unwrap();
        assert_eq!(parsed.message_id.as_deref(), Some(message_id));
        assert_eq!(parsed.from.as_deref(), Some("sam@example.com"));
    }

    #[test]
    fn builds_stable_opaque_attachment_ids() {
        let first = attachment_id("photo.jpg", None, 1024, 0);
        assert_eq!(first, attachment_id("photo.jpg", None, 1024, 0));
        assert_ne!(first, attachment_id("photo.jpg", None, 1024, 1));
        assert_ne!(
            first,
            attachment_id("photo.jpg", Some("cid@example.com"), 1024, 0)
        );
        assert_ne!(first, attachment_id("photo.jpg", None, 2048, 0));
    }

    fn blank_draft() -> ComposeDraft {
        ComposeDraft {
            body_format: crate::models::BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            id: None,
            account_id: "account-1".into(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            html_body: "<p>Hello</p>".into(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
        }
    }

    fn loopback_smtp_account() -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "127.0.0.1".into(),
                port: 1,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "127.0.0.1".into(),
                port: 1,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
        }
    }

    #[test]
    fn smtp_failures_split_into_not_sent_and_uncertain() {
        use super::send::{classify_send_failure, SendFailure};
        // A 4xx reply or a connection that never opened: nothing was accepted.
        assert_eq!(
            classify_send_failure(false, true, false, false),
            SendFailure::NotSentRetry
        );
        assert_eq!(
            classify_send_failure(false, false, false, true),
            SendFailure::NotSentRetry
        );
        // A 5xx reply or failed TLS: not sent, and a retry will not help.
        assert_eq!(
            classify_send_failure(true, false, false, false),
            SendFailure::NotSentRefused
        );
        assert_eq!(
            classify_send_failure(false, false, true, false),
            SendFailure::NotSentRefused
        );
        // Anything else may have dropped after the body: never resend.
        assert_eq!(
            classify_send_failure(false, false, false, false),
            SendFailure::Uncertain
        );
    }

    #[tokio::test]
    async fn refused_smtp_connection_is_not_sent() {
        use super::send::SendFailure;
        // Port 1 on loopback refuses before any SMTP session exists.
        let failure = send_prepared(
            &loopback_smtp_account(),
            "unused",
            &blank_draft(),
            b"Subject: Hello\r\n\r\nHello",
        )
        .await
        .unwrap_err();
        assert_eq!(failure.kind, SendFailure::NotSentRetry);
    }

    #[test]
    fn signatures_append_once_with_escaping() {
        let plain = apply_signature(blank_draft(), "");
        assert_eq!(plain.text_body, "Hello");
        let signed = apply_signature(blank_draft(), "Best,\nSam <sam>");
        assert!(signed.text_body.ends_with("\n\n-- \nBest,\nSam <sam>"));
        assert!(signed.html_body.contains("-- <br>Best,<br>Sam &lt;sam&gt;"));
        let twice = apply_signature(signed.clone(), "Best,\nSam <sam>");
        assert_eq!(twice.text_body, signed.text_body);
        assert_eq!(twice.html_body, signed.html_body);
    }

    #[test]
    fn preserves_inline_part_content_type_and_content_id() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Photo\r\nContent-Type: multipart/related; boundary=postal\r\n\r\n--postal\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Photo</p><img src=\"cid:family-photo@example.com\">\r\n--postal\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename=\"family\"\r\nContent-ID: <family-photo@example.com>\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--postal--\r\n";
        let parsed = parse_message(8, raw, true, false, None).unwrap();
        assert!(parsed
            .html_body
            .as_deref()
            .unwrap_or_default()
            .contains("data-inline-cid=\"family-photo@example.com\""));
        assert!(!parsed
            .html_body
            .as_deref()
            .unwrap_or_default()
            .contains("<img src=\"cid:"));
        let inline = parsed.attachments.first().unwrap();
        assert_eq!(inline.content_type, "image/png");
        assert_eq!(
            inline.content_id.as_deref(),
            Some("family-photo@example.com")
        );
        assert!(inline.inline);
        let (_, bytes) = extract_attachment(raw, &inline.id).unwrap();
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn content_disposition_attachment_is_not_inline() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: File\r\nContent-Type: multipart/mixed; boundary=postal\r\n\r\n--postal\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached\r\n--postal\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=\"photo.png\"\r\nContent-ID: <photo@example.com>\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--postal--\r\n";
        let parsed = parse_message(9, raw, true, false, None).unwrap();
        let part = parsed.attachments.first().unwrap();
        assert_eq!(part.content_id.as_deref(), Some("photo@example.com"));
        assert!(!part.inline);
    }

    #[test]
    fn rejects_excessive_multipart_nesting_before_parsing() {
        let mut raw = String::from("Content-Type: multipart/mixed; boundary=b0\r\n\r\n");
        for index in 0..=MAX_MULTIPART_DECLARATIONS {
            raw.push_str(&format!(
                "--b{index}\r\nContent-Type: multipart/mixed; boundary=b{}\r\n\r\n",
                index + 1
            ));
        }
        assert!(validate_mime_resource_shape(raw.as_bytes()).is_err());
    }

    #[test]
    fn accepts_mime_source_quoted_in_body_text() {
        let body = "multipart/ encountered in quoted source or a digest. ".repeat(200);
        let raw = format!("From: jane@example.com\r\nSubject: digest\r\n\r\n{body}");
        assert!(validate_mime_resource_shape(raw.as_bytes()).is_ok());
    }

    proptest::proptest! {
        #[test]
        fn mime_shape_scan_never_panics(input in proptest::collection::vec(0u8..=255, 0..4096)) {
            let _ = validate_mime_resource_shape(&input);
        }
    }

    #[test]
    fn body_budget_rejects_oversized_items_and_caps_cumulative_bytes() {
        let mut budget = BodyBudget::default();
        assert!(budget.admit(400, 1_000, 1_000));
        assert!(budget.admit(400, 1_000, 1_000));
        assert!(!budget.admit(400, 1_000, 1_000));
        assert!(!budget.admit(201, 1_000, 1_000));
        assert!(budget.admit(200, 1_000, 1_000));

        let mut budget = BodyBudget::default();
        assert!(!budget.admit(1_001, 1_000, 10_000));
        assert!(budget.admit(1_000, 1_000, 10_000));
    }

    #[tokio::test]
    async fn uid_operations_fail_closed_without_mailbox_identity() {
        let account = AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "127.0.0.1".into(),
                port: 1,
                tls_mode: TlsMode::Tls,
                username: "sam".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "127.0.0.1".into(),
                port: 1,
                tls_mode: TlsMode::Tls,
                username: "sam".into(),
            },
        };

        assert!(
            set_remote_flags(&account, "secret", "INBOX", 1, None, Some(true), None)
                .await
                .unwrap_err()
                .message
                .contains("identity is unavailable")
        );
        assert!(move_remote(
            &account,
            "secret",
            "INBOX",
            "Archive",
            1,
            None,
            MoveOptions::default(),
        )
        .await
        .unwrap_err()
        .message
        .contains("identity is unavailable"));
        assert!(empty_folder(&account, "secret", "Trash", None, &[])
            .await
            .unwrap_err()
            .contains("identity is unavailable"));
        assert!(
            download_message(&account, "secret", "INBOX", 1, 10, None, None)
                .await
                .unwrap_err()
                .contains("identity is unavailable")
        );
        assert!(delete_remote_draft(&account, "secret", "Drafts", 1, None)
            .await
            .unwrap_err()
            .contains("identity is unavailable"));
    }

    #[tokio::test]
    async fn builds_multipart_plain_and_html_mail() {
        let account = AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam".into(),
            },
        };
        let draft = ComposeDraft {
            body_format: crate::models::BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            id: None,
            account_id: account.summary.id.clone(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            html_body: "<p>Hello Jane</p>".into(),
            text_body: "Hello Jane".into(),
            attachments: Vec::<ComposeAttachment>::new(),
            in_reply_to: None,
            references: None,
            send_at: None,
        };

        let rendered =
            String::from_utf8(build_message(&account, &draft).await.unwrap().formatted()).unwrap();
        assert!(rendered.contains("multipart/alternative"));
        assert!(rendered.contains("text/plain"));
        assert!(rendered.contains("text/html"));
    }

    #[tokio::test]
    async fn outgoing_mime_hides_bcc_but_envelope_keeps_recipient() {
        let account = AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
            },
        };
        let draft = ComposeDraft {
            body_format: crate::models::BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            id: None,
            account_id: account.summary.id.clone(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec!["hidden@example.com".into()],
            subject: "Private copy".into(),
            html_body: "<p>Hello</p>".into(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
        };
        let prepared = prepare_message(&account, &draft).await.unwrap();
        let rendered = String::from_utf8(prepared.bytes).unwrap();
        assert!(!rendered.to_ascii_lowercase().contains("bcc:"));
        assert!(!rendered.contains("hidden@example.com"));
        let envelope = message_envelope(&account, &draft).unwrap();
        assert!(envelope
            .to()
            .iter()
            .any(|address| address.to_string() == "hidden@example.com"));
    }

    // Live protocol scenarios: matching pins, TLS modes, rejected auth,
    // replacement/hostname mismatch before credentials, required STARTTLS,
    // missing/rejected extensions, expired/private-key imports, hierarchy,
    // delivery, and reconnect after restart.
    #[tokio::test]
    #[ignore = "requires canonical compatibility fixtures"]
    async fn bridge_tls_protocol_integration() {
        use super::send::{test_smtp, SendFailure};
        let pem = std::fs::read_to_string(
            std::env::var("POSTAL_SNAP_MAIL_TEST_CA_CERT").expect("fixture certificate required"),
        )
        .unwrap();
        let endpoint = |name: &str, mode: TlsMode| ServerConfig {
            host: "127.0.0.1".into(),
            port: std::env::var(name)
                .unwrap_or_else(|_| panic!("missing fixture port {name}"))
                .parse()
                .unwrap(),
            tls_mode: mode,
            username: "fixture@example.test".into(),
            trusted_certificate: Some(pem.clone()),
        };
        let mut account = AccountRecord {
            summary: AccountSummary {
                id: "bridge-protocol-fixture".into(),
                provider: ProviderKind::ProtonBridge,
                email: "fixture@example.test".into(),
                display_name: "Fixture".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
                default_body_format: crate::models::BodyFormat::Plain,
            },
            imap: endpoint("POSTAL_SNAP_BRIDGE_IMAP_TLS", TlsMode::Tls),
            smtp: endpoint("POSTAL_SNAP_BRIDGE_SMTP_TLS", TlsMode::Tls),
        };
        let draft = ComposeDraft {
            id: None,
            account_id: account.summary.id.clone(),
            from: None,
            to: vec!["recipient@example.test".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Synthetic compatibility fixture".into(),
            html_body: String::new(),
            text_body: "Synthetic protocol body".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
            body_format: crate::models::BodyFormat::Plain,
            source_message_id: None,
            source_kind: None,
        };
        for variable in [
            "POSTAL_SNAP_BRIDGE_EXPIRED_CERT",
            "POSTAL_SNAP_BRIDGE_PRIVATE_KEY",
        ] {
            let pem = std::fs::read_to_string(
                std::env::var(variable).expect("rejected import fixture required"),
            )
            .unwrap();
            assert!(
                crate::bridge::stage_certificate(pem).is_err(),
                "{variable} must reject before approval"
            );
        }
        let password = "fixture-password";
        for (imap_name, smtp_name, mode) in [
            (
                "POSTAL_SNAP_BRIDGE_IMAP_TLS",
                "POSTAL_SNAP_BRIDGE_SMTP_TLS",
                TlsMode::Tls,
            ),
            (
                "POSTAL_SNAP_BRIDGE_IMAP_STARTTLS",
                "POSTAL_SNAP_BRIDGE_SMTP_STARTTLS",
                TlsMode::StartTls,
            ),
        ] {
            account.imap = endpoint(imap_name, mode.clone());
            account.smtp = endpoint(smtp_name, mode);
            pool::forget(&account.summary.id);
            let lease = pool::checkout(&account, password)
                .await
                .expect("verified pooled fixture connection");
            assert!(
                !lease.capabilities.idle && !lease.capabilities.mv && !lease.capabilities.uidplus
            );
            assert!(
                !lease.capabilities.qresync,
                "rejected ENABLE must retain legacy sync"
            );
            let advertises_condstore = imap_name.ends_with("STARTTLS");
            assert_eq!(lease.capabilities.condstore, advertises_condstore);
            lease.release();
            let reused = pool::checkout(&account, password)
                .await
                .expect("pooled fixture reuse");
            assert!(!reused.capabilities.qresync);
            assert_eq!(reused.capabilities.condstore, advertises_condstore);
            reused.release();
            pool::forget(&account.summary.id);
            let mut session = connect_imap(&account.imap, password)
                .await
                .expect("matching IMAP pin");
            let capabilities = session.capabilities().await.unwrap();
            assert!(!capabilities.has_str("IDLE"));
            let names = session
                .list(None, Some("*"))
                .await
                .unwrap()
                .try_collect::<Vec<_>>()
                .await
                .unwrap();
            assert!(names.iter().any(|name| name.name() == "Labels/Project"));
            assert!(session
                .run_command_and_check_ok("ENABLE QRESYNC")
                .await
                .is_err());
            session.logout().await.unwrap();
            // Bridge labels/All Mail must not take special folder roles.
            let db = Database::memory();
            db.insert_account(&account).unwrap();
            let outcome = sync_account(
                &db,
                &account,
                password,
                &CachePolicy::default(),
                &mut Uncontended,
            )
            .await
            .unwrap();
            assert_eq!(outcome.folder_errors, 0);
            let folders = db.list_mailboxes(&account.summary.id).unwrap();
            for name in ["Labels", "Labels/Project", "Labels/Sent", "All Mail"] {
                let folder = folders
                    .iter()
                    .find(|folder| folder.name == name)
                    .expect("original Bridge hierarchy name");
                assert_eq!(
                    folder.role,
                    crate::models::MailboxRole::Other,
                    "Bridge folder {name} must remain personal"
                );
            }
            assert_eq!(
                folders
                    .iter()
                    .find(|folder| folder.name == "Archive")
                    .unwrap()
                    .role,
                crate::models::MailboxRole::Archive
            );
            assert_eq!(
                db.mailbox_for_role(&account.summary.id, "archive")
                    .unwrap()
                    .unwrap()
                    .1,
                "Archive"
            );
            let mut manual = account.clone();
            manual.summary.id = "manual-protocol-fixture".into();
            manual.summary.provider = ProviderKind::Manual;
            let generic_db = Database::memory();
            generic_db.insert_account(&manual).unwrap();
            let outcome = sync_account(
                &generic_db,
                &manual,
                password,
                &CachePolicy::default(),
                &mut Uncontended,
            )
            .await
            .unwrap();
            assert_eq!(outcome.folder_errors, 0);
            let generic_folders = generic_db.list_mailboxes(&manual.summary.id).unwrap();
            assert_eq!(
                generic_folders
                    .iter()
                    .find(|folder| folder.name == "All Mail")
                    .unwrap()
                    .role,
                crate::models::MailboxRole::Archive
            );
            assert_eq!(
                generic_folders
                    .iter()
                    .find(|folder| folder.name == "Labels/Sent")
                    .unwrap()
                    .role,
                crate::models::MailboxRole::Sent
            );
            pool::forget(&manual.summary.id);
            pool::forget(&account.summary.id);

            assert!(connect_imap(&account.imap, "wrong-password").await.is_err());
            test_smtp(&account.smtp, &account.summary.email, password)
                .await
                .expect("matching SMTP pin");
            assert!(
                test_smtp(&account.smtp, &account.summary.email, "wrong-password")
                    .await
                    .is_err()
            );
            let prepared = prepare_message(&account, &draft).await.unwrap();
            send_prepared(&account, password, &draft, &prepared.bytes)
                .await
                .expect("same-connection pinned send");
        }
        for (imap_name, smtp_name, mode) in [
            (
                "POSTAL_SNAP_BRIDGE_IMAP_MISMATCH",
                "POSTAL_SNAP_BRIDGE_SMTP_MISMATCH",
                TlsMode::Tls,
            ),
            (
                "POSTAL_SNAP_BRIDGE_IMAP_WRONG_HOST",
                "POSTAL_SNAP_BRIDGE_SMTP_WRONG_HOST",
                TlsMode::Tls,
            ),
            (
                "POSTAL_SNAP_BRIDGE_IMAP_NO_STARTTLS",
                "POSTAL_SNAP_BRIDGE_SMTP_NO_STARTTLS",
                TlsMode::StartTls,
            ),
        ] {
            account.imap = endpoint(imap_name, mode.clone());
            account.smtp = endpoint(smtp_name, mode);
            assert!(
                connect_imap(&account.imap, password).await.is_err(),
                "{imap_name} must fail before LOGIN"
            );
            assert!(
                test_smtp(&account.smtp, &account.summary.email, password)
                    .await
                    .is_err(),
                "{smtp_name} must fail before AUTH"
            );
            let prepared = prepare_message(&account, &draft).await.unwrap();
            let error = send_prepared(&account, password, &draft, &prepared.bytes)
                .await
                .expect_err("negative fixture must refuse send");
            assert_ne!(error.kind, SendFailure::Uncertain);
        }
        account.imap = endpoint("POSTAL_SNAP_BRIDGE_IMAP_STARTTLS", TlsMode::StartTls);
        let mut session = connect_imap(&account.imap, password).await.unwrap();
        session
            .run_command_and_check_ok("XFIXTURERESTART")
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if session.noop().await.is_err() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .is_ok(),
            "restart must close the old session"
        );
        let mut reconnected = false;
        for _ in 0..40 {
            if let Ok(mut fresh) = connect_imap(&account.imap, password).await {
                fresh.logout().await.unwrap();
                reconnected = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            reconnected,
            "Bridge must reconnect after controlled restart"
        );
    }

    #[tokio::test]
    #[ignore = "requires npm run test:mail-integration"]
    async fn greenmail_protocol_integration() {
        assert_eq!(
            std::env::var("POSTAL_SNAP_MAIL_INTEGRATION").as_deref(),
            Ok("1")
        );
        let password = "mail-test-password";
        let account = AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "11111111-1111-4111-8111-111111111111".into(),
                provider: ProviderKind::Manual,
                email: "user@example.test".into(),
                display_name: "Postal Snap Test".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "localhost".into(),
                port: 3993,
                tls_mode: TlsMode::Tls,
                username: "user@example.test".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "localhost".into(),
                port: 3465,
                tls_mode: TlsMode::Tls,
                username: "user@example.test".into(),
            },
        };
        let setup = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Manual,
            email: account.summary.email.clone(),
            display_name: account.summary.display_name.clone(),
            password: password.into(),
            imap: Some(account.imap.clone()),
            smtp: Some(account.smtp.clone()),
            cache_policy: None,
        };
        test_account(&setup, &account.imap, &account.smtp, password)
            .await
            .unwrap();
        assert!(connect_imap(&account.imap, "wrong-password").await.is_err());

        let mut session = connect_imap(&account.imap, password).await.unwrap();
        for mailbox in ["Drafts", "Sent", "Archive", "Trash", "Junk"] {
            let _ = session.create(mailbox).await;
        }
        session.logout().await.unwrap();

        let attachment_dir = tempfile::tempdir().unwrap();
        let attachment_path = attachment_dir.path().join("family-note.txt");
        std::fs::write(&attachment_path, b"attachment body").unwrap();
        let draft = ComposeDraft {
            body_format: crate::models::BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            id: None,
            account_id: account.summary.id.clone(),
            from: None,
            to: vec![account.summary.email.clone()],
            cc: vec![],
            bcc: vec![],
            subject: "GreenMail protocol check".into(),
            html_body: "<p>Protocol integration body</p>".into(),
            text_body: "Protocol integration body".into(),
            attachments: vec![ComposeAttachment {
                token: attachment_path.to_string_lossy().into(),
                filename: "family-note.txt".into(),
                content_type: Some("text/plain".into()),
                inline: false,
                content_id: None,
                size: None,
            }],
            in_reply_to: None,
            references: None,
            send_at: None,
        };
        let prepared = prepare_message(&account, &draft).await.unwrap();
        send_prepared(&account, password, &draft, &prepared.bytes)
            .await
            .unwrap();

        let db = Database::memory();
        db.insert_account(&account).unwrap();
        let mut inbox_message = None;
        let mut inbox_counts = None;
        for _ in 0..20 {
            sync_account(
                &db,
                &account,
                password,
                &CachePolicy::default(),
                &mut Uncontended,
            )
            .await
            .unwrap();
            let inbox = db
                .list_mailboxes(&account.summary.id)
                .unwrap()
                .into_iter()
                .find(|mailbox| mailbox.role == crate::models::MailboxRole::Inbox)
                .unwrap();
            inbox_message = db.list_messages(inbox.id, None, 10).unwrap().items.pop();
            inbox_counts = Some((inbox.total_count, inbox.unread_count));
            if inbox_message.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let summary = inbox_message.expect("SMTP delivery reached Inbox");
        assert_eq!(inbox_counts, Some((1, 1)));

        // Get Mail quick pass. Failure modes: (1) it downloads bodies or
        // backfill before returning, so Get Mail takes minutes; (2) it skips
        // new envelopes; (3) it reports no remaining work, so the worker
        // never downloads the skipped bodies.
        let quick_db = Database::memory();
        quick_db.insert_account(&account).unwrap();
        let quick = sync_account(
            &quick_db,
            &account,
            password,
            &CachePolicy::default(),
            &mut QuickPass,
        )
        .await
        .unwrap();
        let quick_inbox = quick_db
            .mailbox_id_for_name(&account.summary.id, "INBOX")
            .unwrap()
            .unwrap();
        assert_eq!(quick_db.cached_message_count(quick_inbox).unwrap(), 1);
        let progress = quick_db
            .account_sync_progress(&account.summary.id, &CachePolicy::default())
            .unwrap();
        assert_eq!(progress.bodies_done, 0);
        assert!(quick.more_work);
        run_until_settled(&quick_db, &account, password, &CachePolicy::default()).await;
        let progress = quick_db
            .account_sync_progress(&account.summary.id, &CachePolicy::default())
            .unwrap();
        assert_eq!(progress.bodies_done, 1);
        let downloaded = download_message(
            &account,
            password,
            "INBOX",
            summary.uid,
            summary.size,
            db.mailbox_uid_validity(&account.summary.id, "INBOX")
                .unwrap(),
            Some(summary.received_at.as_str()),
        )
        .await
        .unwrap();
        assert!(downloaded.text_body.contains("Protocol integration body"));
        let attachment = downloaded.attachments.first().unwrap();
        let (_, bytes) = extract_attachment(&downloaded.raw_message, &attachment.id).unwrap();
        assert_eq!(bytes, b"attachment body");

        set_remote_flags(
            &account,
            password,
            "INBOX",
            summary.uid,
            db.mailbox_uid_validity(&account.summary.id, "INBOX")
                .unwrap(),
            Some(true),
            Some(true),
        )
        .await
        .unwrap();
        sync_account(
            &db,
            &account,
            password,
            &CachePolicy::default(),
            &mut Uncontended,
        )
        .await
        .unwrap();
        let inbox = db
            .list_mailboxes(&account.summary.id)
            .unwrap()
            .into_iter()
            .find(|mailbox| mailbox.role == crate::models::MailboxRole::Inbox)
            .unwrap();
        assert_eq!((inbox.total_count, inbox.unread_count), (1, 0));
        let search = server_search(
            &db,
            &account,
            password,
            &SearchQuery {
                account_id: account.summary.id.clone(),
                mailbox_id: Some(summary.mailbox_id),
                text: "protocol check".into(),
                all_folders: false,
                limit: 25,
            },
        )
        .await
        .unwrap();
        assert!(!search.is_empty());

        let draft_message_id = "<draft-22222222-2222-4222-8222-222222222222-1@run.rosie.snap>";
        let draft_bytes = prepare_draft_message(&account, &draft, draft_message_id)
            .await
            .unwrap();
        let remote = upsert_remote_draft(
            &account,
            password,
            "Drafts",
            draft_message_id,
            &draft_bytes,
            None,
            None,
        )
        .await
        .unwrap();
        let snapshot = fetch_remote_drafts(
            &account,
            password,
            "Drafts",
            &std::collections::HashSet::new(),
        )
        .await
        .unwrap();
        assert!(snapshot.uids.contains(&remote.uid));
        assert!(snapshot
            .drafts
            .iter()
            .any(|item| item.message_id.as_deref() == Some(draft_message_id)));

        ensure_sent_copy(
            &account,
            password,
            "Sent",
            &prepared.message_id,
            &prepared.bytes,
        )
        .await
        .unwrap();
        ensure_sent_copy(
            &account,
            password,
            "Sent",
            &prepared.message_id,
            &prepared.bytes,
        )
        .await
        .unwrap();

        let mut session = connect_imap(&account.imap, password).await.unwrap();
        let sent_status = session.status("Sent", "(MESSAGES)").await.unwrap();
        assert_eq!(sent_status.exists, 1);
        session.logout().await.unwrap();

        let wake = Notify::new();
        wake.notify_one();
        tokio::time::timeout(
            Duration::from_secs(5),
            idle_inbox(&account, password, &wake, Duration::from_secs(120)),
        )
        .await
        .expect("IDLE interruption timed out")
        .unwrap();
        move_remote(
            &account,
            password,
            "INBOX",
            "Archive",
            summary.uid,
            db.mailbox_uid_validity(&account.summary.id, "INBOX")
                .unwrap(),
            MoveOptions::default(),
        )
        .await
        .unwrap();
        let mut reconnected = connect_imap(&account.imap, password).await.unwrap();
        let inbox_status = reconnected.status("INBOX", "(MESSAGES)").await.unwrap();
        let archive_status = reconnected.status("Archive", "(MESSAGES)").await.unwrap();
        assert_eq!(inbox_status.exists, 0);
        assert_eq!(archive_status.exists, 1);
        reconnected.logout().await.unwrap();
    }

    /// Hooks that delete a folder on the server at the first yield point, after
    /// LIST but before that folder's STATUS, to prove one missing folder does
    /// not end the pass (S4) and that yielding reacquires the account (W1).
    struct DeleteFolderAtFirstYield {
        account: AccountRecord,
        password: &'static str,
        folder: &'static str,
        pending: bool,
        visited: Vec<String>,
    }

    impl SyncHooks for DeleteFolderAtFirstYield {
        fn contended(&self) -> bool {
            self.pending
        }

        async fn yield_account(&mut self) {
            self.pending = false;
            let mut session = connect_imap(&self.account.imap, self.password)
                .await
                .unwrap();
            session.delete(self.folder).await.unwrap();
            session.logout().await.unwrap();
        }

        fn progress(&mut self, folder: &str) {
            self.visited.push(folder.to_string());
        }

        // The test account has no vault entry; CI runners have no keyring.
        fn current_password(
            &self,
            _account_id: &str,
        ) -> Result<zeroize::Zeroizing<String>, String> {
            Ok(zeroize::Zeroizing::new(self.password.to_string()))
        }
    }

    /// Hooks for a user-started Get Mail pass.
    struct QuickPass;

    impl SyncHooks for QuickPass {
        fn contended(&self) -> bool {
            false
        }

        async fn yield_account(&mut self) {}

        fn progress(&mut self, _folder: &str) {}

        fn quick(&self) -> bool {
            true
        }
    }

    fn imap_date(days_ago: i64, offset_minutes: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::days(days_ago)
            + chrono::Duration::minutes(offset_minutes))
        .format("\"%d-%b-%Y %H:%M:%S +0000\"")
        .to_string()
    }

    async fn run_until_settled(
        db: &Database,
        account: &AccountRecord,
        password: &str,
        policy: &CachePolicy,
    ) {
        for _ in 0..60 {
            let outcome = sync_account(db, account, password, policy, &mut Uncontended)
                .await
                .unwrap();
            if !outcome.more_work {
                return;
            }
        }
        panic!("sync never settled");
    }

    /// Download policy, backfill, prefetch, expunge and pool behaviour against
    /// a real IMAP server. Covers E2, E3, E5, S2, S4, S5, S8, W1, W6 and W10
    /// from docs/SYNC_FAILURE_MODES.md.
    #[tokio::test]
    #[ignore = "requires npm run test:mail-integration"]
    async fn greenmail_protocol_integration_history() {
        assert_eq!(
            std::env::var("POSTAL_SNAP_MAIL_INTEGRATION").as_deref(),
            Ok("1")
        );
        let password = "mail-test-password";
        let account = AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "44444444-4444-4444-8444-444444444444".into(),
                provider: ProviderKind::Manual,
                email: "history@example.test".into(),
                display_name: "History".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "localhost".into(),
                port: 3993,
                tls_mode: TlsMode::Tls,
                username: "history@example.test".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "localhost".into(),
                port: 3465,
                tls_mode: TlsMode::Tls,
                username: "history@example.test".into(),
            },
        };

        // W6: a rejected password is an authentication failure, not a
        // connection problem, so the worker parks instead of retrying.
        let mut wrong = account.clone();
        wrong.summary.id = "55555555-5555-4555-8555-555555555555".into();
        let rejected = sync_account(
            &Database::memory(),
            &wrong,
            "wrong-password",
            &CachePolicy::default(),
            &mut Uncontended,
        )
        .await
        .unwrap_err();
        assert_eq!(
            crate::models::IpcError::from(rejected.as_str()).code,
            "authenticationFailed"
        );

        // 300 messages older than a year, then 100 from the last ten days,
        // appended oldest first so UID order matches arrival order.
        let mut session = connect_imap(&account.imap, password).await.unwrap();
        for folder in ["Doomed", "Zeta"] {
            let _ = session.create(folder).await;
        }
        for index in 0..400i64 {
            let (days, label) = if index < 300 {
                (400 - index / 10, "old")
            } else {
                (10 - (index - 300) / 10, "recent")
            };
            let body = format!(
                "From: Sender <sender@example.test>\r\nTo: history@example.test\r\nSubject: {label} {index}\r\nMessage-ID: <history-{index}@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody {index}\r\n"
            );
            session
                .append(
                    "INBOX",
                    Some("(\\Seen)"),
                    Some(&imap_date(days, index)),
                    body,
                )
                .await
                .unwrap();
        }
        // S8: a message whose MIME exceeds safe limits always fails to parse.
        let mut poison = String::from(
            "From: Sender <sender@example.test>\r\nTo: history@example.test\r\nSubject: poison\r\nMessage-ID: <poison@example.test>\r\n",
        );
        for depth in 0..70 {
            poison.push_str(&format!(
                "Content-Type: multipart/mixed; boundary=\"b{depth}\"\r\n\r\n--b{depth}\r\n"
            ));
        }
        session
            .append("INBOX", None, Some(&imap_date(1, 0)), poison)
            .await
            .unwrap();
        session
            .append(
                "Zeta",
                None,
                Some(&imap_date(1, 0)),
                "From: a@example.test\r\nSubject: zeta\r\n\r\nzeta\r\n",
            )
            .await
            .unwrap();
        let capabilities = session.capabilities().await.unwrap();
        println!(
            "GreenMail CONDSTORE advertised: {}",
            capabilities.has_str("CONDSTORE")
        );
        session.logout().await.unwrap();

        let db = Database::memory();
        db.insert_account(&account).unwrap();
        let account_id = account.summary.id.clone();
        let recent = CachePolicy {
            mode: "recent".into(),
            days: 90,
            max_bytes: 0,
        };
        db.set_account_cache_policy(&account_id, &recent, &CachePolicy::default())
            .unwrap();

        // S4 and W1: the first pass yields before INBOX; "Doomed" vanishes in
        // between. The pass records one folder error and still syncs Zeta.
        let mut hooks = DeleteFolderAtFirstYield {
            account: account.clone(),
            password,
            folder: "Doomed",
            pending: true,
            visited: Vec::new(),
        };
        let first = sync_account(&db, &account, password, &recent, &mut hooks)
            .await
            .unwrap();
        assert_eq!(first.folder_errors, 1);
        assert!(hooks.visited.iter().any(|folder| folder == "Zeta"));
        let zeta = db
            .mailbox_id_for_name(&account_id, "Zeta")
            .unwrap()
            .unwrap();
        assert_eq!(db.cached_message_count(zeta).unwrap(), 1);

        // E5 and S5: Recent mode stops backfill at the cutoff and downloads
        // bodies only inside it.
        run_until_settled(&db, &account, password, &recent).await;
        let inbox = db
            .mailbox_id_for_name(&account_id, "INBOX")
            .unwrap()
            .unwrap();
        let meta = db.mailbox_sync_meta(inbox).unwrap();
        assert_eq!(meta.backfill_state, "cutoff");
        let cached_recent = db.cached_message_count(inbox).unwrap();
        assert!(
            (101..300).contains(&cached_recent),
            "cached {cached_recent} envelopes"
        );
        let progress = db.account_sync_progress(&account_id, &recent).unwrap();
        assert_eq!(progress.bodies_done, 101, "100 recent bodies plus Zeta");

        // S8: the poison message failed once and is not retried every pass.
        let failures = || -> i64 {
            db.conn()
                .unwrap()
                .query_row(
                    "SELECT prefetch_failures FROM messages WHERE subject='poison'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(failures(), 1);
        sync_account(&db, &account, password, &recent, &mut Uncontended)
            .await
            .unwrap();
        assert_eq!(failures(), 1);

        // "Load older messages" reaches past the cutoff without changing it.
        let (added, has_more) = load_older_messages(&db, &account, password, "INBOX")
            .await
            .unwrap();
        assert!(added > 0 && has_more);
        assert_eq!(
            db.mailbox_sync_meta(inbox).unwrap().backfill_state,
            "cutoff"
        );

        // E2: switching to Download all resumes backfill to the first message
        // and downloads every body.
        assert!(db
            .set_account_cache_policy(
                &account_id,
                &CachePolicy {
                    mode: "full".into(),
                    days: 0,
                    max_bytes: 0,
                },
                &CachePolicy::default()
            )
            .unwrap());
        let full = db
            .account_cache_policy(&account_id, &CachePolicy::default())
            .unwrap();
        run_until_settled(&db, &account, password, &full).await;
        assert_eq!(db.cached_message_count(inbox).unwrap(), 401);
        assert_eq!(
            db.mailbox_sync_meta(inbox).unwrap().backfill_state,
            "complete"
        );
        let progress = db.account_sync_progress(&account_id, &full).unwrap();
        assert_eq!(progress.envelopes_done, progress.envelopes_total);
        assert_eq!(progress.bodies_done, 401, "every parseable body");

        // S2: messages expunged by another client disappear locally.
        let mut other = connect_imap(&account.imap, password).await.unwrap();
        other.select("INBOX").await.unwrap();
        other
            .store("1:5", "+FLAGS.SILENT (\\Deleted)")
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        other
            .expunge()
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        other.logout().await.unwrap();
        sync_account(&db, &account, password, &full, &mut Uncontended)
            .await
            .unwrap();
        assert_eq!(db.cached_message_count(inbox).unwrap(), 396);

        // W10: after forgetting the pooled session, a changed password is
        // really used; the parked login is not silently reused.
        pool::checkout(&account, password).await.unwrap().release();
        pool::forget(&account_id);
        assert!(pool::checkout(&account, "wrong-password").await.is_err());
    }

    /// Get Mail timing against a real iCloud account. Prints step timings and
    /// capability names only; no addresses, subjects, or server text.
    #[tokio::test]
    #[ignore = "requires POSTAL_SNAP_TEST_ICLOUD_EMAIL and POSTAL_SNAP_TEST_ICLOUD_PASSWORD"]
    async fn icloud_live_sync_timing() {
        use std::time::Instant;
        let email = std::env::var("POSTAL_SNAP_TEST_ICLOUD_EMAIL").unwrap();
        let password = std::env::var("POSTAL_SNAP_TEST_ICLOUD_PASSWORD").unwrap();
        let request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Icloud,
            email: email.clone(),
            display_name: "Timing".into(),
            password: password.clone(),
            imap: None,
            smtp: None,
            cache_policy: None,
        };
        let (imap, smtp) = crate::models::validated_setup(&request).unwrap();
        let (imap, smtp) = test_account(&request, &imap, &smtp, &password)
            .await
            .unwrap();

        let started = Instant::now();
        let mut session = connect_imap(&imap, &password).await.unwrap();
        eprintln!("login: {:?}", started.elapsed());
        let step = Instant::now();
        let caps = session.capabilities().await.unwrap();
        let mut names: Vec<String> = caps.iter().map(|cap| format!("{cap:?}")).collect();
        names.sort();
        eprintln!("capability: {:?} -> {}", step.elapsed(), names.join(" "));
        if caps.has_str("QRESYNC") {
            let step = Instant::now();
            let enabled = session.run_command_and_check_ok("ENABLE QRESYNC").await;
            eprintln!(
                "enable qresync: {:?} ok={}",
                step.elapsed(),
                enabled.is_ok()
            );
            let step = Instant::now();
            let selected = session.examine("INBOX").await.unwrap();
            eprintln!("examine: {:?}", step.elapsed());
            let step = Instant::now();
            let since = selected
                .highest_modseq
                .unwrap_or(1)
                .saturating_sub(1)
                .max(1);
            let rows = tokio::time::timeout(
                IMAP_COMMAND_TIMEOUT,
                session
                    .uid_fetch(
                        "1:*",
                        format!("(UID FLAGS) (CHANGEDSINCE {since} VANISHED)"),
                    )
                    .await
                    .unwrap()
                    .try_collect::<Vec<_>>(),
            )
            .await;
            eprintln!(
                "changedsince+vanished: {:?} result={}",
                step.elapsed(),
                match &rows {
                    Ok(Ok(rows)) => format!("{} rows", rows.len()),
                    Ok(Err(_)) => "error".into(),
                    Err(_) => "TIMEOUT".into(),
                }
            );
        }
        let _ = session.logout().await;

        let account = AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "66666666-6666-4666-8666-666666666666".into(),
                provider: ProviderKind::Icloud,
                email,
                display_name: "Timing".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                color: None,
            },
            imap,
            smtp,
        };
        let db = Database::memory();
        db.insert_account(&account).unwrap();
        for pass in 1..=3 {
            let step = Instant::now();
            let result = sync_account(
                &db,
                &account,
                &password,
                &CachePolicy::default(),
                &mut Uncontended,
            )
            .await;
            eprintln!(
                "sync pass {pass}: {:?} ok={}",
                step.elapsed(),
                result.is_ok()
            );
        }
        // An instant `Changed` with no new mail means IDLE wakes itself and
        // the worker loops full passes (the "Checking mail…" spinner).
        let wake = tokio::sync::Notify::new();
        for round in 1..=3 {
            let step = Instant::now();
            let outcome = idle_inbox(&account, &password, &wake, Duration::from_secs(15)).await;
            eprintln!("idle {round}: {:?} -> {outcome:?}", step.elapsed());
        }
        // Get Mail interrupts IDLE; this is how long it waits for the lock.
        let step = Instant::now();
        let (outcome, ()) = tokio::join!(
            idle_inbox(&account, &password, &wake, Duration::from_secs(60)),
            async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                wake.notify_one();
            }
        );
        eprintln!("idle interrupt: {:?} -> {outcome:?}", step.elapsed());
    }

    #[tokio::test]
    #[ignore = "requires POSTAL_SNAP_TEST_ICLOUD_EMAIL and POSTAL_SNAP_TEST_ICLOUD_PASSWORD"]
    async fn icloud_live_connection_smoke() {
        let email = std::env::var("POSTAL_SNAP_TEST_ICLOUD_EMAIL")
            .expect("set POSTAL_SNAP_TEST_ICLOUD_EMAIL outside the repository");
        let password = std::env::var("POSTAL_SNAP_TEST_ICLOUD_PASSWORD")
            .expect("set POSTAL_SNAP_TEST_ICLOUD_PASSWORD outside the repository");
        let request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Icloud,
            email,
            display_name: "Postal Snap Test".into(),
            password,
            imap: None,
            smtp: None,
            cache_policy: None,
        };
        let (imap, smtp) = crate::models::validated_setup(&request).unwrap();
        test_account(&request, &imap, &smtp, &request.password)
            .await
            .unwrap();
    }

    #[test]
    fn extracts_xml_tag_values_with_namespaces() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:propstat>
      <D:prop>
        <D:current-user-principal>
          <D:href>/12345/principal/</D:href>
        </D:current-user-principal>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let principal = extract_tag_value(xml, "current-user-principal").unwrap();
        assert!(principal.contains("/12345/principal/"));
        let href = extract_tag_value(&principal, "href").unwrap();
        assert_eq!(href, "/12345/principal/");
    }

    #[test]
    fn decodes_rfc2047_encoded_imap_text() {
        // "Hello World" encoded in Base64 UTF-8
        let encoded = b"=?UTF-8?B?SGVsbG8gV29ybGQ=?=";
        assert_eq!(decode_imap_text(encoded), "Hello World");

        // Plain text passes through untouched
        let plain = b"Standard English Subject";
        assert_eq!(decode_imap_text(plain), "Standard English Subject");
    }

    #[test]
    fn icloud_principal_host_allowlist_blocks_redirect_targets() {
        assert!(is_allowed_icloud_principal_host("caldav.icloud.com"));
        assert!(is_allowed_icloud_principal_host("p123-caldav.icloud.com"));
        assert!(is_allowed_icloud_principal_host("caldav.apple.com"));
        assert!(!is_allowed_icloud_principal_host("www.icloud.com"));
        assert!(!is_allowed_icloud_principal_host("apple.com"));
        assert!(!is_allowed_icloud_principal_host("evil.example.com"));
        assert!(!is_allowed_icloud_principal_host(
            "icloud.com.evil.example.com"
        ));
        assert!(!is_allowed_icloud_principal_host(""));
        assert_eq!(
            icloud_follow_up_url("/12345/principal/").as_deref(),
            Some("https://caldav.icloud.com/12345/principal/")
        );
        assert_eq!(
            icloud_follow_up_url("https://p123-caldav.icloud.com/principal/").as_deref(),
            Some("https://p123-caldav.icloud.com/principal/")
        );
        assert!(icloud_follow_up_url("http://caldav.icloud.com/principal/").is_none());
        assert!(icloud_follow_up_url("https://www.icloud.com/principal/").is_none());
        assert!(icloud_follow_up_url("https://user:pass@caldav.icloud.com/").is_none());
    }
}
