use super::*;

type Migration = fn(&rusqlite::Transaction<'_>) -> Result<(), String>;

const MIGRATIONS: &[(u32, Migration)] = &[
    (1, step_v1),
    (2, step_v2),
    (3, step_v3),
    (4, step_v4),
    (5, step_v5),
    (6, step_v6),
    (7, step_v7),
    (8, step_v8),
    (9, step_v9),
    (10, step_v10),
    (11, step_v11),
    (12, step_v12),
    (13, step_v13),
    (14, step_v14),
    (15, step_v15),
    (16, step_v16),
    (17, step_v17),
    (18, step_v18),
    (19, step_v19),
    (20, step_v20),
    (21, step_v21),
    (22, step_v22),
    (23, step_v23),
    (24, step_v24),
    (25, step_v25),
    (26, step_v26),
    (27, step_v27),
    (28, step_v28),
    (29, step_v29),
    (30, step_v30),
    (31, step_v31),
    (32, step_v32),
    (33, step_v33),
    (34, step_v34),
    (35, step_v35),
    (36, step_v36),
    (37, step_v37),
    (38, step_v38),
    (39, step_v39),
    (40, step_v40),
    (41, step_v41),
];

pub(super) fn migrate_schema(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(db_error)?;
    let version: u32 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(NEWER_DATABASE.into());
    }
    for &(target, migrate) in MIGRATIONS {
        if version < target {
            migrate(&transaction)?;
        }
    }
    // Also initialize this sequence for earlier development snapshots of v22.
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS mailbox_id_sequence (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        last_id INTEGER NOT NULL CHECK(typeof(last_id)='integer' AND last_id>=0));
        INSERT OR IGNORE INTO mailbox_id_sequence(singleton,last_id)
            VALUES(1,(SELECT COALESCE(MAX(id),0) FROM (SELECT id FROM mailboxes UNION ALL SELECT mailbox_id AS id FROM folder_assignments)));").map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

fn step_v1(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    transaction.execute_batch(SCHEMA_V1).map_err(db_error)?;
    ensure_column(
        transaction,
        "mailboxes",
        "backfill_uid",
        "ALTER TABLE mailboxes ADD COLUMN backfill_uid INTEGER",
    )?;
    ensure_column(
        transaction,
        "messages",
        "pending_move_to",
        "ALTER TABLE messages ADD COLUMN pending_move_to INTEGER",
    )?;
    transaction
        .pragma_update(None, "user_version", 1)
        .map_err(db_error)?;
    Ok(())
}

fn step_v2(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    for (table, column, sql) in [
        (
            "mailboxes",
            "server_unread",
            "ALTER TABLE mailboxes ADD COLUMN server_unread INTEGER",
        ),
        (
            "mailboxes",
            "server_total",
            "ALTER TABLE mailboxes ADD COLUMN server_total INTEGER",
        ),
        (
            "mailboxes",
            "counts_updated_at",
            "ALTER TABLE mailboxes ADD COLUMN counts_updated_at TEXT",
        ),
        (
            "drafts",
            "sync_state",
            "ALTER TABLE drafts ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'localPending'",
        ),
        (
            "drafts",
            "sync_detail",
            "ALTER TABLE drafts ADD COLUMN sync_detail TEXT",
        ),
        (
            "drafts",
            "remote_mailbox",
            "ALTER TABLE drafts ADD COLUMN remote_mailbox TEXT",
        ),
        (
            "drafts",
            "remote_uid",
            "ALTER TABLE drafts ADD COLUMN remote_uid INTEGER",
        ),
        (
            "drafts",
            "remote_uid_validity",
            "ALTER TABLE drafts ADD COLUMN remote_uid_validity INTEGER",
        ),
        (
            "drafts",
            "remote_message_id",
            "ALTER TABLE drafts ADD COLUMN remote_message_id TEXT",
        ),
        (
            "drafts",
            "revision",
            "ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "drafts",
            "deleted_at",
            "ALTER TABLE drafts ADD COLUMN deleted_at TEXT",
        ),
        (
            "outbox",
            "message_id",
            "ALTER TABLE outbox ADD COLUMN message_id TEXT",
        ),
        (
            "outbox",
            "mime_bytes",
            "ALTER TABLE outbox ADD COLUMN mime_bytes BLOB",
        ),
        (
            "outbox",
            "attempt_started_at",
            "ALTER TABLE outbox ADD COLUMN attempt_started_at TEXT",
        ),
        (
            "outbox",
            "updated_at",
            "ALTER TABLE outbox ADD COLUMN updated_at TEXT",
        ),
    ] {
        ensure_column(transaction, table, column, sql)?;
    }
    transaction
        .execute(
            "UPDATE outbox SET updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP)",
            [],
        )
        .map_err(db_error)?;
    transaction
        .execute_batch(
            r#"
            CREATE TABLE offline_ops_v2 (
              id INTEGER PRIMARY KEY,
              account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
              kind TEXT NOT NULL,
              payload TEXT NOT NULL,
              dedupe_key TEXT,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(account_id, dedupe_key)
            );
            INSERT INTO offline_ops_v2(id,account_id,kind,payload,created_at)
              SELECT o.id,o.account_id,o.kind,o.payload,o.created_at
              FROM offline_ops o JOIN accounts a ON a.id=o.account_id;
            DROP TABLE offline_ops;
            ALTER TABLE offline_ops_v2 RENAME TO offline_ops;

            CREATE TABLE file_grants_v2 (
              token TEXT PRIMARY KEY,
              account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
              path TEXT NOT NULL,
              size INTEGER NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT OR IGNORE INTO file_grants_v2(token,account_id,path,size,created_at)
              SELECT fg.token,d.account_id,fg.path,0,fg.created_at
              FROM file_grants fg
              JOIN drafts d
              JOIN json_each(
                CASE WHEN json_valid(d.draft_json) THEN d.draft_json ELSE '{"attachments":[]}' END,
                '$.attachments'
              ) attachment
              WHERE json_extract(attachment.value,'$.token')=fg.token;
            INSERT OR IGNORE INTO file_grants_v2(token,account_id,path,size,created_at)
              SELECT fg.token,o.account_id,fg.path,0,fg.created_at
              FROM file_grants fg
              JOIN outbox o
              JOIN json_each(
                CASE WHEN json_valid(o.draft_json) THEN o.draft_json ELSE '{"attachments":[]}' END,
                '$.attachments'
              ) attachment
              WHERE json_extract(attachment.value,'$.token')=fg.token;
            DROP TABLE file_grants;
            ALTER TABLE file_grants_v2 RENAME TO file_grants;
            CREATE TABLE IF NOT EXISTS attachment_refs (
              token TEXT NOT NULL REFERENCES file_grants(token) ON DELETE CASCADE,
              owner_kind TEXT NOT NULL,
              owner_id TEXT NOT NULL,
              PRIMARY KEY(token,owner_kind,owner_id)
            );
            INSERT OR IGNORE INTO attachment_refs(token,owner_kind,owner_id)
              SELECT fg.token,'draft',d.id
              FROM file_grants fg
              JOIN drafts d ON d.account_id=fg.account_id
              JOIN json_each(
                CASE WHEN json_valid(d.draft_json) THEN d.draft_json ELSE '{"attachments":[]}' END,
                '$.attachments'
              ) attachment
              WHERE json_extract(attachment.value,'$.token')=fg.token;
            INSERT OR IGNORE INTO attachment_refs(token,owner_kind,owner_id)
              SELECT fg.token,'outbox',o.id
              FROM file_grants fg
              JOIN outbox o ON o.account_id=fg.account_id
              JOIN json_each(
                CASE WHEN json_valid(o.draft_json) THEN o.draft_json ELSE '{"attachments":[]}' END,
                '$.attachments'
              ) attachment
              WHERE json_extract(attachment.value,'$.token')=fg.token;
            CREATE INDEX IF NOT EXISTS offline_ops_account ON offline_ops(account_id,id);
            CREATE INDEX IF NOT EXISTS drafts_remote ON drafts(account_id,remote_mailbox,remote_uid_validity,remote_uid);
            CREATE INDEX IF NOT EXISTS attachment_refs_owner ON attachment_refs(owner_kind,owner_id);
            "#,
        )
        .map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", 2)
        .map_err(db_error)?;
    Ok(())
}

fn step_v3(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "mailboxes",
        "local_total_delta",
        "ALTER TABLE mailboxes ADD COLUMN local_total_delta INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        transaction,
        "mailboxes",
        "local_unread_delta",
        "ALTER TABLE mailboxes ADD COLUMN local_unread_delta INTEGER NOT NULL DEFAULT 0",
    )?;
    transaction
        .pragma_update(None, "user_version", 3)
        .map_err(db_error)?;
    Ok(())
}

fn step_v4(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "accounts",
        "aliases_json",
        "ALTER TABLE accounts ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        transaction,
        "drafts",
        "sender_email",
        "ALTER TABLE drafts ADD COLUMN sender_email TEXT",
    )?;
    transaction
        .pragma_update(None, "user_version", 4)
        .map_err(db_error)?;
    Ok(())
}

fn step_v5(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "accounts",
        "auth_method",
        "ALTER TABLE accounts ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'",
    )?;
    transaction
        .pragma_update(None, "user_version", 5)
        .map_err(db_error)?;
    Ok(())
}

fn step_v6(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Drop storage that was created but never used: the inline-image blob
    // cache, the untouched protected-messages list, and the draft sender
    // column whose value always came from draft JSON instead.
    transaction
        .execute("DROP TABLE IF EXISTS attachment_blobs", [])
        .map_err(db_error)?;
    transaction
        .execute("DROP TABLE IF EXISTS protected_messages", [])
        .map_err(db_error)?;
    if column_exists(transaction, "drafts", "sender_email")? {
        transaction
            .execute("ALTER TABLE drafts DROP COLUMN sender_email", [])
            .map_err(db_error)?;
    }
    transaction
        .execute(
            "UPDATE offline_ops SET dedupe_key='legacy:' || id WHERE dedupe_key IS NULL",
            [],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "CREATE INDEX IF NOT EXISTS messages_mailbox_date_uid ON messages(mailbox_id,received_at DESC,uid DESC)",
            [],
        )
        .map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", 6)
        .map_err(db_error)?;
    Ok(())
}

fn step_v7(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS recipient_history (
               account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
               address TEXT NOT NULL,
               name TEXT NOT NULL DEFAULT '',
               use_count INTEGER NOT NULL DEFAULT 0,
               last_used TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY(account_id, address)
             );
              CREATE INDEX IF NOT EXISTS recipient_history_lookup ON recipient_history(account_id,address,name);",
        )
        .map_err(db_error)?;
    Ok(())
}

fn step_v8(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    for (table, column, sql) in [
        (
            "messages",
            "thread_parent",
            "ALTER TABLE messages ADD COLUMN thread_parent TEXT",
        ),
        (
            "messages",
            "thread_root",
            "ALTER TABLE messages ADD COLUMN thread_root TEXT",
        ),
    ] {
        ensure_column(transaction, table, column, sql)?;
    }
    transaction
        .execute(
            "CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id,thread_root)",
            [],
        )
        .map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", 8)
        .map_err(db_error)?;
    Ok(())
}

fn step_v9(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "accounts",
        "signature",
        "ALTER TABLE accounts ADD COLUMN signature TEXT NOT NULL DEFAULT ''",
    )?;
    transaction
        .pragma_update(None, "user_version", 9)
        .map_err(db_error)?;
    Ok(())
}

fn step_v10(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "outbox",
        "send_at",
        "ALTER TABLE outbox ADD COLUMN send_at TEXT",
    )?;
    transaction
        .pragma_update(None, "user_version", 10)
        .map_err(db_error)?;
    Ok(())
}

fn step_v11(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS snoozed_messages (
               account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
               message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
               snoozed_until TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY(account_id, message_id)
             );
             CREATE INDEX IF NOT EXISTS snoozed_messages_due ON snoozed_messages(account_id,snoozed_until);",
        )
        .map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", 11)
        .map_err(db_error)?;
    Ok(())
}

fn step_v12(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS filter_rules (
               id TEXT PRIMARY KEY,
               account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
               name TEXT NOT NULL DEFAULT '',
               field TEXT NOT NULL DEFAULT 'from',
               contains TEXT NOT NULL DEFAULT '',
               action TEXT NOT NULL DEFAULT 'mark_read',
               target_mailbox TEXT,
               enabled INTEGER NOT NULL DEFAULT 1,
               position INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE INDEX IF NOT EXISTS filter_rules_account ON filter_rules(account_id,position);",
        )
        .map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", 12)
        .map_err(db_error)?;
    Ok(())
}

fn step_v13(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "mailboxes",
        "role_source",
        "ALTER TABLE mailboxes ADD COLUMN role_source TEXT NOT NULL DEFAULT 'name'",
    )?;
    transaction
        .pragma_update(None, "user_version", 13)
        .map_err(db_error)?;
    Ok(())
}

fn step_v14(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    let duplicate_emails: u32 = transaction
        .query_row(
            "SELECT COUNT(*) FROM (SELECT email FROM accounts GROUP BY email HAVING COUNT(*) > 1)",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    // Older builds could contain duplicate account rows. Preserve both so
    // the user can launch and remove the unwanted one; command-level
    // validation still prevents adding another duplicate.
    if duplicate_emails == 0 {
        transaction
            .execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts(email);",
            )
            .map_err(db_error)?;
    }
    transaction
        .pragma_update(None, "user_version", 14)
        .map_err(db_error)?;
    Ok(())
}

fn step_v15(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // v14 advanced the schema without creating the unique index when
    // duplicate emails existed. Retry transactionally on every open below
    // v15 so the database-level guarantee returns once the duplicates are
    // resolved.
    let duplicate_emails: u32 = transaction
        .query_row(
            "SELECT COUNT(*) FROM (SELECT email FROM accounts GROUP BY email HAVING COUNT(*) > 1)",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if duplicate_emails == 0 {
        ensure_account_email_unique_index(transaction)?;
    }
    transaction
        .pragma_update(None, "user_version", 15)
        .map_err(db_error)?;
    Ok(())
}

fn step_v16(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Re-key message_fts by messages.id. FTS5 has no index on UNINDEXED
    // columns, so every envelope upsert previously scanned the whole FTS
    // table; the rowid is indexed. Repeated opens (including rewound test
    // databases) can revisit this step, so detect the migrated shape.
    let has_message_id: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('message_fts') WHERE name = 'message_id'",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if has_message_id > 0 {
        transaction
            .execute_batch(
                "DROP TRIGGER IF EXISTS messages_after_delete;
                 CREATE VIRTUAL TABLE message_fts_v16 USING fts5(subject, sender, recipients, body, tokenize='unicode61');
                 INSERT INTO message_fts_v16(rowid, subject, sender, recipients, body)
                   SELECT CAST(fts.message_id AS INTEGER), fts.subject, fts.sender, fts.recipients, fts.body
                   FROM message_fts fts
                   JOIN messages m ON m.id = CAST(fts.message_id AS INTEGER);
                 DROP TABLE message_fts;
                 ALTER TABLE message_fts_v16 RENAME TO message_fts;",
            )
            .map_err(db_error)?;
    }
    transaction
        .execute_batch(
            "DROP TRIGGER IF EXISTS messages_after_delete;
             CREATE TRIGGER messages_after_delete AFTER DELETE ON messages
               BEGIN DELETE FROM message_fts WHERE rowid=OLD.id; END;
             CREATE INDEX IF NOT EXISTS messages_account_unread_pending ON messages(account_id,is_read,pending_move_to);",
        )
        .map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", 16)
        .map_err(db_error)?;
    Ok(())
}

fn step_v17(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Cursor pagination compares received_at as text, so fractional-second
    // fallbacks sorted inconsistently with whole-second mail from servers.
    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT id, received_at FROM messages
                 WHERE received_at LIKE '%.%' OR received_at LIKE '%Z'",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows
    };
    for (id, value) in rows {
        let normalized = normalize_received_at(&value);
        if normalized != value {
            transaction
                .execute(
                    "UPDATE messages SET received_at=?2 WHERE id=?1",
                    params![id, normalized],
                )
                .map_err(db_error)?;
        }
    }
    transaction
        .pragma_update(None, "user_version", 17)
        .map_err(db_error)?;
    Ok(())
}

fn step_v18(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    migrate_v18(transaction)?;
    transaction
        .pragma_update(None, "user_version", 18)
        .map_err(db_error)?;
    Ok(())
}

fn step_v19(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    migrate_v19(transaction)?;
    transaction
        .pragma_update(None, "user_version", 19)
        .map_err(db_error)?;
    Ok(())
}

fn step_v20(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    migrate_v20(transaction)?;
    transaction
        .pragma_update(None, "user_version", 20)
        .map_err(db_error)?;
    Ok(())
}

fn step_v21(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "accounts",
        "bridge_certificate",
        "ALTER TABLE accounts ADD COLUMN bridge_certificate TEXT",
    )?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS folder_assignments (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            role TEXT NOT NULL, mailbox_id INTEGER NOT NULL, PRIMARY KEY(account_id,role), UNIQUE(account_id,mailbox_id));").map_err(db_error)?;
    Ok(())
}

fn step_v22(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "mailboxes",
        "server_available",
        "ALTER TABLE mailboxes ADD COLUMN server_available INTEGER NOT NULL DEFAULT 1",
    )?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS message_id_sequence (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        last_id INTEGER NOT NULL CHECK(typeof(last_id)='integer' AND last_id>=0));
        INSERT OR IGNORE INTO message_id_sequence(singleton,last_id)
            VALUES(1,(SELECT COALESCE(MAX(id),0) FROM messages));",
        )
        .map_err(db_error)?;
    Ok(())
}

fn step_v23(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    migrate_v23_mailbox_names(transaction)?;
    transaction
        .pragma_update(None, "user_version", 23)
        .map_err(db_error)?;
    Ok(())
}

fn step_v24(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS muted_ids (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        PRIMARY KEY(account_id, message_id));",
        )
        .map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", 24)
        .map_err(db_error)?;
    Ok(())
}

fn step_v25(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Existing rows stay normal. A later body or envelope write fills this.
    ensure_column(
        transaction,
        "messages",
        "importance",
        "ALTER TABLE messages ADD COLUMN importance TEXT NOT NULL DEFAULT ''",
    )?;
    Ok(())
}

fn step_v26(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Existing mail did not ask for a receipt, and no choice is stored yet.
    ensure_column(
        transaction,
        "messages",
        "disposition_to",
        "ALTER TABLE messages ADD COLUMN disposition_to TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        transaction,
        "messages",
        "receipt_choice",
        "ALTER TABLE messages ADD COLUMN receipt_choice TEXT NOT NULL DEFAULT ''",
    )?;
    Ok(())
}

fn step_v27(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Pins stay on this computer. Existing rows start unpinned.
    ensure_column(
        transaction,
        "messages",
        "pinned",
        "ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

fn step_v28(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS recent_searches (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY(account_id, query));",
        )
        .map_err(db_error)?;
    Ok(())
}

fn step_v29(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Existing accounts keep using From until a Reply-To address is saved.
    ensure_column(
        transaction,
        "accounts",
        "reply_to",
        "ALTER TABLE accounts ADD COLUMN reply_to TEXT NOT NULL DEFAULT ''",
    )?;
    Ok(())
}

fn step_v30(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Bcc is absent on most received mail. Sent copies often still have it.
    ensure_column(
        transaction,
        "messages",
        "bcc_json",
        "ALTER TABLE messages ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]'",
    )?;
    Ok(())
}

fn step_v31(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "outbox",
        "archive_message_id",
        "ALTER TABLE outbox ADD COLUMN archive_message_id INTEGER",
    )?;
    ensure_column(
        transaction,
        "outbox",
        "archive_source_mailbox_id",
        "ALTER TABLE outbox ADD COLUMN archive_source_mailbox_id INTEGER",
    )?;
    Ok(())
}

fn step_v32(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "mailboxes",
        "counts_generation",
        "ALTER TABLE mailboxes ADD COLUMN counts_generation INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        transaction,
        "messages",
        "pending_source_generation",
        "ALTER TABLE messages ADD COLUMN pending_source_generation INTEGER",
    )?;
    ensure_column(
        transaction,
        "messages",
        "pending_destination_generation",
        "ALTER TABLE messages ADD COLUMN pending_destination_generation INTEGER",
    )?;
    Ok(())
}

fn step_v33(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Set while a body is parsed; a crash leaves it set so the message is
    // never parsed automatically again.
    ensure_column(
        transaction,
        "messages",
        "parse_pending",
        "ALTER TABLE messages ADD COLUMN parse_pending INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        transaction,
        "outbox",
        "retry_attempts",
        "ALTER TABLE outbox ADD COLUMN retry_attempts INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        transaction,
        "outbox",
        "retry_after",
        "ALTER TABLE outbox ADD COLUMN retry_after TEXT",
    )?;
    // Pinned rows sort first; this index keeps paging off a temp B-tree.
    transaction
        .execute(
            "CREATE INDEX IF NOT EXISTS messages_mailbox_pinned_date_uid ON messages(mailbox_id,pinned DESC,received_at DESC,uid DESC)",
            [],
        )
        .map_err(db_error)?;
    Ok(())
}

fn step_v34(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Set by a sync pass that failed after caching mail; the next
    // successful pass files everything newer than it.
    ensure_column(
        transaction,
        "accounts",
        "rules_pending_from",
        "ALTER TABLE accounts ADD COLUMN rules_pending_from INTEGER",
    )?;
    ensure_column(
        transaction,
        "messages",
        "to_me",
        "ALTER TABLE messages ADD COLUMN to_me INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        transaction,
        "messages",
        "attachment_count",
        "ALTER TABLE messages ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0",
    )?;
    refresh_list_columns(transaction, "1=1", [])?;
    Ok(())
}

fn step_v35(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "outbox",
        "reason_code",
        "ALTER TABLE outbox ADD COLUMN reason_code TEXT",
    )?;
    for &reason in crate::outbox_reason::OutboxReason::ALL {
        transaction.execute(
            "UPDATE outbox SET reason_code=?1, detail=NULL WHERE reason_code IS NULL AND detail=?2",
            params![reason.code(), reason.message()],
        ).map_err(db_error)?;
    }
    Ok(())
}

fn step_v36(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Lets prefetch candidates read in order without a temp B-tree. The
    // expression and WHERE must match PREFETCH_CANDIDATES_SQL.
    transaction
        .execute(
            "CREATE INDEX IF NOT EXISTS messages_prefetch_order ON messages(mailbox_id, COALESCE(internal_at,received_at) DESC, uid DESC) WHERE body_bytes=0",
            [],
        )
        .map_err(db_error)?;
    Ok(())
}

fn step_v37(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Undo-window moves wait in the queue until `not_before` passes or the
    // frontend commits them. `attempts` counts transient replay failures.
    ensure_column(
        transaction,
        "offline_ops",
        "not_before",
        "ALTER TABLE offline_ops ADD COLUMN not_before TEXT",
    )?;
    ensure_column(
        transaction,
        "offline_ops",
        "undo_token",
        "ALTER TABLE offline_ops ADD COLUMN undo_token TEXT",
    )?;
    ensure_column(
        transaction,
        "offline_ops",
        "attempts",
        "ALTER TABLE offline_ops ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
    )?;
    transaction
        .execute(
            "CREATE INDEX IF NOT EXISTS offline_ops_not_before ON offline_ops(account_id, not_before)",
            [],
        )
        .map_err(db_error)?;
    Ok(())
}

fn step_v38(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Set when only the first part of a large message is stored. The full body
    // downloads on demand and the flag clears when it is stored.
    ensure_column(
        transaction,
        "messages",
        "body_partial",
        "ALTER TABLE messages ADD COLUMN body_partial INTEGER NOT NULL DEFAULT 0",
    )
}

fn step_v39(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    ensure_column(
        transaction,
        "accounts",
        "signature_html",
        "ALTER TABLE accounts ADD COLUMN signature_html TEXT NOT NULL DEFAULT ''",
    )?;
    transaction
        .execute(
            "CREATE INDEX IF NOT EXISTS messages_account_sender_address
             ON messages(account_id, sender_address COLLATE NOCASE)",
            [],
        )
        .map_err(db_error)?;
    Ok(())
}

fn step_v40(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // attempt_started_at was written at send claim but never read: the
    // uncertain-send retention instead comes from state/reason handling, so
    // the column goes. Keep the historical ensure_column add in step_v2; older
    // databases pass through it on the way here.
    if column_exists(transaction, "outbox", "attempt_started_at")? {
        transaction
            .execute("ALTER TABLE outbox DROP COLUMN attempt_started_at", [])
            .map_err(db_error)?;
    }
    transaction
        .pragma_update(None, "user_version", 40)
        .map_err(db_error)?;
    Ok(())
}

fn step_v41(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Snoozes that follow a server move wait here until the destination
    // folder caches the copy. Rows go with the account or the folder.
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS pending_snooze_transfers (
               account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
               mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
               message_id_header TEXT NOT NULL,
               snoozed_until TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY(account_id, mailbox_id, message_id_header)
             );",
        )
        .map_err(db_error)?;
    transaction
        .pragma_update(None, "user_version", 41)
        .map_err(db_error)?;
    Ok(())
}

/// Schema v23: convert cached IMAP4rev1 mailbox names from modified UTF-7.
fn migrate_v23_mailbox_names(transaction: &rusqlite::Transaction) -> Result<(), String> {
    let rows = {
        let mut statement = transaction
            .prepare("SELECT id,account_id,name,display_name FROM mailboxes ORDER BY account_id,id")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows
    };

    let mut normalized = Vec::with_capacity(rows.len());
    let mut final_names = std::collections::HashSet::with_capacity(rows.len());
    for (id, account_id, name, display_name) in rows {
        let decoded_name = crate::mail::utf7::decode(&name);
        let decoded_display_name = crate::mail::utf7::decode(&display_name);
        if !final_names.insert((account_id.clone(), decoded_name.clone())) {
            return Err(
                "Saved folder names conflict. Cached mail and queued changes were preserved."
                    .into(),
            );
        }
        normalized.push((
            id,
            account_id,
            name,
            display_name,
            decoded_name,
            decoded_display_name,
        ));
    }

    // Move changed names aside first so swaps and nested names remain unique.
    let mut reserved_names = final_names;
    for (_, account_id, name, _, decoded_name, _) in &normalized {
        reserved_names.insert((account_id.clone(), name.clone()));
        reserved_names.insert((account_id.clone(), decoded_name.clone()));
    }
    for (id, account_id, name, _, decoded_name, _) in &normalized {
        if name == decoded_name {
            continue;
        }
        let mut temporary = format!("__postal_snap_v23_mailbox_{id}__");
        let mut suffix = 0_u32;
        while reserved_names.contains(&(account_id.clone(), temporary.clone())) {
            suffix = suffix.saturating_add(1);
            temporary = format!("__postal_snap_v23_mailbox_{id}_{suffix}__");
        }
        reserved_names.insert((account_id.clone(), temporary.clone()));
        transaction
            .execute(
                "UPDATE mailboxes SET name=?2 WHERE id=?1 AND account_id=?3",
                params![id, temporary, account_id],
            )
            .map_err(db_error)?;
    }
    for (id, account_id, name, display_name, decoded_name, decoded_display_name) in &normalized {
        if name != decoded_name || display_name != decoded_display_name {
            transaction
                .execute(
                    "UPDATE mailboxes SET name=?2,display_name=?3 WHERE id=?1 AND account_id=?4",
                    params![id, decoded_name, decoded_display_name, account_id],
                )
                .map_err(db_error)?;
        }
    }

    let drafts = {
        let mut statement = transaction
            .prepare("SELECT id,remote_mailbox FROM drafts WHERE remote_mailbox IS NOT NULL")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows
    };
    for (id, name) in drafts {
        let decoded = crate::mail::utf7::decode(&name);
        if name != decoded {
            transaction
                .execute(
                    "UPDATE drafts SET remote_mailbox=?2 WHERE id=?1",
                    params![id, decoded],
                )
                .map_err(db_error)?;
        }
    }

    let filter_targets = {
        let mut statement = transaction
            .prepare("SELECT id,target_mailbox FROM filter_rules WHERE target_mailbox IS NOT NULL")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows
    };
    for (id, name) in filter_targets {
        let decoded = crate::mail::utf7::decode(&name);
        if name != decoded {
            transaction
                .execute(
                    "UPDATE filter_rules SET target_mailbox=?2 WHERE id=?1",
                    params![id, decoded],
                )
                .map_err(db_error)?;
        }
    }

    let operations = {
        let mut statement = transaction
            .prepare(
                "SELECT id,kind,payload FROM offline_ops WHERE kind IN ('flags','keyword','move','copy')",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows
    };
    for (id, kind, payload) in operations {
        let mut value: serde_json::Value = serde_json::from_str(&payload).map_err(|_| {
            "Saved queued changes could not be migrated. Cached mail and queued changes were preserved."
                .to_string()
        })?;
        let keys: &[&str] = match kind.as_str() {
            "flags" | "keyword" => &["mailbox"],
            "move" | "copy" => &["source", "destination"],
            _ => &[],
        };
        let mut changed = false;
        for key in keys {
            let Some(name) = value.get(*key).and_then(serde_json::Value::as_str) else {
                continue;
            };
            let decoded = crate::mail::utf7::decode(name);
            if name != decoded {
                value[*key] = serde_json::Value::String(decoded);
                changed = true;
            }
        }
        if changed {
            let rewritten = serde_json::to_string(&value).map_err(|_| {
                "Saved queued changes could not be migrated. Cached mail and queued changes were preserved."
                    .to_string()
            })?;
            transaction
                .execute(
                    "UPDATE offline_ops SET payload=?2 WHERE id=?1",
                    params![id, rewritten],
                )
                .map_err(db_error)?;
        }
    }

    Ok(())
}

/// Schema v18: per-account download policy, account presentation, resumable
/// backfill state, CONDSTORE bookkeeping, INTERNALDATE, body accounting and
/// prefetch backoff. Nullable policy columns mean "inherit the app default"
/// until startup seeds them once.
fn migrate_v18(transaction: &rusqlite::Transaction) -> Result<(), String> {
    for (table, column, sql) in [
        (
            "accounts",
            "cache_mode",
            "ALTER TABLE accounts ADD COLUMN cache_mode TEXT",
        ),
        (
            "accounts",
            "cache_days",
            "ALTER TABLE accounts ADD COLUMN cache_days INTEGER",
        ),
        (
            "accounts",
            "cache_max_bytes",
            "ALTER TABLE accounts ADD COLUMN cache_max_bytes INTEGER",
        ),
        (
            "accounts",
            "color",
            "ALTER TABLE accounts ADD COLUMN color TEXT",
        ),
        (
            "accounts",
            "sort_order",
            "ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "mailboxes",
            "highest_modseq",
            "ALTER TABLE mailboxes ADD COLUMN highest_modseq INTEGER",
        ),
        (
            "mailboxes",
            "backfill_state",
            "ALTER TABLE mailboxes ADD COLUMN backfill_state TEXT NOT NULL DEFAULT 'active'",
        ),
        (
            "mailboxes",
            "last_flag_scan_at",
            "ALTER TABLE mailboxes ADD COLUMN last_flag_scan_at TEXT",
        ),
        (
            "mailboxes",
            "sync_error",
            "ALTER TABLE mailboxes ADD COLUMN sync_error TEXT",
        ),
        (
            "mailboxes",
            "delimiter",
            "ALTER TABLE mailboxes ADD COLUMN delimiter TEXT",
        ),
        (
            "messages",
            "internal_at",
            "ALTER TABLE messages ADD COLUMN internal_at TEXT",
        ),
        (
            "messages",
            "body_bytes",
            "ALTER TABLE messages ADD COLUMN body_bytes INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "messages",
            "prefetch_failures",
            "ALTER TABLE messages ADD COLUMN prefetch_failures INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "messages",
            "prefetch_retry_at",
            "ALTER TABLE messages ADD COLUMN prefetch_retry_at TEXT",
        ),
    ] {
        ensure_column(transaction, table, column, sql)?;
    }
    transaction
        .execute_batch(
            "UPDATE mailboxes SET backfill_state='cutoff' WHERE backfill_uid=0;
             UPDATE mailboxes SET backfill_uid=NULL WHERE backfill_uid=0;
             UPDATE messages SET internal_at=received_at WHERE internal_at IS NULL;
             UPDATE messages SET body_bytes=LENGTH(raw_message)+LENGTH(text_body)+LENGTH(COALESCE(html_body,''))
               WHERE LENGTH(raw_message)>0 AND body_bytes=0;
             UPDATE accounts SET sort_order=(SELECT COUNT(*) FROM accounts older WHERE older.created_at<accounts.created_at OR (older.created_at=accounts.created_at AND older.id<accounts.id))
               WHERE sort_order=0;
             CREATE INDEX IF NOT EXISTS messages_account_message_id ON messages(account_id,message_id);
             CREATE INDEX IF NOT EXISTS messages_account_thread_parent ON messages(account_id,thread_parent);
             CREATE INDEX IF NOT EXISTS messages_mailbox_internal ON messages(mailbox_id,internal_at DESC);
             CREATE INDEX IF NOT EXISTS messages_account_bodies ON messages(account_id,body_bytes) WHERE body_bytes>0;",
        )
        .map_err(db_error)
}

/// Schema v19: draft reply/forward source and body format, per-account
/// default body format, and List-Unsubscribe / calendar message metadata.
/// Draft source ids are plain integers (no FK) so evicting the source message
/// never touches the draft. Outbox rows carry these fields in `draft_json`.
pub(super) fn migrate_v19(transaction: &rusqlite::Transaction) -> Result<(), String> {
    for (table, column, sql) in [
        (
            "drafts",
            "source_message_id",
            "ALTER TABLE drafts ADD COLUMN source_message_id INTEGER",
        ),
        (
            "drafts",
            "source_kind",
            "ALTER TABLE drafts ADD COLUMN source_kind TEXT",
        ),
        (
            "drafts",
            "body_format",
            "ALTER TABLE drafts ADD COLUMN body_format TEXT NOT NULL DEFAULT 'html'",
        ),
        (
            "accounts",
            "default_body_format",
            "ALTER TABLE accounts ADD COLUMN default_body_format TEXT NOT NULL DEFAULT 'html'",
        ),
        (
            "messages",
            "list_unsubscribe",
            "ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT",
        ),
        (
            "messages",
            "list_unsubscribe_post",
            "ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT",
        ),
        (
            "messages",
            "has_calendar",
            "ALTER TABLE messages ADD COLUMN has_calendar INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        ensure_column(transaction, table, column, sql)?;
    }
    Ok(())
}

/// Schema v20: replied/forwarded flags and the parsed calendar invite.
fn migrate_v20(transaction: &rusqlite::Transaction) -> Result<(), String> {
    for (column, sql) in [
        (
            "is_answered",
            "ALTER TABLE messages ADD COLUMN is_answered INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "is_forwarded",
            "ALTER TABLE messages ADD COLUMN is_forwarded INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "calendar_json",
            "ALTER TABLE messages ADD COLUMN calendar_json TEXT",
        ),
    ] {
        ensure_column(transaction, "messages", column, sql)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v41_adds_pending_snooze_transfers_to_a_v40_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let _database = Database::open(&path).unwrap();
        }
        {
            // Rebuild the v40 shape: no transfer table yet.
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "DROP TABLE pending_snooze_transfers;
                     PRAGMA user_version=40;",
                )
                .unwrap();
        }

        let reopened = Database::open(&path).unwrap();
        let conn = reopened.conn().unwrap();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 41);
        assert!(conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pending_snooze_transfers'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count == 1)
            .unwrap());
    }

    #[test]
    fn v40_drops_attempt_started_at_keeping_outbox_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let _database = Database::open(&path).unwrap();
        }
        {
            // Rebuild the v39 shape: the column still existed and one queued
            // row carried no value for it.
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "PRAGMA foreign_keys=OFF;
                     ALTER TABLE outbox ADD COLUMN attempt_started_at TEXT;
                     INSERT INTO outbox(id,account_id,draft_json,state,created_at)
                       VALUES('o1','a1','{}','queued',CURRENT_TIMESTAMP);
                     PRAGMA user_version=39;",
                )
                .unwrap();
        }

        let reopened = Database::open(&path).unwrap();
        let conn = reopened.conn().unwrap();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert!(!column_exists(&conn, "outbox", "attempt_started_at").unwrap());
        let (count, state): (i64, String) = conn
            .query_row(
                "SELECT COUNT(*), state FROM outbox WHERE id='o1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((count, state.as_str()), (1, "queued"));
    }
}
