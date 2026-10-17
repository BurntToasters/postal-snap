//! Snoozes that follow a message across a server move.
//!
//! A move gives the copy a new row id and a new UID. The snooze becomes a
//! transfer keyed by account, destination mailbox, and Message-ID header. It
//! lands on the destination copy the next time that mailbox stores envelopes.

use super::{db_error, messages::remove_message_in_transaction, Database};
use rusqlite::{params, OptionalExtension, Transaction};

/// Same clock format and comparison as `NOT_SNOOZED_SQL`.
const NOW_SQL: &str = "strftime('%Y-%m-%dT%H:%M:%S+00:00','now')";

database_operations! {
impl Database {
    /// Delete source rows after a successful remote move (live, deferred, or
    /// queued), in one transaction.
    /// A snooze on a message with a Message-ID header becomes a transfer for
    /// the destination mailbox. A snooze cannot be keyed when the message has
    /// no Message-ID or the destination folder is not cached yet; it is dropped
    /// and the copy shows in its new folder. The source rows always go.
    pub fn remove_moved_messages(
        &self,
        account_id: &str,
        message_row_ids: &[i64],
        destination: &str,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let destination_id: Option<i64> = transaction
            .query_row(
                "SELECT id FROM mailboxes WHERE account_id=?1 AND name=?2",
                params![account_id, destination],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        for &message_row_id in message_row_ids {
            let Some(destination_id) = destination_id else {
                remove_message_in_transaction(&transaction, message_row_id)?;
                continue;
            };
            transaction
                .execute(
                    "INSERT INTO pending_snooze_transfers(account_id,mailbox_id,message_id_header,snoozed_until,created_at)
                     SELECT s.account_id,?2,m.message_id,s.snoozed_until,s.created_at
                     FROM snoozed_messages s JOIN messages m ON m.id=s.message_id AND m.account_id=s.account_id
                     WHERE s.message_id=?1 AND m.message_id IS NOT NULL AND m.message_id<>''
                     ON CONFLICT(account_id,mailbox_id,message_id_header)
                     DO UPDATE SET snoozed_until=excluded.snoozed_until, created_at=excluded.created_at",
                    params![message_row_id, destination_id],
                )
                .map_err(db_error)?;
            remove_message_in_transaction(&transaction, message_row_id)?;
        }
        transaction.commit().map_err(db_error)
    }

    /// Land pending transfers for one mailbox. Expired transfers are dropped.
    /// Only rows in that mailbox, not under a pending move, are candidates;
    /// the highest UID wins when several copies share the header.
    pub fn apply_pending_snooze_transfers(
        &self,
        account_id: &str,
        mailbox_id: i64,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        apply_in_transaction(&transaction, account_id, mailbox_id)?;
        transaction.commit().map_err(db_error)
    }
}
}

/// Used by envelope writes so a fetched chunk and its transfers commit together.
pub(crate) fn apply_in_transaction(
    transaction: &Transaction<'_>,
    account_id: &str,
    mailbox_id: i64,
) -> Result<(), String> {
    transaction
        .execute(
            &format!(
                "DELETE FROM pending_snooze_transfers
                 WHERE account_id=?1 AND mailbox_id=?2 AND snoozed_until<={NOW_SQL}"
            ),
            params![account_id, mailbox_id],
        )
        .map_err(db_error)?;
    let transfers: Vec<(String, String, String)> = {
        let mut statement = transaction
            .prepare_cached(
                "SELECT message_id_header,snoozed_until,created_at FROM pending_snooze_transfers
                 WHERE account_id=?1 AND mailbox_id=?2",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![account_id, mailbox_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows
    };
    for (header, snoozed_until, created_at) in transfers {
        let landing: Option<i64> = transaction
            .query_row(
                "SELECT id FROM messages
                 WHERE account_id=?1 AND mailbox_id=?2 AND message_id=?3 AND pending_move_to IS NULL
                 ORDER BY uid DESC LIMIT 1",
                params![account_id, mailbox_id, header],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let Some(landing) = landing else {
            continue;
        };
        transaction
            .execute(
                "INSERT OR IGNORE INTO snoozed_messages(account_id,message_id,snoozed_until,created_at)
                 VALUES(?1,?2,?3,?4)",
                params![account_id, landing, snoozed_until, created_at],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM pending_snooze_transfers
                 WHERE account_id=?1 AND mailbox_id=?2 AND message_id_header=?3",
                params![account_id, mailbox_id, header],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::{CachedMessage, Database};
    use crate::models::{
        AccountRecord, AccountSummary, BodyFormat, MailboxRole, ProviderKind, ServerConfig, TlsMode,
    };

    const FUTURE: &str = "2999-01-01T00:00:00+00:00";
    const PAST: &str = "2000-01-01T00:00:00+00:00";
    const NOW: &str = "2026-01-01T00:00:00+00:00";

    fn with_account() -> (Database, String) {
        let database = Database::memory();
        let account = AccountRecord {
            summary: AccountSummary {
                default_body_format: BodyFormat::Html,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                signature_html: String::new(),
                reply_to: String::new(),
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
        database.insert_account(&account).unwrap();
        (database, account.summary.id.clone())
    }

    fn mailbox(db: &Database, name: &str, role: &MailboxRole) -> i64 {
        db.upsert_mailbox("account-1", name, role, Some(1), Some(100), None, 0)
            .unwrap()
    }

    /// A cached row with the given Message-ID header (or none).
    fn copy(uid: u32, header: Option<&str>) -> CachedMessage {
        CachedMessage {
            uid,
            internal_at: None,
            message_id: header.map(str::to_string),
            subject: "Checking in".into(),
            sender_name: "Jane".into(),
            sender_address: "jane@example.com".into(),
            recipients: "sam@example.com".into(),
            received_at: "2026-08-18T12:00:00Z".into(),
            preview: "Hello".into(),
            is_read: false,
            is_starred: false,
            size: 32,
            to: vec!["sam@example.com".into()],
            cc: vec![],
            bcc: vec![],
            reply_to: None,
            thread_parent: None,
            text_body: "Hello".into(),
            html_body: None,
            attachments: vec![],
            raw_message: b"Subject: Checking in\r\n\r\nHello".to_vec(),
            has_attachments: false,
            is_answered: false,
            is_forwarded: false,
            has_calendar: false,
            calendar_json: None,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            importance: String::new(),
            disposition_to: String::new(),
        }
    }

    /// Store a row through the sync envelope path, which applies transfers.
    fn sync_row(db: &Database, mailbox_id: i64, message: &CachedMessage) {
        db.upsert_envelope("account-1", mailbox_id, message)
            .unwrap();
    }

    fn row_id(db: &Database, mailbox_id: i64, uid: u32) -> i64 {
        db.conn()
            .unwrap()
            .query_row(
                "SELECT id FROM messages WHERE mailbox_id=?1 AND uid=?2",
                [mailbox_id, uid as i64],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn snoozed_ids(db: &Database) -> Vec<i64> {
        let mut ids: Vec<i64> = db
            .list_snoozed("account-1", NOW)
            .unwrap()
            .into_iter()
            .map(|entry| entry.message.id)
            .collect();
        ids.sort_unstable();
        ids
    }

    fn transfer_count(db: &Database) -> i64 {
        db.conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pending_snooze_transfers", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn two_snoozes_moved_in_one_batch_both_survive_the_destination_refresh() {
        let (db, account_id) = with_account();
        let inbox = mailbox(&db, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, "Archive", &MailboxRole::Archive);
        db.upsert_envelope(&account_id, inbox, &copy(1, Some("<1@example.com>")))
            .unwrap();
        db.upsert_envelope(&account_id, inbox, &copy(2, Some("<2@example.com>")))
            .unwrap();
        let sources = [row_id(&db, inbox, 1), row_id(&db, inbox, 2)];
        db.snooze_messages(&account_id, &sources, FUTURE).unwrap();

        db.remove_moved_messages(&account_id, &sources, "Archive")
            .unwrap();
        assert_eq!(transfer_count(&db), 2, "both snoozes wait for the copies");
        sync_row(&db, archive, &copy(1, Some("<1@example.com>")));
        sync_row(&db, archive, &copy(2, Some("<2@example.com>")));

        let mut expected = vec![row_id(&db, archive, 1), row_id(&db, archive, 2)];
        expected.sort_unstable();
        assert_eq!(snoozed_ids(&db), expected);
        assert_eq!(transfer_count(&db), 0);
    }

    #[test]
    fn snooze_lands_when_the_destination_row_arrives_on_a_later_sync() {
        let (db, account_id) = with_account();
        let inbox = mailbox(&db, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, "Archive", &MailboxRole::Archive);
        db.upsert_envelope(&account_id, inbox, &copy(1, Some("<1@example.com>")))
            .unwrap();
        let source = row_id(&db, inbox, 1);
        db.snooze_message(&account_id, source, FUTURE).unwrap();
        db.remove_moved_messages(&account_id, &[source], "Archive")
            .unwrap();

        // The destination refresh ran before the server showed the copy.
        db.apply_pending_snooze_transfers(&account_id, archive)
            .unwrap();
        assert!(snoozed_ids(&db).is_empty());
        assert_eq!(
            transfer_count(&db),
            1,
            "the unmatched transfer stays pending"
        );

        sync_row(&db, archive, &copy(7, Some("<1@example.com>")));
        assert_eq!(snoozed_ids(&db), vec![row_id(&db, archive, 7)]);
        assert_eq!(transfer_count(&db), 0);
    }

    #[test]
    fn copy_in_another_folder_with_a_higher_uid_is_never_snoozed() {
        let (db, account_id) = with_account();
        let inbox = mailbox(&db, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, "Archive", &MailboxRole::Archive);
        let work = mailbox(&db, "Work", &MailboxRole::Other);
        db.upsert_envelope(&account_id, inbox, &copy(1, Some("<1@example.com>")))
            .unwrap();
        let source = row_id(&db, inbox, 1);
        db.snooze_message(&account_id, source, FUTURE).unwrap();
        db.remove_moved_messages(&account_id, &[source], "Archive")
            .unwrap();

        // Same Message-ID, unrelated folder, higher UID than the destination copy.
        sync_row(&db, work, &copy(99, Some("<1@example.com>")));
        sync_row(&db, archive, &copy(1, Some("<1@example.com>")));

        assert_eq!(snoozed_ids(&db), vec![row_id(&db, archive, 1)]);
        assert_eq!(
            db.list_messages(work, None, 10).unwrap().items.len(),
            1,
            "the other-folder copy stays visible"
        );
    }

    #[test]
    fn transfer_skips_destination_rows_still_under_a_pending_move() {
        let (db, account_id) = with_account();
        let inbox = mailbox(&db, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, "Archive", &MailboxRole::Archive);
        let work = mailbox(&db, "Work", &MailboxRole::Other);
        db.upsert_envelope(&account_id, inbox, &copy(1, Some("<1@example.com>")))
            .unwrap();
        let source = row_id(&db, inbox, 1);
        db.snooze_message(&account_id, source, FUTURE).unwrap();
        db.remove_moved_messages(&account_id, &[source], "Archive")
            .unwrap();

        // Store the copy without the sync path, so no transfer lands before
        // the row is marked as owned by a pending move.
        db.upsert_message(&account_id, archive, &copy(1, Some("<1@example.com>")))
            .unwrap();
        let archive_copy = row_id(&db, archive, 1);
        db.mark_pending_move(archive_copy, work).unwrap();
        db.apply_pending_snooze_transfers(&account_id, archive)
            .unwrap();
        assert!(snoozed_ids(&db).is_empty(), "a pending move owns that row");
        assert_eq!(transfer_count(&db), 1);
    }

    #[test]
    fn snooze_on_a_message_without_a_message_id_is_dropped_and_the_copy_shows() {
        let (db, account_id) = with_account();
        let inbox = mailbox(&db, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, "Archive", &MailboxRole::Archive);
        db.upsert_envelope(&account_id, inbox, &copy(1, None))
            .unwrap();
        let source = row_id(&db, inbox, 1);
        db.snooze_message(&account_id, source, FUTURE).unwrap();

        // Without a header the snooze cannot be rebound; it is dropped at move time.
        db.remove_moved_messages(&account_id, &[source], "Archive")
            .unwrap();
        assert_eq!(transfer_count(&db), 0);
        sync_row(&db, archive, &copy(1, None));
        assert!(snoozed_ids(&db).is_empty());
        assert_eq!(db.list_messages(archive, None, 10).unwrap().items.len(), 1);
    }

    #[test]
    fn expired_transfer_is_dropped_because_the_message_already_resurfaced() {
        let (db, account_id) = with_account();
        let inbox = mailbox(&db, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, "Archive", &MailboxRole::Archive);
        db.upsert_envelope(&account_id, inbox, &copy(1, Some("<1@example.com>")))
            .unwrap();
        let source = row_id(&db, inbox, 1);
        db.snooze_message(&account_id, source, PAST).unwrap();
        db.remove_moved_messages(&account_id, &[source], "Archive")
            .unwrap();

        sync_row(&db, archive, &copy(1, Some("<1@example.com>")));
        assert!(snoozed_ids(&db).is_empty());
        assert_eq!(transfer_count(&db), 0);
        assert_eq!(db.list_messages(archive, None, 10).unwrap().items.len(), 1);
    }

    #[test]
    fn move_to_an_uncached_folder_removes_the_source_and_drops_the_snooze() {
        let (db, account_id) = with_account();
        let inbox = mailbox(&db, "INBOX", &MailboxRole::Inbox);
        db.upsert_envelope(&account_id, inbox, &copy(1, Some("<1@example.com>")))
            .unwrap();
        let source = row_id(&db, inbox, 1);
        db.snooze_message(&account_id, source, FUTURE).unwrap();

        // The remote move already succeeded; the destination was never cached.
        db.remove_moved_messages(&account_id, &[source], "Archive")
            .unwrap();
        assert!(db.list_messages(inbox, None, 10).unwrap().items.is_empty());
        assert_eq!(transfer_count(&db), 0);
        assert!(snoozed_ids(&db).is_empty());

        // Once the folder syncs, the copy shows without a snooze.
        let archive = mailbox(&db, "Archive", &MailboxRole::Archive);
        sync_row(&db, archive, &copy(1, Some("<1@example.com>")));
        assert!(snoozed_ids(&db).is_empty());
        assert_eq!(db.list_messages(archive, None, 10).unwrap().items.len(), 1);
    }

    #[test]
    fn removing_the_account_removes_its_pending_transfers() {
        let (db, account_id) = with_account();
        let inbox = mailbox(&db, "INBOX", &MailboxRole::Inbox);
        mailbox(&db, "Archive", &MailboxRole::Archive);
        db.upsert_envelope(&account_id, inbox, &copy(1, Some("<1@example.com>")))
            .unwrap();
        let source = row_id(&db, inbox, 1);
        db.snooze_message(&account_id, source, FUTURE).unwrap();
        db.remove_moved_messages(&account_id, &[source], "Archive")
            .unwrap();
        assert_eq!(transfer_count(&db), 1);

        db.remove_account(&account_id).unwrap();
        assert_eq!(transfer_count(&db), 0);
    }
}
