pub mod folders;
pub mod icloud;
pub mod parse;
pub mod remote_drafts;
pub mod send;
pub mod sync;

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
    create_folder, delete_folder, empty_folder, move_remote, move_remote_uids, rename_folder,
    set_remote_flags, set_remote_uid_flags, MoveOptions,
};
pub use icloud::discover_icloud_aliases;
pub use remote_drafts::{
    delete_remote_draft, extract_attachment, fetch_remote_drafts, upsert_remote_draft,
};
pub use send::{
    apply_signature, ensure_sent_copy, prepare_draft_message, prepare_message, send_prepared,
};
pub use sync::{
    download_message, idle_inbox, refresh_mailbox_envelopes, server_search, sync_account,
    test_account,
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
    use crate::db::Database;
    use crate::models::{
        AccountRecord, AccountSetupRequest, AccountSummary, CachePolicy, ComposeAttachment,
        ComposeDraft, ProviderKind, SearchQuery, ServerConfig, TlsMode,
    };
    use std::time::Duration;
    use tokio::sync::Notify;

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
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
            },
            imap: ServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
            smtp: ServerConfig {
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
            },
        };
        let draft = ComposeDraft {
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
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
            },
            imap: ServerConfig {
                host: "127.0.0.1".into(),
                port: 1,
                tls_mode: TlsMode::Tls,
                username: "sam".into(),
            },
            smtp: ServerConfig {
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
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
            },
            imap: ServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam".into(),
            },
            smtp: ServerConfig {
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam".into(),
            },
        };
        let draft = ComposeDraft {
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
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
            },
            imap: ServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
            smtp: ServerConfig {
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
            },
        };
        let draft = ComposeDraft {
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
                id: "11111111-1111-4111-8111-111111111111".into(),
                provider: ProviderKind::Manual,
                email: "user@example.test".into(),
                display_name: "Postal Snap Test".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
            },
            imap: ServerConfig {
                host: "localhost".into(),
                port: 3993,
                tls_mode: TlsMode::Tls,
                username: "user@example.test".into(),
            },
            smtp: ServerConfig {
                host: "localhost".into(),
                port: 3465,
                tls_mode: TlsMode::Tls,
                username: "user@example.test".into(),
            },
        };
        let setup = AccountSetupRequest {
            provider: ProviderKind::Manual,
            email: account.summary.email.clone(),
            display_name: account.summary.display_name.clone(),
            password: password.into(),
            imap: Some(account.imap.clone()),
            smtp: Some(account.smtp.clone()),
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
            sync_account(&db, &account, password, &CachePolicy::default())
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
        sync_account(&db, &account, password, &CachePolicy::default())
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
            idle_inbox(&account, password, &wake),
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

    #[tokio::test]
    #[ignore = "requires POSTAL_SNAP_TEST_ICLOUD_EMAIL and POSTAL_SNAP_TEST_ICLOUD_PASSWORD"]
    async fn icloud_live_connection_smoke() {
        let email = std::env::var("POSTAL_SNAP_TEST_ICLOUD_EMAIL")
            .expect("set POSTAL_SNAP_TEST_ICLOUD_EMAIL outside the repository");
        let password = std::env::var("POSTAL_SNAP_TEST_ICLOUD_PASSWORD")
            .expect("set POSTAL_SNAP_TEST_ICLOUD_PASSWORD outside the repository");
        let request = AccountSetupRequest {
            provider: ProviderKind::Icloud,
            email,
            display_name: "Postal Snap Test".into(),
            password,
            imap: None,
            smtp: None,
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
