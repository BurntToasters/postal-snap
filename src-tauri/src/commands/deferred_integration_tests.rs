// Failure modes covered against the TLS GreenMail server:
// - replay before `not_before` sends a deferred move early;
// - undo before commit still lets a canceled move reach the server;
// - commit fails to move the source or creates duplicate destination copies;
// - a test-only path copies replay logic instead of exercising production.
// Reviewed A6-A12 risks also include restart, offline undo, UIDVALIDITY, flag,
// bulk, and sync interleavings; this focused gate exercises deferred moves only.
// The tests call the shared production replay helper; only Tauri event delivery
// is replaced by a callback so the native loop can run without an AppHandle.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{Duration as ChronoDuration, Utc};
use serde_json::Value;
use tempfile::TempDir;

use super::replay_offline_operations_with_notification;
use crate::{
    db::Database,
    mail,
    models::{
        AccountRecord, AccountSummary, BodyFormat, CachePolicy, ComposeDraft, ProviderKind,
        ServerConfig, TlsMode,
    },
};

const PASSWORD: &str = "mail-test-password";
const EMAIL: &str = "user@example.test";

struct Fixture {
    db: Database,
    _directory: TempDir,
    account: AccountRecord,
    message_id: String,
    message_row_id: i64,
    uid: u32,
    uid_validity: u32,
    archive_id: i64,
}

#[derive(Debug, PartialEq)]
struct Notification {
    name: String,
    payload: Value,
}

struct PoolSessionCleanup(String);

impl Drop for PoolSessionCleanup {
    fn drop(&mut self) {
        mail::pool::forget(&self.0);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        mail::pool::forget(&self.account.summary.id);
    }
}

fn account() -> AccountRecord {
    AccountRecord {
        summary: AccountSummary {
            id: uuid::Uuid::new_v4().to_string(),
            provider: ProviderKind::Manual,
            email: EMAIL.into(),
            display_name: "Postal Snap Integration Test".into(),
            sync_state: "idle".into(),
            error: None,
            aliases: vec![],
            auth_method: "password".into(),
            signature: String::new(),
            signature_html: String::new(),
            reply_to: String::new(),
            color: None,
            default_body_format: BodyFormat::Plain,
        },
        imap: ServerConfig {
            host: "localhost".into(),
            port: 3993,
            tls_mode: TlsMode::Tls,
            username: EMAIL.into(),
            trusted_certificate: None,
        },
        smtp: ServerConfig {
            host: "localhost".into(),
            port: 3465,
            tls_mode: TlsMode::Tls,
            username: EMAIL.into(),
            trusted_certificate: None,
        },
    }
}

async fn fixture() -> Fixture {
    assert_eq!(
        std::env::var("POSTAL_SNAP_MAIL_INTEGRATION").as_deref(),
        Ok("1")
    );
    let account = account();
    let directory = tempfile::tempdir().expect("temporary database directory");
    let db = Database::open(&directory.path().join("mail.sqlite"))
        .expect("open temporary mail database");
    db.insert_account(&account)
        .expect("insert synthetic account");

    let mut session = mail::connect::connect_imap(&account.imap, PASSWORD)
        .await
        .expect("connect to GreenMail over verified TLS");
    let _ = session.create("Archive").await;
    session.logout().await.expect("close setup session");

    let draft = ComposeDraft {
        id: None,
        account_id: account.summary.id.clone(),
        from: None,
        to: vec![EMAIL.into()],
        cc: vec![],
        bcc: vec![],
        subject: format!("Deferred move fixture {}", uuid::Uuid::new_v4()),
        html_body: "<p>Deferred move integration fixture.</p>".into(),
        text_body: "Deferred move integration fixture.".into(),
        attachments: vec![],
        in_reply_to: None,
        references: None,
        send_at: None,
        body_format: BodyFormat::Plain,
        source_message_id: None,
        source_kind: None,
        include_signature: false,
        importance: String::new(),
        request_receipt: false,
        reply_to: None,
    };
    let prepared = mail::prepare_message(&account, &draft)
        .await
        .expect("prepare synthetic message");
    mail::send_prepared(&account, PASSWORD, &draft, &prepared.bytes)
        .await
        .unwrap_or_else(|error| panic!("deliver synthetic message: {error:?}"));

    let mut message = None;
    for _ in 0..20 {
        mail::sync::sync_account(
            &db,
            &account,
            PASSWORD,
            &CachePolicy::default(),
            &mut mail::sync::Uncontended,
        )
        .await
        .expect("sync GreenMail envelopes");
        if let Some(inbox_id) = db
            .mailbox_id_for_name(&account.summary.id, "INBOX")
            .expect("look up Inbox")
        {
            message = db
                .list_messages(inbox_id, None, 100)
                .expect("list cached Inbox")
                .items
                .into_iter()
                .find(|item| item.message_id.as_deref() == Some(prepared.message_id.as_str()));
        }
        if message.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let message = message.expect("sent message was cached from GreenMail Inbox");
    let uid_validity = db
        .mailbox_uid_validity(&account.summary.id, "INBOX")
        .expect("read Inbox UIDVALIDITY")
        .expect("GreenMail reports Inbox UIDVALIDITY");
    let archive_id = db
        .mailbox_id_for_name(&account.summary.id, "Archive")
        .expect("look up Archive")
        .expect("sync discovered Archive");

    let source = matching_message_count(&account, PASSWORD, "INBOX", &prepared.message_id).await;
    let destination =
        matching_message_count(&account, PASSWORD, "Archive", &prepared.message_id).await;
    assert_eq!(source, 1, "fixture is present in GreenMail Inbox");
    assert_eq!(destination, 0, "fixture is absent from GreenMail Archive");

    Fixture {
        db,
        _directory: directory,
        account,
        message_id: prepared.message_id,
        message_row_id: message.id,
        uid: message.uid,
        uid_validity,
        archive_id,
    }
}

async fn matching_message_count(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    message_id: &str,
) -> usize {
    let mut session = mail::connect::connect_imap(&account.imap, password)
        .await
        .expect("connect to GreenMail to verify server state");
    session
        .select(mailbox)
        .await
        .unwrap_or_else(|error| panic!("select GreenMail mailbox: {error}"));
    let matches = session
        .search(format!("HEADER Message-ID \"{message_id}\""))
        .await
        .unwrap_or_else(|error| panic!("search GreenMail Message-ID: {error}"));
    session.logout().await.expect("close verification session");
    matches.len()
}

fn defer_move(fixture: &Fixture, undo_token: &str) {
    let operation = serde_json::json!({
        "messageId": fixture.message_row_id,
        "uid": fixture.uid,
        "source": "INBOX",
        "destination": "Archive",
        "uidValidity": fixture.uid_validity,
    });
    fixture
        .db
        .defer_moves(
            &fixture.account.summary.id,
            &[(fixture.message_row_id, operation, fixture.archive_id)],
            undo_token,
            Utc::now() + ChronoDuration::minutes(5),
        )
        .expect("defer move in local database");
}

async fn replay(fixture: &Fixture) -> (bool, Vec<Notification>) {
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let captured = notifications.clone();
    let pending = replay_offline_operations_with_notification(
        &fixture.db,
        &fixture.account,
        PASSWORD,
        &CachePolicy::default(),
        move |name, payload| {
            captured
                .lock()
                .expect("notification lock")
                .push(Notification {
                    name: name.into(),
                    payload: serde_json::to_value(payload).expect("serialize event payload"),
                });
        },
    )
    .await
    .expect("run production offline replay");
    let notifications = Arc::try_unwrap(notifications)
        .expect("notification capture is not shared")
        .into_inner()
        .expect("notification capture lock");
    (pending, notifications)
}

#[tokio::test]
#[ignore = "requires npm run test:mail-integration"]
async fn greenmail_deferred_move_waits_for_commit_and_undo_cancels_it() {
    let fixture = fixture().await;
    let account_id = &fixture.account.summary.id;
    defer_move(&fixture, "undo-before-commit");

    assert!(fixture.db.queued_operations(account_id).unwrap().is_empty());
    assert!(fixture
        .db
        .next_deferred_due(account_id)
        .unwrap()
        .is_some_and(|duration| duration > Duration::from_secs(240)));
    let (pending, notifications) = replay(&fixture).await;
    assert!(!pending, "future deferred work is not reported as due");
    assert!(notifications.is_empty());
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "INBOX", &fixture.message_id).await,
        1,
        "replay before the deadline leaves the source on GreenMail"
    );
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "Archive", &fixture.message_id,).await,
        0,
        "replay before the deadline does not move the message"
    );

    assert_eq!(
        fixture
            .db
            .undo_deferred(account_id, "undo-before-commit")
            .unwrap(),
        (1, false)
    );
    assert!(fixture.db.queued_operations(account_id).unwrap().is_empty());
    let (pending, notifications) = replay(&fixture).await;
    assert!(!pending, "undo leaves no due replay work");
    assert!(notifications.is_empty());
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "INBOX", &fixture.message_id).await,
        1,
        "undo followed by replay never sends the canceled move"
    );
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "Archive", &fixture.message_id,).await,
        0,
        "the canceled message never reaches the destination"
    );
}

#[tokio::test]
#[ignore = "requires npm run test:mail-integration"]
async fn greenmail_committed_deferred_move_replays_once() {
    let fixture = fixture().await;
    let account_id = &fixture.account.summary.id;
    defer_move(&fixture, "commit-deferred-move");
    fixture
        .db
        .commit_deferred(account_id, "commit-deferred-move")
        .unwrap();
    assert!(fixture.db.next_deferred_due(account_id).unwrap().is_none());
    assert_eq!(fixture.db.queued_operations(account_id).unwrap().len(), 1);

    let (pending, notifications) = replay(&fixture).await;
    assert!(!pending, "successful replay drains the operation queue");
    assert!(notifications.is_empty());
    assert!(fixture.db.queued_operations(account_id).unwrap().is_empty());
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "INBOX", &fixture.message_id).await,
        0,
        "committed move removes the source from GreenMail"
    );
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "Archive", &fixture.message_id,).await,
        1,
        "committed move creates exactly one destination copy"
    );

    let (pending, notifications) = replay(&fixture).await;
    assert!(!pending, "second replay sees no queued operation");
    assert!(notifications.is_empty());
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "INBOX", &fixture.message_id).await,
        0,
        "a second replay does not recreate the source"
    );
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "Archive", &fixture.message_id,).await,
        1,
        "a second replay does not duplicate the destination"
    );
}

#[tokio::test]
#[ignore = "requires npm run test:mail-integration"]
async fn greenmail_replay_keeps_dropped_operation_notification_contract() {
    let account = account();
    let directory = tempfile::tempdir().expect("temporary database directory");
    let db = Database::open(&directory.path().join("mail.sqlite"))
        .expect("open temporary mail database");
    let _pool_cleanup = PoolSessionCleanup(account.summary.id.clone());
    db.insert_account(&account)
        .expect("insert synthetic account");
    db.queue_operation(&account.summary.id, "move", &"not-json", Some("bad-move"))
        .unwrap();
    let observed_remaining = Arc::new(Mutex::new(None));
    let observed_in_callback = observed_remaining.clone();
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let captured = notifications.clone();
    let notification_db = db.clone();
    let notification_account_id = account.summary.id.clone();

    let pending = replay_offline_operations_with_notification(
        &db,
        &account,
        PASSWORD,
        &CachePolicy::default(),
        move |name, payload| {
            *observed_in_callback.lock().expect("observation lock") = Some(
                notification_db
                    .queued_operations(&notification_account_id)
                    .unwrap()
                    .len(),
            );
            captured
                .lock()
                .expect("notification lock")
                .push(Notification {
                    name: name.into(),
                    payload: serde_json::to_value(payload).expect("serialize event payload"),
                });
        },
    )
    .await
    .expect("run production offline replay");

    assert!(!pending, "dropping the terminal operation drains the queue");
    assert_eq!(*observed_remaining.lock().unwrap(), Some(0));
    assert_eq!(
        *notifications.lock().unwrap(),
        vec![Notification {
            name: "offline-operations-dropped".into(),
            payload: serde_json::json!({ "accountId": account.summary.id, "count": 1 }),
        }]
    );
    drop(_pool_cleanup);
    drop(db);
    drop(directory);
}

/// A snooze rides along with a replayed move: capture (by row id) before the
/// replay, rebind (by Message-ID header) after the moved copy lands, and the
/// snooze list points at the new row only.
#[tokio::test]
#[ignore = "requires npm run test:mail-integration"]
async fn greenmail_replayed_deferred_move_keeps_the_snooze() {
    let fixture = fixture().await;
    let account_id = &fixture.account.summary.id;

    let snoozed_until = (Utc::now() + ChronoDuration::minutes(60)).to_rfc3339();
    let inbox_id = fixture
        .db
        .mailbox_id_for_name(account_id, "INBOX")
        .expect("look up Inbox")
        .expect("Inbox is cached");
    assert!(
        fixture
            .db
            .list_messages(inbox_id, None, 100)
            .expect("list cached Inbox")
            .items
            .iter()
            .any(|item| item.id == fixture.message_row_id),
        "the fixture message is visible before snoozing"
    );
    fixture
        .db
        .snooze_message(account_id, fixture.message_row_id, &snoozed_until)
        .expect("snooze the fixture message");
    assert!(
        !fixture
            .db
            .list_messages(inbox_id, None, 100)
            .expect("list cached Inbox")
            .items
            .iter()
            .any(|item| item.id == fixture.message_row_id),
        "snoozing hides the message from its folder"
    );

    let mut captures = fixture
        .db
        .capture_snoozes(&[fixture.message_row_id])
        .expect("capture the snooze under the doomed row id");
    assert_eq!(captures.len(), 1, "exactly one snooze was captured");
    let capture = captures.remove(0);
    assert_eq!(
        capture.message_id_header.as_deref(),
        Some(fixture.message_id.as_str()),
        "the capture carries the rebind header"
    );
    assert_eq!(capture.snoozed_until, snoozed_until);

    defer_move(&fixture, "snooze-after-move");
    fixture
        .db
        .commit_deferred(account_id, "snooze-after-move")
        .unwrap();
    let (pending, notifications) = replay(&fixture).await;
    assert!(!pending, "successful replay drains the operation queue");
    assert!(notifications.is_empty());
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "INBOX", &fixture.message_id).await,
        0,
        "committed move removes the source from GreenMail"
    );
    assert_eq!(
        matching_message_count(&fixture.account, PASSWORD, "Archive", &fixture.message_id,).await,
        1,
        "committed move creates exactly one destination copy"
    );

    // Wait for the moved copy to appear in the local Archive cache.
    for _ in 0..20 {
        let found = fixture
            .db
            .find_message_by_header_id_in_mailbox(
                account_id,
                fixture.archive_id,
                &fixture.message_id,
            )
            .expect("look up the moved message");
        if found.is_some() {
            break;
        }
        mail::sync::sync_account(
            &fixture.db,
            &fixture.account,
            PASSWORD,
            &CachePolicy::default(),
            &mut mail::sync::Uncontended,
        )
        .await
        .expect("sync GreenMail into the Archive cache");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let landed = fixture
        .db
        .find_message_by_header_id_in_mailbox(account_id, fixture.archive_id, &fixture.message_id)
        .expect("look up the moved message")
        .expect("the moved message landed in the Archive cache");
    assert_ne!(landed.id, fixture.message_row_id, "the row id changed");

    fixture
        .db
        .restore_snooze_for_message(
            account_id,
            capture.message_id_header.as_deref().expect("header"),
            &capture.snoozed_until,
            &capture.created_at,
        )
        .expect("rebind the captured snooze");

    let archived = fixture
        .db
        .list_messages(fixture.archive_id, None, 100)
        .expect("list cached Archive after restore");
    assert!(
        !archived.items.iter().any(|item| item.id == landed.id),
        "the re-snoozed message hides from its new folder"
    );
    let snoozed = fixture
        .db
        .list_snoozed(account_id, &Utc::now().to_rfc3339())
        .expect("list snoozed mail");
    assert_eq!(
        snoozed
            .iter()
            .map(|entry| (entry.message.id, entry.snoozed_until.clone()))
            .collect::<Vec<_>>(),
        vec![(landed.id, snoozed_until)],
        "exactly the re-bound row is snoozed"
    );
}
