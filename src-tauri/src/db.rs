use std::{path::Path, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::{
    AccountInboxCount, AccountRecord, AccountSummary, AppSettings, Attachment, CachePolicy,
    CacheUsage, ComposeDraft, DraftSummary, FilterRule, MailboxRole, MailboxSummary, MessageCursor,
    MessageDetail, MessagePage, MessageSummary, OutboxSummary, ProviderKind, RecipientSuggestion,
    SearchQuery, ServerConfig, SnoozedSummary, TlsMode,
};

const CURRENT_SCHEMA_VERSION: u32 = 12;

pub type MailboxSyncState = (Option<u32>, Option<u32>, u32, Option<u32>);

pub struct Database {
    connection: Mutex<Connection>,
}

#[derive(Debug)]
pub struct CachedMessage {
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
    pub size: u64,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub reply_to: Option<String>,
    pub thread_parent: Option<String>,
    pub text_body: String,
    pub html_body: Option<String>,
    pub attachments: Vec<Attachment>,
    pub raw_message: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct DraftSyncRecord {
    pub id: String,
    pub draft: ComposeDraft,
    pub remote_mailbox: Option<String>,
    pub remote_uid: Option<u32>,
    pub remote_uid_validity: Option<u32>,
    pub remote_message_id: String,
    pub revision: u32,
    pub deleted: bool,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut connection = Connection::open(path).map_err(db_error)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(db_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(db_error)?;
        migrate_schema(&mut connection)?;
        connection
            .execute(
                "UPDATE outbox SET state='needs_attention', detail='Postal Snap closed before delivery could be confirmed. It will not resend automatically.' WHERE state='sending'",
                [],
            )
            .map_err(db_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        migrate_schema(&mut connection).unwrap();
        Self {
            connection: Mutex::new(connection),
        }
    }

    fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "Local mail database is unavailable.".into())
    }

    pub fn list_accounts(&self) -> Result<Vec<AccountSummary>, String> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT id, provider, email, display_name, sync_state, error, aliases_json, auth_method, signature FROM accounts ORDER BY created_at",
        ).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                let aliases_json: String = row.get(6).unwrap_or_else(|_| "[]".into());
                let aliases: Vec<String> = serde_json::from_str(&aliases_json).unwrap_or_default();
                Ok(AccountSummary {
                    id: row.get(0)?,
                    provider: parse_provider(&row.get::<_, String>(1)?),
                    email: row.get(2)?,
                    display_name: row.get(3)?,
                    sync_state: row.get(4)?,
                    error: row.get(5)?,
                    aliases,
                    auth_method: row
                        .get::<_, Option<String>>(7)?
                        .unwrap_or_else(|| "password".into()),
                    signature: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn account(&self, id: &str) -> Result<AccountRecord, String> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT id, provider, email, display_name, sync_state, error,
                    imap_host, imap_port, imap_tls, imap_username,
                    smtp_host, smtp_port, smtp_tls, smtp_username,
                    aliases_json, auth_method, signature
             FROM accounts WHERE id = ?1",
            [id],
            |row| {
                let aliases_json: String = row.get(14).unwrap_or_else(|_| "[]".into());
                let aliases: Vec<String> = serde_json::from_str(&aliases_json).unwrap_or_default();
                Ok(AccountRecord {
                    summary: AccountSummary {
                        id: row.get(0)?,
                        provider: parse_provider(&row.get::<_, String>(1)?),
                        email: row.get(2)?,
                        display_name: row.get(3)?,
                        sync_state: row.get(4)?,
                        error: row.get(5)?,
                        aliases,
                        auth_method: row
                            .get::<_, Option<String>>(15)?
                            .unwrap_or_else(|| "password".into()),
                        signature: row.get::<_, Option<String>>(16)?.unwrap_or_default(),
                    },
                    imap: ServerConfig {
                        host: row.get(6)?,
                        port: row.get::<_, u16>(7)?,
                        tls_mode: parse_tls(&row.get::<_, String>(8)?),
                        username: row.get(9)?,
                    },
                    smtp: ServerConfig {
                        host: row.get(10)?,
                        port: row.get::<_, u16>(11)?,
                        tls_mode: parse_tls(&row.get::<_, String>(12)?),
                        username: row.get(13)?,
                    },
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Account not found.".into())
    }

    pub fn insert_account(&self, account: &AccountRecord) -> Result<(), String> {
        let conn = self.conn()?;
        let aliases_json =
            serde_json::to_string(&account.summary.aliases).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "INSERT INTO accounts (
                id, provider, email, display_name, sync_state,
                imap_host, imap_port, imap_tls, imap_username,
                smtp_host, smtp_port, smtp_tls, smtp_username,
                aliases_json, auth_method
             ) VALUES (?1, ?2, ?3, ?4, 'idle', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                account.summary.id,
                account.summary.provider.as_str(),
                account.summary.email,
                account.summary.display_name,
                account.imap.host,
                account.imap.port,
                account.imap.tls_mode.as_str(),
                account.imap.username,
                account.smtp.host,
                account.smtp.port,
                account.smtp.tls_mode.as_str(),
                account.smtp.username,
                aliases_json,
                account.summary.auth_method,
            ],
        )
        .map_err(db_error)?;
        Ok(())
    }

    pub fn update_account_aliases(
        &self,
        id: &str,
        aliases: &[String],
    ) -> Result<AccountSummary, String> {
        let aliases_json = serde_json::to_string(aliases)
            .map_err(|_| "Failed to serialize aliases.".to_string())?;
        {
            let conn = self.conn()?;
            conn.execute(
                "UPDATE accounts SET aliases_json = ?2 WHERE id = ?1",
                params![id, aliases_json],
            )
            .map_err(db_error)?;
        }
        let record = self.account(id)?;
        Ok(record.summary)
    }

    pub fn update_account_display_name(&self, id: &str, display_name: &str) -> Result<(), String> {
        let conn = self.conn()?;
        let updated = conn
            .execute(
                "UPDATE accounts SET display_name = ?1 WHERE id = ?2",
                params![display_name.trim(), id],
            )
            .map_err(db_error)?;
        if updated != 1 {
            return Err("Account not found.".into());
        }
        Ok(())
    }

    pub fn update_account_signature(
        &self,
        id: &str,
        signature: &str,
    ) -> Result<AccountSummary, String> {
        let trimmed = signature.trim();
        if trimmed.len() > 2000
            || trimmed
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("Keep the signature under 2000 characters of plain text.".into());
        }
        {
            let conn = self.conn()?;
            let updated = conn
                .execute(
                    "UPDATE accounts SET signature = ?1 WHERE id = ?2",
                    params![trimmed, id],
                )
                .map_err(db_error)?;
            if updated != 1 {
                return Err("Account not found.".into());
            }
        }
        let record = self.account(id)?;
        Ok(record.summary)
    }

    pub fn remove_account(&self, id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(db_error)?;
        tx.execute(
            "DELETE FROM message_fts WHERE message_id IN (SELECT id FROM messages WHERE account_id=?1)",
            [id],
        )
        .map_err(db_error)?;
        let removed = tx
            .execute("DELETE FROM accounts WHERE id = ?1", [id])
            .map_err(db_error)?;
        if removed != 1 {
            return Err("Account not found.".into());
        }
        tx.commit().map_err(db_error)
    }

    pub fn account_count(&self) -> Result<usize, String> {
        self.conn()?
            .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))
            .map_err(db_error)
    }

    pub fn set_account_state(
        &self,
        id: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE accounts SET sync_state = ?2, error = ?3 WHERE id = ?1",
                params![id, state, error],
            )
            .map_err(db_error)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_mailbox(
        &self,
        account_id: &str,
        name: &str,
        role: &MailboxRole,
        uid_validity: Option<u32>,
        uid_next: Option<u32>,
        server_unread: Option<u32>,
        server_total: u32,
    ) -> Result<i64, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let previous_validity: Option<u32> = transaction
            .query_row(
                "SELECT uid_validity FROM mailboxes WHERE account_id = ?1 AND name = ?2",
                params![account_id, name],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .flatten();
        transaction.execute(
            "INSERT INTO mailboxes (account_id, name, display_name, role, uid_validity, uid_next, server_unread, server_total, counts_updated_at)
             VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
             ON CONFLICT(account_id, name) DO UPDATE SET role=excluded.role, uid_validity=excluded.uid_validity,
             uid_next=excluded.uid_next, server_unread=excluded.server_unread, server_total=excluded.server_total,
             counts_updated_at=CURRENT_TIMESTAMP, local_total_delta=0, local_unread_delta=0",
            params![account_id, name, role.as_str(), uid_validity, uid_next, server_unread, server_total],
        ).map_err(db_error)?;
        let id: i64 = transaction
            .query_row(
                "SELECT id FROM mailboxes WHERE account_id = ?1 AND name = ?2",
                params![account_id, name],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if previous_validity.is_some()
            && uid_validity.is_some()
            && previous_validity != uid_validity
        {
            transaction
                .execute("DELETE FROM messages WHERE mailbox_id = ?1", [id])
                .map_err(db_error)?;
            transaction
                .execute("UPDATE mailboxes SET backfill_uid=NULL WHERE id=?1", [id])
                .map_err(db_error)?;
            // UIDs from the old generation are meaningless: queued flag and
            // move operations that name this mailbox can never apply. Drop
            // them here instead of letting replay act on recycled UIDs.
            transaction
                .execute(
                    "DELETE FROM offline_ops WHERE account_id=?1 AND ((kind='flags' AND json_extract(payload,'$.mailbox')=?2) OR (kind='move' AND json_extract(payload,'$.source')=?2))",
                    params![account_id, name],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(id)
    }

    pub fn list_mailboxes(&self, account_id: &str) -> Result<Vec<MailboxSummary>, String> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT f.id, f.account_id, f.name, f.display_name, f.role,
                    MAX(0, COALESCE(f.server_unread, SUM(CASE WHEN m.is_read = 0 AND m.pending_move_to IS NULL THEN 1 ELSE 0 END)) + f.local_unread_delta),
                    MAX(0, COALESCE(f.server_total, SUM(CASE WHEN m.pending_move_to IS NULL AND m.id IS NOT NULL THEN 1 ELSE 0 END)) + f.local_total_delta)
             FROM mailboxes f LEFT JOIN messages m ON m.mailbox_id = f.id
             WHERE f.account_id = ?1 GROUP BY f.id
             ORDER BY CASE f.role WHEN 'inbox' THEN 0 WHEN 'starred' THEN 1 WHEN 'drafts' THEN 2 WHEN 'sent' THEN 3 WHEN 'archive' THEN 4 WHEN 'junk' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END, f.display_name COLLATE NOCASE",
        ).map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok(MailboxSummary {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    name: row.get(2)?,
                    display_name: row.get(3)?,
                    role: parse_role(&row.get::<_, String>(4)?),
                    unread_count: row.get::<_, u32>(5)?,
                    total_count: row.get::<_, u32>(6)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn list_all_mailboxes(&self) -> Result<Vec<MailboxSummary>, String> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT f.id, f.account_id, f.name, f.display_name, f.role,
                    MAX(0, COALESCE(f.server_unread, SUM(CASE WHEN m.is_read = 0 AND m.pending_move_to IS NULL THEN 1 ELSE 0 END)) + f.local_unread_delta),
                    MAX(0, COALESCE(f.server_total, SUM(CASE WHEN m.pending_move_to IS NULL AND m.id IS NOT NULL THEN 1 ELSE 0 END)) + f.local_total_delta)
             FROM mailboxes f LEFT JOIN messages m ON m.mailbox_id = f.id
             GROUP BY f.id
             ORDER BY f.account_id, CASE f.role WHEN 'inbox' THEN 0 WHEN 'starred' THEN 1 WHEN 'drafts' THEN 2 WHEN 'sent' THEN 3 WHEN 'archive' THEN 4 WHEN 'junk' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END, f.display_name COLLATE NOCASE",
        ).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(MailboxSummary {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    name: row.get(2)?,
                    display_name: row.get(3)?,
                    role: parse_role(&row.get::<_, String>(4)?),
                    unread_count: row.get::<_, u32>(5)?,
                    total_count: row.get::<_, u32>(6)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn list_account_inbox_counts(&self) -> Result<Vec<AccountInboxCount>, String> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT f.account_id,
                    MAX(0, COALESCE(f.server_unread, SUM(CASE WHEN m.is_read = 0 AND m.pending_move_to IS NULL THEN 1 ELSE 0 END)) + f.local_unread_delta),
                    MAX(0, COALESCE(f.server_total, SUM(CASE WHEN m.pending_move_to IS NULL AND m.id IS NOT NULL THEN 1 ELSE 0 END)) + f.local_total_delta)
             FROM mailboxes f LEFT JOIN messages m ON m.mailbox_id = f.id
             WHERE f.role = 'inbox'
             GROUP BY f.id, f.account_id
             ORDER BY f.account_id",
        ).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(AccountInboxCount {
                    account_id: row.get(0)?,
                    unread_count: row.get::<_, u32>(1)?,
                    total_count: row.get::<_, u32>(2)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn mailbox_for_role(
        &self,
        account_id: &str,
        role: &str,
    ) -> Result<Option<(i64, String)>, String> {
        self.conn()?
            .query_row(
                "SELECT id, name FROM mailboxes WHERE account_id = ?1 AND role = ?2 LIMIT 1",
                params![account_id, role],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)
    }

    pub fn reconcile_mailboxes(
        &self,
        account_id: &str,
        server_names: &std::collections::HashSet<String>,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let stale_ids = {
            let mut statement = conn
                .prepare("SELECT id,name FROM mailboxes WHERE account_id=?1")
                .map_err(db_error)?;
            let rows = statement
                .query_map([account_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            // Never drop a folder that still hides pending moves or backs
            // queued offline operations; the next successful replay retires
            // them, and a later sync reconciles the folder away.
            let mut guarded: std::collections::HashSet<i64> = conn
                .prepare(
                    "SELECT DISTINCT mailbox_id FROM messages WHERE pending_move_to IS NOT NULL",
                )
                .map_err(db_error)?
                .query_map([], |row| row.get(0))
                .map_err(db_error)?
                .collect::<Result<Vec<i64>, _>>()
                .map_err(db_error)?
                .into_iter()
                .collect();
            let mut op_statement = conn
                .prepare("SELECT payload FROM offline_ops WHERE account_id=?1")
                .map_err(db_error)?;
            let payloads = op_statement
                .query_map([account_id], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            drop(op_statement);
            let mut name_to_id: std::collections::HashMap<String, i64> =
                std::collections::HashMap::new();
            for (id, name) in &rows {
                name_to_id.insert(name.clone(), *id);
            }
            for payload in &payloads {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                    for key in ["mailbox", "source", "destination"] {
                        if let Some(name) = value.get(key).and_then(|name| name.as_str()) {
                            if let Some(id) = name_to_id.get(name) {
                                guarded.insert(*id);
                            }
                        }
                    }
                }
            }
            rows.into_iter()
                .filter_map(|(id, name)| {
                    (!server_names.contains(&name) && !guarded.contains(&id)).then_some(id)
                })
                .collect::<Vec<_>>()
        };
        let transaction = conn.transaction().map_err(db_error)?;
        for id in stale_ids {
            transaction
                .execute(
                    "DELETE FROM message_fts WHERE message_id IN (SELECT id FROM messages WHERE mailbox_id=?1)",
                    [id],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "DELETE FROM mailboxes WHERE id=?1 AND account_id=?2",
                    params![id, account_id],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    pub fn rename_mailbox_local(
        &self,
        account_id: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let collision: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mailboxes WHERE account_id=?1 AND name=?2 AND name<>?3)",
                params![account_id, new_name, old_name],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if collision {
            return Err("A folder with that name already exists.".into());
        }
        let changed = transaction
            .execute(
                "UPDATE mailboxes SET name=?3, display_name=?3 WHERE account_id=?1 AND name=?2",
                params![account_id, old_name, new_name],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("That folder is no longer available.".into());
        }
        transaction
            .execute(
                "UPDATE drafts SET remote_mailbox=?3 WHERE account_id=?1 AND remote_mailbox=?2",
                params![account_id, old_name, new_name],
            )
            .map_err(db_error)?;
        Self::rewrite_queued_mailbox_names(&transaction, account_id, old_name, new_name)?;
        transaction.commit().map_err(db_error)
    }

    fn rewrite_queued_mailbox_names(
        transaction: &rusqlite::Transaction,
        account_id: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), String> {
        let mut statement = transaction
            .prepare("SELECT id,kind,payload FROM offline_ops WHERE account_id=?1")
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        drop(statement);
        for (id, kind, payload) in rows {
            let mut value: serde_json::Value = serde_json::from_str(&payload)
                .map_err(|_| "Queued changes are damaged.".to_string())?;
            let mut dirty = false;
            if kind == "flags" {
                if value.get("mailbox").and_then(|name| name.as_str()) == Some(old_name) {
                    value["mailbox"] = serde_json::Value::String(new_name.to_string());
                    dirty = true;
                }
            } else if kind == "move" {
                if value.get("source").and_then(|name| name.as_str()) == Some(old_name) {
                    value["source"] = serde_json::Value::String(new_name.to_string());
                    dirty = true;
                }
                if value.get("destination").and_then(|name| name.as_str()) == Some(old_name) {
                    value["destination"] = serde_json::Value::String(new_name.to_string());
                    dirty = true;
                }
            }
            if dirty {
                let rewritten = serde_json::to_string(&value)
                    .map_err(|_| "Queued changes are damaged.".to_string())?;
                transaction
                    .execute(
                        "UPDATE offline_ops SET payload=?2 WHERE id=?1 AND account_id=?3",
                        params![id, rewritten, account_id],
                    )
                    .map_err(db_error)?;
            }
        }
        Ok(())
    }

    pub fn mailbox(&self, id: i64) -> Result<(String, String), String> {
        self.conn()?
            .query_row(
                "SELECT account_id,name FROM mailboxes WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Mailbox not found.".into())
    }

    pub fn max_uid(&self, mailbox_id: i64) -> Result<u32, String> {
        self.conn()?
            .query_row(
                "SELECT COALESCE(MAX(uid), 0) FROM messages WHERE mailbox_id = ?1",
                [mailbox_id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }

    pub fn min_uid(&self, mailbox_id: i64) -> Result<Option<u32>, String> {
        self.conn()?
            .query_row(
                "SELECT MIN(uid) FROM messages WHERE mailbox_id = ?1",
                [mailbox_id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }

    pub fn backfill_cursor(&self, mailbox_id: i64) -> Result<Option<u32>, String> {
        self.conn()?
            .query_row(
                "SELECT backfill_uid FROM mailboxes WHERE id=?1",
                [mailbox_id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }

    pub fn set_backfill_cursor(&self, mailbox_id: i64, uid: u32) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE mailboxes SET backfill_uid=?2 WHERE id=?1",
                params![mailbox_id, uid],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn cached_uids(&self, mailbox_id: i64) -> Result<Vec<u32>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare("SELECT uid FROM messages WHERE mailbox_id=?1 ORDER BY uid")
            .map_err(db_error)?;
        let rows = statement
            .query_map([mailbox_id], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn uncached_message_uids(
        &self,
        mailbox_id: i64,
        limit: u32,
        max_size: u64,
    ) -> Result<Vec<u32>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT uid FROM messages
                 WHERE mailbox_id = ?1 AND LENGTH(raw_message) = 0 AND size <= ?2
                 ORDER BY received_at DESC, uid DESC
                 LIMIT ?3",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![mailbox_id, max_size, limit], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn reconcile_flags(
        &self,
        mailbox_id: i64,
        seen: &[(u32, bool, bool)],
        requested: &[u32],
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        for (uid, is_read, is_starred) in seen {
            transaction
                .execute(
                    "UPDATE messages SET is_read=?3,is_starred=?4 WHERE mailbox_id=?1 AND uid=?2",
                    params![mailbox_id, uid, *is_read as i32, *is_starred as i32],
                )
                .map_err(db_error)?;
        }
        let returned = seen
            .iter()
            .map(|item| item.0)
            .collect::<std::collections::HashSet<_>>();
        for uid in requested.iter().filter(|uid| !returned.contains(uid)) {
            transaction
                .execute(
                    "DELETE FROM messages WHERE mailbox_id=?1 AND uid=?2 AND pending_move_to IS NULL",
                    params![mailbox_id, uid],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    pub fn upsert_message(
        &self,
        account_id: &str,
        mailbox_id: i64,
        message: &CachedMessage,
    ) -> Result<(), String> {
        let attachments = serde_json::to_string(&message.attachments)
            .map_err(|_| "Could not index attachments.".to_string())?;
        let to_json = serde_json::to_string(&message.to)
            .map_err(|_| "Could not index recipients.".to_string())?;
        let cc_json = serde_json::to_string(&message.cc)
            .map_err(|_| "Could not index recipients.".to_string())?;
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let (thread_parent, thread_root) =
            provisional_thread_root(&transaction, account_id, mailbox_id, message)?;
        transaction.execute(
            "INSERT INTO messages (
                account_id, mailbox_id, uid, message_id, subject, sender_name, sender_address, recipients,
                received_at, preview, is_read, is_starred, has_attachments, size, to_json, cc_json,
                reply_to, thread_parent, thread_root, text_body, html_body, attachments_json, raw_message, accessed_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,CURRENT_TIMESTAMP)
             ON CONFLICT(mailbox_id, uid) DO UPDATE SET
                message_id=excluded.message_id, subject=excluded.subject, sender_name=excluded.sender_name,
                sender_address=excluded.sender_address, recipients=excluded.recipients, received_at=excluded.received_at,
                preview=excluded.preview, is_read=excluded.is_read, is_starred=excluded.is_starred,
                has_attachments=excluded.has_attachments, size=excluded.size, to_json=excluded.to_json,
                cc_json=excluded.cc_json, reply_to=excluded.reply_to, thread_parent=excluded.thread_parent,
                thread_root=excluded.thread_root, text_body=excluded.text_body,
                html_body=excluded.html_body, attachments_json=excluded.attachments_json, raw_message=excluded.raw_message",
            params![
                account_id, mailbox_id, message.uid, message.message_id, message.subject, message.sender_name,
                message.sender_address, message.recipients, message.received_at, message.preview,
                message.is_read as i32, message.is_starred as i32, (!message.attachments.is_empty()) as i32,
                message.size, to_json, cc_json, message.reply_to, thread_parent, thread_root,
                message.text_body, message.html_body,
                attachments, message.raw_message,
            ],
        ).map_err(db_error)?;
        let id: i64 = transaction
            .query_row(
                "SELECT id FROM messages WHERE mailbox_id = ?1 AND uid = ?2",
                params![mailbox_id, message.uid],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        transaction
            .execute("DELETE FROM message_fts WHERE message_id = ?1", [id])
            .map_err(db_error)?;
        transaction.execute(
            "INSERT INTO message_fts(message_id, subject, sender, recipients, body) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, message.subject, format!("{} {}", message.sender_name, message.sender_address), message.recipients, message.text_body],
        ).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn upsert_envelope(
        &self,
        account_id: &str,
        mailbox_id: i64,
        message: &CachedMessage,
    ) -> Result<(), String> {
        let to_json = serde_json::to_string(&message.to)
            .map_err(|_| "Could not index recipients.".to_string())?;
        let cc_json = serde_json::to_string(&message.cc)
            .map_err(|_| "Could not index recipients.".to_string())?;
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let (thread_parent, thread_root) =
            provisional_thread_root(&transaction, account_id, mailbox_id, message)?;
        transaction.execute(
            "INSERT INTO messages (
                account_id, mailbox_id, uid, message_id, subject, sender_name, sender_address, recipients,
                received_at, preview, is_read, is_starred, has_attachments, size, to_json, cc_json,
                reply_to, thread_parent, thread_root, text_body, html_body, attachments_json, raw_message, accessed_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'',?10,?11,0,?12,?13,?14,?15,?16,?17,'',NULL,'[]',X'',CURRENT_TIMESTAMP)
             ON CONFLICT(mailbox_id, uid) DO UPDATE SET
                message_id=excluded.message_id, subject=excluded.subject, sender_name=excluded.sender_name,
                sender_address=excluded.sender_address, recipients=excluded.recipients, received_at=excluded.received_at,
                is_read=excluded.is_read, is_starred=excluded.is_starred, size=excluded.size,
                to_json=excluded.to_json, cc_json=excluded.cc_json, reply_to=excluded.reply_to,
                thread_parent=excluded.thread_parent, thread_root=excluded.thread_root",
            params![
                account_id,
                mailbox_id,
                message.uid,
                message.message_id,
                message.subject,
                message.sender_name,
                message.sender_address,
                message.recipients,
                message.received_at,
                message.is_read as i32,
                message.is_starred as i32,
                message.size,
                to_json,
                cc_json,
                message.reply_to,
                thread_parent,
                thread_root,
            ],
        ).map_err(db_error)?;
        let id: i64 = transaction
            .query_row(
                "SELECT id FROM messages WHERE mailbox_id=?1 AND uid=?2",
                params![mailbox_id, message.uid],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        transaction
            .execute("DELETE FROM message_fts WHERE message_id=?1", [id])
            .map_err(db_error)?;
        transaction.execute(
            "INSERT INTO message_fts(message_id,subject,sender,recipients,body)
             SELECT id,subject,sender_name || ' ' || sender_address,recipients,text_body FROM messages WHERE id=?1",
            [id],
        ).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    fn resolve_thread_root(
        transaction: &rusqlite::Transaction,
        account_id: &str,
        start: &str,
    ) -> Result<String, String> {
        let mut current = start.to_string();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for _ in 0..25 {
            if !seen.insert(current.clone()) {
                break;
            }
            let parent: Option<Option<String>> = transaction
                .query_row(
                    "SELECT thread_parent FROM messages WHERE account_id=?1 AND message_id=?2 LIMIT 1",
                    params![account_id, current],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            match parent.flatten() {
                Some(next) if next != current => current = next,
                _ => break,
            }
        }
        Ok(current)
    }

    /// Repair thread roots for freshly cached messages and their
    /// descendants. Arrival order is arbitrary (parents often sync after
    /// children), so every sync pass re-resolves the touched subtrees to a
    /// fixpoint instead of trusting provisional roots.
    pub fn repair_thread_roots(&self, account_id: &str, arrived: &[String]) -> Result<(), String> {
        if arrived.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let mut stack: Vec<String> = arrived.to_vec();
        let mut seen: std::collections::HashSet<String> = stack.iter().cloned().collect();
        let mut rounds = 0usize;
        while let Some(id) = stack.pop() {
            if rounds >= 2000 {
                break;
            }
            rounds += 1;
            let root = Self::resolve_thread_root(&transaction, account_id, &id)?;
            transaction
                .execute(
                    "UPDATE messages SET thread_root=?3 WHERE account_id=?1 AND message_id=?2 AND (thread_root IS NULL OR thread_root<>?3)",
                    params![account_id, id, root],
                )
                .map_err(db_error)?;
            let mut statement = transaction
                .prepare(
                    "SELECT DISTINCT message_id FROM messages WHERE account_id=?1 AND message_id IS NOT NULL AND message_id<>?2 AND (thread_root=?2 OR thread_parent=?2)",
                )
                .map_err(db_error)?;
            let children = statement
                .query_map(params![account_id, id], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            drop(statement);
            for child in children {
                if seen.insert(child.clone()) {
                    stack.push(child);
                }
            }
        }
        transaction.commit().map_err(db_error)
    }

    pub fn list_messages(
        &self,
        mailbox_id: i64,
        cursor: Option<&MessageCursor>,
        limit: u32,
    ) -> Result<MessagePage, String> {
        let conn = self.conn()?;
        let page_size = limit.clamp(1, 200);
        // Snoozed mail hides from browsing until due; expired rows are
        // pruned lazily here so both lists stay consistent. Times compare
        // as text: until values are canonical RFC3339 (+00:00) at write.
        conn.execute(
            "DELETE FROM snoozed_messages WHERE message_id IN (SELECT id FROM messages WHERE mailbox_id=?1) AND snoozed_until<=strftime('%Y-%m-%dT%H:%M:%S+00:00','now')",
            [mailbox_id],
        )
        .map_err(db_error)?;
        let mut statement = conn
            .prepare(&format!(
                "{} WHERE mailbox_id = ?1 AND pending_move_to IS NULL
                 AND NOT EXISTS (SELECT 1 FROM snoozed_messages s WHERE s.message_id=m.id)
                 AND (?2 IS NULL OR received_at < ?2 OR (received_at = ?2 AND uid < ?3))
                 ORDER BY received_at DESC, uid DESC LIMIT ?4",
                MESSAGE_SUMMARY_SELECT,
            ))
            .map_err(db_error)?;
        let cursor_date = cursor.map(|value| value.received_at.as_str());
        let cursor_uid = cursor.map(|value| value.uid);
        let mut items = statement
            .query_map(
                params![mailbox_id, cursor_date, cursor_uid, page_size + 1],
                map_message_summary,
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let has_more = items.len() > page_size as usize;
        if has_more {
            items.truncate(page_size as usize);
        }
        let next_cursor = has_more
            .then(|| items.last())
            .flatten()
            .map(|last| MessageCursor {
                received_at: last.received_at.clone(),
                uid: last.uid,
            });
        Ok(MessagePage {
            items,
            next_cursor,
            has_more,
        })
    }

    pub fn message_summary_by_uid(
        &self,
        mailbox_id: i64,
        uid: u32,
    ) -> Result<Option<MessageSummary>, String> {
        self.conn()?
            .query_row(
                &format!(
                    "{} WHERE m.mailbox_id=?1 AND m.uid=?2 AND m.pending_move_to IS NULL",
                    MESSAGE_SUMMARY_SELECT
                ),
                params![mailbox_id, uid],
                map_message_summary,
            )
            .optional()
            .map_err(db_error)
    }

    pub fn latest_inbox_message(&self, account_id: &str) -> Result<Option<MessageSummary>, String> {
        let conn = self.conn()?;
        conn.query_row(
            &format!("{} JOIN mailboxes box ON box.id=m.mailbox_id WHERE m.account_id=?1 AND box.role='inbox' ORDER BY m.received_at DESC,m.uid DESC LIMIT 1", MESSAGE_SUMMARY_SELECT),
            [account_id], map_message_summary,
        ).optional().map_err(db_error)
    }

    pub fn message_detail(&self, id: i64, account_id: &str) -> Result<MessageDetail, String> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE messages SET accessed_at = CURRENT_TIMESTAMP WHERE id = ?1 AND account_id = ?2",
            params![id, account_id],
        )
        .map_err(db_error)?;
        conn.query_row(
            &format!(
                "{} WHERE m.id = ?1 AND m.account_id = ?2",
                MESSAGE_DETAIL_SELECT
            ),
            params![id, account_id],
            |row| {
                let html_body: Option<String> = row.get(19)?;
                Ok(MessageDetail {
                    summary: map_message_summary(row)?,
                    to: json_or_default(row.get::<_, String>(15)?),
                    cc: json_or_default(row.get::<_, String>(16)?),
                    reply_to: row.get(17)?,
                    text_body: row.get(18)?,
                    remote_images_blocked: html_body.as_deref().is_some_and(has_remote_images),
                    html_body,
                    attachments: json_or_default(row.get::<_, String>(20)?),
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Message not found in the local cache.".into())
    }

    pub fn raw_message(&self, id: i64, account_id: &str) -> Result<Vec<u8>, String> {
        let raw: Vec<u8> = self
            .conn()?
            .query_row(
                "SELECT raw_message FROM messages WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Message not found.".to_string())?;
        if raw.is_empty() {
            Err("Message content is not downloaded.".into())
        } else {
            Ok(raw)
        }
    }

    pub fn message_content_cached(&self, id: i64, account_id: &str) -> Result<bool, String> {
        self.conn()?
            .query_row(
                "SELECT LENGTH(raw_message) > 0 FROM messages WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Message not found.".into())
    }

    pub fn set_flags(
        &self,
        id: i64,
        is_read: Option<bool>,
        is_starred: Option<bool>,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let (mailbox_id, was_read): (i64, bool) = transaction
            .query_row(
                "SELECT mailbox_id,is_read != 0 FROM messages WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Message not found.".to_string())?;
        transaction.execute(
            "UPDATE messages SET is_read=COALESCE(?2,is_read), is_starred=COALESCE(?3,is_starred) WHERE id=?1",
            params![id, is_read.map(i32::from), is_starred.map(i32::from)],
        ).map_err(db_error)?;
        if let Some(is_read) = is_read.filter(|is_read| *is_read != was_read) {
            let delta = if is_read { -1 } else { 1 };
            transaction
                .execute(
                    "UPDATE mailboxes SET local_unread_delta=local_unread_delta + ?2 WHERE id=?1",
                    params![mailbox_id, delta],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn set_flags_bulk(
        &self,
        ids: &[i64],
        is_read: Option<bool>,
        is_starred: Option<bool>,
    ) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        for id in ids {
            let (mailbox_id, was_read): (i64, bool) = transaction
                .query_row(
                    "SELECT mailbox_id,is_read != 0 FROM messages WHERE id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?
                .ok_or_else(|| "Message not found.".to_string())?;
            transaction.execute(
                "UPDATE messages SET is_read=COALESCE(?2,is_read), is_starred=COALESCE(?3,is_starred) WHERE id=?1",
                params![id, is_read.map(i32::from), is_starred.map(i32::from)],
            ).map_err(db_error)?;
            if let Some(is_read) = is_read.filter(|is_read| *is_read != was_read) {
                let delta = if is_read { -1 } else { 1 };
                transaction
                    .execute(
                        "UPDATE mailboxes SET local_unread_delta=local_unread_delta + ?2 WHERE id=?1",
                        params![mailbox_id, delta],
                    )
                    .map_err(db_error)?;
            }
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn unread_message_ids(&self, mailbox_id: i64) -> Result<Vec<(i64, u32)>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare("SELECT id,uid FROM messages WHERE mailbox_id=?1 AND is_read=0 AND pending_move_to IS NULL ORDER BY uid")
            .map_err(db_error)?;
        let rows = statement
            .query_map([mailbox_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub fn pending_move_uids(&self, mailbox_id: i64) -> Result<Vec<u32>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare("SELECT uid FROM messages WHERE mailbox_id=?1 AND pending_move_to IS NOT NULL")
            .map_err(db_error)?;
        let rows = statement
            .query_map([mailbox_id], |row| row.get(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub fn clear_mailbox_messages(&self, mailbox_id: i64) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM message_fts WHERE message_id IN (SELECT id FROM messages WHERE mailbox_id=?1)",
                [mailbox_id],
            )
            .map_err(db_error)?;
        transaction
            .execute("DELETE FROM messages WHERE mailbox_id=?1", [mailbox_id])
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    /// Drop a UIDVALIDITY generation that no longer matches the server:
    /// cached rows, plus queued operations that name its UIDs.
    pub fn purge_stale_mailbox(
        &self,
        account_id: &str,
        mailbox_name: &str,
        mailbox_id: i64,
    ) -> Result<(), String> {
        self.clear_mailbox_messages(mailbox_id)?;
        self.conn()?
            .execute(
                "DELETE FROM offline_ops WHERE account_id=?1 AND ((kind='flags' AND json_extract(payload,'$.mailbox')=?2) OR (kind='move' AND json_extract(payload,'$.source')=?2))",
                params![account_id, mailbox_name],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn record_recipients(
        &self,
        account_id: &str,
        entries: &[(String, String)],
    ) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        for (address, name) in entries {
            let address = address.trim().to_ascii_lowercase();
            if address.is_empty() || address.len() > 320 || !address.contains('@') {
                continue;
            }
            let name = name.trim().chars().take(200).collect::<String>();
            transaction
                .execute(
                    "INSERT INTO recipient_history(account_id,address,name,use_count,last_used)
                     VALUES(?1,?2,?3,1,CURRENT_TIMESTAMP)
                     ON CONFLICT(account_id,address) DO UPDATE SET
                       use_count=use_count+1, last_used=CURRENT_TIMESTAMP,
                       name=CASE WHEN ?3='' THEN name ELSE ?3 END",
                    params![account_id, address, name],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn suggest_recipients(
        &self,
        account_id: &str,
        prefix: &str,
        limit: u32,
    ) -> Result<Vec<RecipientSuggestion>, String> {
        let escaped: String = prefix
            .trim()
            .to_ascii_lowercase()
            .chars()
            .take(200)
            .flat_map(|character| match character {
                '\\' => vec!['\\', '\\'],
                '%' => vec!['\\', '%'],
                '_' => vec!['\\', '_'],
                other => vec![other],
            })
            .collect();
        if escaped.is_empty() {
            return Ok(Vec::new());
        }
        let like = format!("%{escaped}%");
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT address,name,use_count FROM recipient_history
                 WHERE account_id=?1 AND (address LIKE ?2 ESCAPE '\\' OR name LIKE ?2 ESCAPE '\\')
                 ORDER BY use_count DESC, last_used DESC LIMIT ?3",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(
                params![account_id, like, limit.clamp(1, 20) as i64],
                |row| {
                    Ok(RecipientSuggestion {
                        address: row.get(0)?,
                        name: row.get(1)?,
                        use_count: row.get::<_, i64>(2)? as u32,
                    })
                },
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub fn mark_pending_move(&self, id: i64, mailbox_id: i64) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let (source_id, is_read, current_pending): (i64, bool, Option<i64>) = transaction
            .query_row(
                "SELECT mailbox_id,is_read != 0,pending_move_to FROM messages WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(db_error)?;
        let source_account: String = transaction
            .query_row(
                "SELECT account_id FROM mailboxes WHERE id=?1",
                [source_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let dest_account: String = transaction
            .query_row(
                "SELECT account_id FROM mailboxes WHERE id=?1",
                [mailbox_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if source_account != dest_account {
            return Err("Messages cannot be moved between different accounts.".into());
        }
        transaction
            .execute(
                "UPDATE messages SET pending_move_to=?2 WHERE id=?1",
                params![id, mailbox_id],
            )
            .map_err(db_error)?;
        match current_pending {
            None => {
                adjust_mailbox_counts(&transaction, source_id, -1, (!is_read).then_some(-1))?;
                adjust_mailbox_counts(&transaction, mailbox_id, 1, (!is_read).then_some(1))?;
            }
            Some(previous_id) if previous_id != mailbox_id => {
                adjust_mailbox_counts(&transaction, previous_id, -1, (!is_read).then_some(-1))?;
                adjust_mailbox_counts(&transaction, mailbox_id, 1, (!is_read).then_some(1))?;
            }
            Some(_) => {}
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn clear_pending_move(&self, id: i64) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let row: Option<(i64, bool, Option<i64>)> = transaction
            .query_row(
                "SELECT mailbox_id,is_read != 0,pending_move_to FROM messages WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db_error)?;
        transaction
            .execute("UPDATE messages SET pending_move_to=NULL WHERE id=?1", [id])
            .map_err(db_error)?;
        if let Some((source_id, is_read, Some(destination_id))) = row {
            adjust_mailbox_counts(&transaction, source_id, 1, (!is_read).then_some(1))?;
            adjust_mailbox_counts(&transaction, destination_id, -1, (!is_read).then_some(-1))?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn remove_message(&self, id: i64) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let row: Option<(i64, bool, Option<i64>)> = transaction
            .query_row(
                "SELECT mailbox_id,is_read != 0,pending_move_to FROM messages WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db_error)?;
        transaction
            .execute("DELETE FROM messages WHERE id=?1", [id])
            .map_err(db_error)?;
        if let Some((mailbox_id, is_read, None)) = row {
            adjust_mailbox_counts(&transaction, mailbox_id, -1, (!is_read).then_some(-1))?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn message_location(&self, id: i64) -> Result<(String, String, u32), String> {
        self.conn()?.query_row(
            "SELECT m.account_id, f.name, m.uid FROM messages m JOIN mailboxes f ON f.id=m.mailbox_id WHERE m.id=?1",
            [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(db_error)?.ok_or_else(|| "Message not found.".into())
    }

    pub fn mailbox_uid_validity(
        &self,
        account_id: &str,
        mailbox: &str,
    ) -> Result<Option<u32>, String> {
        let value: Option<Option<u32>> = self
            .conn()?
            .query_row(
                "SELECT uid_validity FROM mailboxes WHERE account_id=?1 AND name=?2",
                params![account_id, mailbox],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        Ok(value.flatten())
    }

    pub fn mailbox_sync_state(
        &self,
        account_id: &str,
        mailbox: &str,
    ) -> Result<Option<MailboxSyncState>, String> {
        let value: Option<MailboxSyncState> = self
            .conn()?
            .query_row(
                "SELECT uid_validity, uid_next, server_total, server_unread FROM mailboxes WHERE account_id=?1 AND name=?2",
                params![account_id, mailbox],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(db_error)?;
        Ok(value)
    }

    pub fn message_fetch_location(
        &self,
        id: i64,
    ) -> Result<(String, i64, String, u32, u64), String> {
        self.conn()?.query_row(
            "SELECT m.account_id, m.mailbox_id, f.name, m.uid, m.size FROM messages m JOIN mailboxes f ON f.id=m.mailbox_id WHERE m.id=?1",
            [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional().map_err(db_error)?.ok_or_else(|| "Message not found.".into())
    }

    pub fn search(&self, query: &SearchQuery) -> Result<Vec<MessageSummary>, String> {
        let conn = self.conn()?;
        let terms = fts_query(&query.text);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let mailbox_filter = if query.all_folders {
            ""
        } else {
            " AND (?3 IS NULL OR m.mailbox_id = ?3)"
        };
        let sql = format!(
            "{} JOIN message_fts fts ON fts.message_id=m.id WHERE m.account_id=?1 AND m.pending_move_to IS NULL AND message_fts MATCH ?2 {} ORDER BY bm25(message_fts), m.received_at DESC LIMIT ?4",
            MESSAGE_SUMMARY_SELECT, mailbox_filter,
        );
        let mut statement = conn.prepare(&sql).map_err(db_error)?;
        let rows = statement
            .query_map(
                params![
                    query.account_id,
                    terms,
                    query.mailbox_id,
                    query.limit.min(500)
                ],
                map_message_summary,
            )
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn search_all_accounts(
        &self,
        text: &str,
        limit: u32,
    ) -> Result<Vec<MessageSummary>, String> {
        let conn = self.conn()?;
        let terms = fts_query(text);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "{} JOIN message_fts fts ON fts.message_id=m.id WHERE m.pending_move_to IS NULL AND message_fts MATCH ?1 ORDER BY bm25(message_fts), m.received_at DESC LIMIT ?2",
            MESSAGE_SUMMARY_SELECT,
        );
        let mut statement = conn.prepare(&sql).map_err(db_error)?;
        let rows = statement
            .query_map(params![terms, limit.min(500)], map_message_summary)
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn save_draft(&self, draft: &ComposeDraft) -> Result<String, String> {
        let id = draft
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut stored = draft.clone();
        stored.id = Some(id.clone());
        let mut conn = self.conn()?;
        let existing: Option<(String, u32)> = conn
            .query_row(
                "SELECT account_id,revision FROM drafts WHERE id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        if existing
            .as_ref()
            .map(|value| value.0.as_str())
            .is_some_and(|account_id| account_id != draft.account_id)
        {
            return Err("Draft does not belong to this account.".into());
        }
        let json =
            serde_json::to_string(&stored).map_err(|_| "Could not save draft.".to_string())?;
        let revision = existing.map_or(1, |value| value.1.saturating_add(1));
        let remote_message_id = format!("<draft-{id}-{revision}@run.rosie.snap>");
        let transaction = conn.transaction().map_err(db_error)?;
        transaction.execute(
            "INSERT INTO drafts(id,account_id,draft_json,updated_at,sync_state,remote_message_id,revision,deleted_at)
             VALUES(?1,?2,?3,CURRENT_TIMESTAMP,'localPending',?4,?5,NULL)
             ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,updated_at=CURRENT_TIMESTAMP,
             sync_state='localPending',sync_detail=NULL,remote_message_id=excluded.remote_message_id,
             revision=excluded.revision,deleted_at=NULL",
            params![id, draft.account_id, json, remote_message_id, revision],
        ).map_err(db_error)?;
        replace_attachment_refs(
            &transaction,
            &draft.account_id,
            "draft",
            &id,
            &stored.attachments,
        )?;
        transaction.commit().map_err(db_error)?;
        Ok(id)
    }

    pub fn list_drafts(&self, account_id: &str) -> Result<Vec<DraftSummary>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id,draft_json,updated_at,sync_state,sync_detail FROM drafts
                 WHERE account_id=?1 AND (deleted_at IS NULL OR sync_state='deletePending') ORDER BY updated_at DESC",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows.into_iter()
            .map(|(id, json, updated_at, sync_state, sync_detail)| {
                let draft: ComposeDraft = serde_json::from_str(&json)
                    .map_err(|_| "A saved draft could not be read.".to_string())?;
                Ok(DraftSummary {
                    id,
                    account_id: account_id.to_string(),
                    recipients: draft.to.join(", "),
                    subject: draft.subject,
                    updated_at,
                    sync_state,
                    sync_detail,
                })
            })
            .collect()
    }

    pub fn draft(&self, id: &str, account_id: &str) -> Result<ComposeDraft, String> {
        let json: String = self
            .conn()?
            .query_row(
                "SELECT draft_json FROM drafts WHERE id=?1 AND account_id=?2 AND (deleted_at IS NULL OR sync_state='deletePending')",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Draft not found.".to_string())?;
        serde_json::from_str(&json).map_err(|_| "This saved draft could not be read.".into())
    }

    pub fn remove_draft(&self, id: &str, account_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let remote_uid: Option<Option<u32>> = transaction
            .query_row(
                "SELECT remote_uid FROM drafts WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        match remote_uid {
            Some(Some(_)) => {
                transaction
                    .execute(
                        "UPDATE drafts SET deleted_at=CURRENT_TIMESTAMP,sync_state='deletePending',sync_detail=NULL WHERE id=?1 AND account_id=?2",
                        params![id, account_id],
                    )
                    .map_err(db_error)?;
            }
            Some(None) => {
                transaction
                    .execute(
                        "DELETE FROM attachment_refs WHERE owner_kind='draft' AND owner_id=?1",
                        [id],
                    )
                    .map_err(db_error)?;
                transaction
                    .execute(
                        "DELETE FROM drafts WHERE id=?1 AND account_id=?2",
                        params![id, account_id],
                    )
                    .map_err(db_error)?;
            }
            None => return Err("Draft not found.".into()),
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn pending_draft_sync(&self, account_id: &str) -> Result<Vec<DraftSyncRecord>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id,draft_json,remote_mailbox,remote_uid,remote_uid_validity,
                 COALESCE(remote_message_id,''),revision,deleted_at IS NOT NULL
                 FROM drafts WHERE account_id=?1 AND sync_state IN ('localPending','deletePending','localOnly')
                 ORDER BY updated_at",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<u32>>(3)?,
                    row.get::<_, Option<u32>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, u32>(6)?,
                    row.get::<_, bool>(7)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows.into_iter()
            .map(
                |(
                    id,
                    json,
                    remote_mailbox,
                    remote_uid,
                    remote_uid_validity,
                    remote_message_id,
                    revision,
                    deleted,
                )| {
                    let draft = serde_json::from_str(&json)
                        .map_err(|_| "A saved draft could not be synchronized.".to_string())?;
                    Ok(DraftSyncRecord {
                        id,
                        draft,
                        remote_mailbox,
                        remote_uid,
                        remote_uid_validity,
                        remote_message_id,
                        revision,
                        deleted,
                    })
                },
            )
            .collect()
    }

    pub fn set_draft_sync_warning(&self, account_id: &str, detail: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE drafts SET sync_state='localOnly',sync_detail=?2
                 WHERE account_id=?1 AND sync_state IN ('localPending','localOnly') AND deleted_at IS NULL",
                params![account_id, detail],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn set_one_draft_sync_warning(
        &self,
        id: &str,
        account_id: &str,
        detail: &str,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE drafts SET sync_state='localOnly',sync_detail=?3
                 WHERE id=?1 AND account_id=?2",
                params![id, account_id, detail],
            )
            .map_err(db_error)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_draft_synced(
        &self,
        id: &str,
        account_id: &str,
        mailbox: &str,
        uid: u32,
        uid_validity: Option<u32>,
        message_id: &str,
        revision: u32,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE drafts SET sync_state='synced',sync_detail=NULL,remote_mailbox=?3,remote_uid=?4,
                 remote_uid_validity=?5,remote_message_id=?6 WHERE id=?1 AND account_id=?2 AND revision=?7",
                params![id, account_id, mailbox, uid, uid_validity, message_id, revision],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn finish_remote_draft_delete(&self, id: &str, account_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM attachment_refs WHERE owner_kind='draft' AND owner_id=?1",
                [id],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM drafts WHERE id=?1 AND account_id=?2 AND deleted_at IS NOT NULL",
                params![id, account_id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn remote_draft_uids(
        &self,
        account_id: &str,
        mailbox: &str,
        uid_validity: Option<u32>,
    ) -> Result<std::collections::HashSet<u32>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT remote_uid FROM drafts WHERE account_id=?1 AND remote_mailbox=?2
                 AND remote_uid_validity IS ?3 AND remote_uid IS NOT NULL",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![account_id, mailbox, uid_validity], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>()
            .map_err(db_error)
    }

    pub fn draft_sync_state(
        &self,
        id: &str,
        account_id: &str,
    ) -> Result<Option<(String, u32)>, String> {
        self.conn()?
            .query_row(
                "SELECT sync_state,revision FROM drafts WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn import_remote_draft(
        &self,
        id: &str,
        draft: &ComposeDraft,
        mailbox: &str,
        uid: u32,
        uid_validity: Option<u32>,
        message_id: Option<&str>,
        revision: u32,
        updated_at: &str,
        sync_state: &str,
        sync_detail: Option<&str>,
    ) -> Result<(), String> {
        let mut stored = draft.clone();
        stored.id = Some(id.to_string());
        let json = serde_json::to_string(&stored)
            .map_err(|_| "Could not save a server draft.".to_string())?;
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute(
                "INSERT INTO drafts(id,account_id,draft_json,updated_at,sync_state,sync_detail,
                 remote_mailbox,remote_uid,remote_uid_validity,remote_message_id,revision,deleted_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL)
                 ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,updated_at=excluded.updated_at,
                 sync_state=excluded.sync_state,sync_detail=excluded.sync_detail,
                 remote_mailbox=excluded.remote_mailbox,remote_uid=excluded.remote_uid,
                 remote_uid_validity=excluded.remote_uid_validity,
                 remote_message_id=excluded.remote_message_id,revision=excluded.revision,deleted_at=NULL",
                params![
                    id,
                    draft.account_id,
                    json,
                    updated_at,
                    sync_state,
                    sync_detail,
                    mailbox,
                    uid,
                    uid_validity,
                    message_id,
                    revision,
                ],
            )
            .map_err(db_error)?;
        replace_attachment_refs(
            &transaction,
            &draft.account_id,
            "draft",
            id,
            &stored.attachments,
        )?;
        transaction.commit().map_err(db_error)
    }

    pub fn update_remote_draft_tracking(
        &self,
        id: &str,
        account_id: &str,
        mailbox: &str,
        uid: u32,
        uid_validity: Option<u32>,
        message_id: Option<&str>,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE drafts SET remote_mailbox=?3,remote_uid=?4,remote_uid_validity=?5,remote_message_id=?6 WHERE id=?1 AND account_id=?2",
                params![id, account_id, mailbox, uid, uid_validity, message_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn reconcile_remote_drafts(
        &self,
        account_id: &str,
        mailbox: &str,
        uid_validity: Option<u32>,
        server_uids: &std::collections::HashSet<u32>,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let ids = {
            let mut statement = conn
                .prepare(
                    "SELECT id,remote_uid FROM drafts WHERE account_id=?1 AND remote_mailbox=?2
                     AND remote_uid_validity IS ?3 AND sync_state IN ('synced','conflict')",
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(params![account_id, mailbox, uid_validity], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            rows
        };
        let transaction = conn.transaction().map_err(db_error)?;
        for (id, _) in ids
            .into_iter()
            .filter(|(_, uid)| !server_uids.contains(uid))
        {
            transaction
                .execute(
                    "DELETE FROM attachment_refs WHERE owner_kind='draft' AND owner_id=?1",
                    [&id],
                )
                .map_err(db_error)?;
            transaction
                .execute("DELETE FROM drafts WHERE id=?1", [&id])
                .map_err(db_error)?;
        }
        // Rows tracked under a previous UIDVALIDITY generation belong to a
        // deleted server mailbox incarnation. Drop them so the next import
        // starts clean instead of duplicating foreign drafts.
        let stale: Vec<String> = transaction
            .prepare(
                "SELECT id FROM drafts WHERE account_id=?1 AND remote_mailbox=?2
                 AND NOT (remote_uid_validity IS ?3) AND sync_state IN ('synced','conflict')",
            )
            .map_err(db_error)?
            .query_map(params![account_id, mailbox, uid_validity], |row| row.get(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for id in stale {
            transaction
                .execute(
                    "DELETE FROM attachment_refs WHERE owner_kind='draft' AND owner_id=?1",
                    [&id],
                )
                .map_err(db_error)?;
            transaction
                .execute("DELETE FROM drafts WHERE id=?1", [&id])
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    pub fn queue_outbox(
        &self,
        draft: &ComposeDraft,
        state: &str,
        detail: Option<&str>,
        message_id: &str,
        mime_bytes: &[u8],
        send_at: Option<&str>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let json =
            serde_json::to_string(draft).map_err(|_| "Could not queue message.".to_string())?;
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute(
                "INSERT INTO outbox(id,account_id,draft_json,state,detail,message_id,mime_bytes,send_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,CURRENT_TIMESTAMP)",
                params![id, draft.account_id, json, state, detail, message_id, mime_bytes, send_at],
            )
            .map_err(db_error)?;
        replace_attachment_refs(
            &transaction,
            &draft.account_id,
            "outbox",
            &id,
            &draft.attachments,
        )?;
        transaction.commit().map_err(db_error)?;
        Ok(id)
    }

    pub fn set_outbox_state(
        &self,
        id: &str,
        state: &str,
        detail: Option<&str>,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE outbox SET state=?2,detail=?3,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![id, state, detail],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn remove_outbox(&self, id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM attachment_refs WHERE owner_kind='outbox' AND owner_id=?1",
                [id],
            )
            .map_err(db_error)?;
        transaction
            .execute("DELETE FROM outbox WHERE id=?1", [id])
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn list_outbox(&self, account_id: &str) -> Result<Vec<OutboxSummary>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id,draft_json,state,detail,created_at,send_at FROM outbox WHERE account_id=?1 ORDER BY created_at DESC",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows.into_iter()
            .map(|(id, json, state, detail, created_at, send_at)| {
                let draft: ComposeDraft = serde_json::from_str(&json)
                    .map_err(|_| "A queued message could not be read.".to_string())?;
                Ok(OutboxSummary {
                    id,
                    account_id: account_id.to_string(),
                    recipients: draft.to.join(", "),
                    subject: draft.subject,
                    state,
                    detail,
                    created_at,
                    send_at,
                })
            })
            .collect()
    }

    pub fn outbox(&self, id: &str, account_id: &str) -> Result<(ComposeDraft, String), String> {
        let row: (String, String) = self
            .conn()?
            .query_row(
                "SELECT draft_json,state FROM outbox WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Queued message not found.".to_string())?;
        let draft = serde_json::from_str(&row.0)
            .map_err(|_| "This queued message could not be read.".to_string())?;
        Ok((draft, row.1))
    }

    pub fn outbox_delivery(
        &self,
        id: &str,
        account_id: &str,
    ) -> Result<(ComposeDraft, String, String, Vec<u8>), String> {
        let row: (String, String, String, Vec<u8>) = self
            .conn()?
            .query_row(
                "SELECT draft_json,state,COALESCE(message_id,''),COALESCE(mime_bytes,X'')
                 FROM outbox WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Queued message not found.".to_string())?;
        let draft = serde_json::from_str(&row.0)
            .map_err(|_| "This queued message could not be read.".to_string())?;
        Ok((draft, row.1, row.2, row.3))
    }

    pub fn outbox_ids_in_state(
        &self,
        account_id: &str,
        states: &[&str],
    ) -> Result<Vec<String>, String> {
        if states.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn()?;
        let placeholders = std::iter::repeat_n("?", states.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id FROM outbox WHERE account_id=? AND state IN ({placeholders}) ORDER BY created_at"
        );
        let mut values: Vec<&dyn rusqlite::ToSql> = vec![&account_id];
        values.extend(states.iter().map(|state| state as &dyn rusqlite::ToSql));
        let mut statement = conn.prepare(&sql).map_err(db_error)?;
        let rows = statement
            .query_map(values.as_slice(), |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn scheduled_due_outbox_ids(
        &self,
        account_id: &str,
        now: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id FROM outbox WHERE account_id=?1 AND state='scheduled' AND send_at IS NOT NULL AND send_at<=?2 ORDER BY created_at",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![account_id, now], |row| row.get(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub fn snooze_message(
        &self,
        account_id: &str,
        message_id: i64,
        until_iso: &str,
    ) -> Result<(), String> {
        let owner: Option<String> = self
            .conn()?
            .query_row(
                "SELECT account_id FROM messages WHERE id=?1",
                [message_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .flatten();
        if owner.as_deref() != Some(account_id) {
            return Err("Message does not belong to this account.".into());
        }
        self.conn()?
            .execute(
                "INSERT INTO snoozed_messages(account_id,message_id,snoozed_until)
                 VALUES(?1,?2,?3)
                 ON CONFLICT(account_id,message_id) DO UPDATE SET snoozed_until=excluded.snoozed_until",
                params![account_id, message_id, until_iso],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn unsnooze_message(&self, account_id: &str, message_id: i64) -> Result<(), String> {
        let changed = self
            .conn()?
            .execute(
                "DELETE FROM snoozed_messages WHERE account_id=?1 AND message_id=?2",
                params![account_id, message_id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("That message is not snoozed.".into());
        }
        Ok(())
    }

    pub fn prune_expired_snoozes(&self, account_id: &str, now: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "DELETE FROM snoozed_messages WHERE account_id=?1 AND snoozed_until<=?2",
                params![account_id, now],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn list_filter_rules(&self, account_id: &str) -> Result<Vec<FilterRule>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id,account_id,name,field,contains,action,target_mailbox,enabled FROM filter_rules WHERE account_id=?1 ORDER BY position,id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok(FilterRule {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    name: row.get(2)?,
                    field: row.get(3)?,
                    contains: row.get(4)?,
                    action: row.get(5)?,
                    target_mailbox: row.get(6)?,
                    enabled: row.get::<_, i64>(7)? != 0,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub fn create_filter_rule(&self, rule: &FilterRule) -> Result<FilterRule, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let position: i64 = self
            .conn()?
            .query_row(
                "SELECT COALESCE(MAX(position),-1)+1 FROM filter_rules WHERE account_id=?1",
                [&rule.account_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        self.conn()?
            .execute(
                "INSERT INTO filter_rules(id,account_id,name,field,contains,action,target_mailbox,enabled,position)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    id,
                    rule.account_id,
                    rule.name.trim(),
                    rule.field,
                    rule.contains.trim(),
                    rule.action,
                    rule.target_mailbox,
                    i64::from(rule.enabled),
                    position,
                ],
            )
            .map_err(db_error)?;
        Ok(FilterRule {
            id,
            account_id: rule.account_id.clone(),
            name: rule.name.trim().to_string(),
            field: rule.field.clone(),
            contains: rule.contains.trim().to_string(),
            action: rule.action.clone(),
            target_mailbox: rule.target_mailbox.clone(),
            enabled: rule.enabled,
        })
    }

    pub fn update_filter_rule(&self, rule: &FilterRule) -> Result<FilterRule, String> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE filter_rules SET name=?3,field=?4,contains=?5,action=?6,target_mailbox=?7,enabled=?8 WHERE id=?1 AND account_id=?2",
                params![
                    rule.id,
                    rule.account_id,
                    rule.name.trim(),
                    rule.field,
                    rule.contains.trim(),
                    rule.action,
                    rule.target_mailbox,
                    i64::from(rule.enabled),
                ],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("That rule is no longer available.".into());
        }
        Ok(FilterRule {
            id: rule.id.clone(),
            account_id: rule.account_id.clone(),
            name: rule.name.trim().to_string(),
            field: rule.field.clone(),
            contains: rule.contains.trim().to_string(),
            action: rule.action.clone(),
            target_mailbox: rule.target_mailbox.clone(),
            enabled: rule.enabled,
        })
    }

    pub fn delete_filter_rule(&self, account_id: &str, id: &str) -> Result<(), String> {
        let changed = self
            .conn()?
            .execute(
                "DELETE FROM filter_rules WHERE id=?1 AND account_id=?2",
                params![id, account_id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("That rule is no longer available.".into());
        }
        Ok(())
    }

    /// Unread inbox candidates for one rule. Bounded so a broad match cannot
    /// flood the offline queue.
    pub fn find_rule_matches(
        &self,
        account_id: &str,
        rule: &FilterRule,
    ) -> Result<Vec<(i64, u32, String, i64)>, String> {
        let needle: String = rule
            .contains
            .trim()
            .to_ascii_lowercase()
            .chars()
            .flat_map(|character| match character {
                '\\' => vec!['\\', '\\'],
                '%' => vec!['\\', '%'],
                '_' => vec!['\\', '_'],
                other => vec![other],
            })
            .collect();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let column = match rule.field.as_str() {
            "subject" => "m.subject",
            _ => "(m.sender_name || ' ' || m.sender_address)",
        };
        let like = format!("%{needle}%");
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(&format!(
                "SELECT m.id,m.uid,f.name,f.id FROM messages m JOIN mailboxes f ON f.id=m.mailbox_id
                 WHERE m.account_id=?1 AND f.role='inbox' AND m.is_read=0 AND m.pending_move_to IS NULL
                 AND LOWER({column}) LIKE ?2 ESCAPE '\\' ORDER BY m.uid DESC LIMIT 100"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![account_id, like], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub fn list_snoozed(&self, account_id: &str, now: &str) -> Result<Vec<SnoozedSummary>, String> {
        self.prune_expired_snoozes(account_id, now)?;
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(&format!(
                "{} JOIN snoozed_messages s ON s.message_id=m.id AND s.account_id=m.account_id WHERE m.account_id=?1 ORDER BY s.snoozed_until ASC",
                MESSAGE_SUMMARY_SELECT.replace(
                    "FROM messages m",
                    ",s.snoozed_until FROM messages m"
                ),
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok(SnoozedSummary {
                    message: map_message_summary(row)?,
                    snoozed_until: row.get(16)?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub fn mark_outbox_attempt_started(&self, id: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE outbox SET state='sending',attempt_started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                [id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn prepare_queued_outbox(
        &self,
        id: &str,
        account_id: &str,
        message_id: &str,
        mime_bytes: &[u8],
    ) -> Result<(), String> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE outbox SET message_id=?3,mime_bytes=?4,updated_at=CURRENT_TIMESTAMP
                 WHERE id=?1 AND account_id=?2 AND state='queued'
                 AND (message_id IS NULL OR message_id='' OR mime_bytes IS NULL OR LENGTH(mime_bytes)=0)",
                params![id, account_id, message_id, mime_bytes],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("The queued message changed before it could be prepared.".into());
        }
        Ok(())
    }

    pub fn remove_outbox_for_account(&self, id: &str, account_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM attachment_refs WHERE owner_kind='outbox' AND owner_id=?1",
                [id],
            )
            .map_err(db_error)?;
        let changed = transaction
            .execute(
                "DELETE FROM outbox WHERE id=?1 AND account_id=?2",
                params![id, account_id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("Queued message not found.".into());
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn queue_operation<T: serde::Serialize>(
        &self,
        account_id: &str,
        kind: &str,
        payload: &T,
        dedupe_key: Option<&str>,
    ) -> Result<(), String> {
        let json = serde_json::to_string(payload)
            .map_err(|_| "Could not queue the offline change.".to_string())?;
        self.conn()?
            .execute(
                "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(account_id,dedupe_key) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,created_at=CURRENT_TIMESTAMP",
                params![account_id, kind, json, dedupe_key],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn queued_operations(
        &self,
        account_id: &str,
    ) -> Result<Vec<(i64, String, String)>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare("SELECT id,kind,payload FROM offline_ops WHERE account_id=?1 ORDER BY id")
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn remove_operation(&self, id: i64) -> Result<(), String> {
        self.conn()?
            .execute("DELETE FROM offline_ops WHERE id=?1", [id])
            .map_err(db_error)?;
        Ok(())
    }

    pub fn grant_file(
        &self,
        token: &str,
        account_id: &str,
        path: &Path,
        size: u64,
    ) -> Result<(), String> {
        self.account(account_id)?;
        self.conn()?.execute(
            "INSERT INTO file_grants(token,account_id,path,size,created_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)
             ON CONFLICT(token) DO UPDATE SET path=excluded.path,size=excluded.size",
            params![token, account_id, path.to_string_lossy(), size],
        ).map_err(db_error)?;
        Ok(())
    }

    pub fn resolve_file(
        &self,
        token: &str,
        account_id: &str,
    ) -> Result<std::path::PathBuf, String> {
        let path: Option<String> = self
            .conn()?
            .query_row(
                "SELECT path FROM file_grants WHERE token=?1 AND account_id=?2",
                params![token, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        path.map(Into::into)
            .ok_or_else(|| "The selected attachment permission has expired.".into())
    }

    pub fn unreferenced_files(
        &self,
        account_id: &str,
    ) -> Result<Vec<(String, std::path::PathBuf)>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT token,path FROM file_grants WHERE account_id=?1 AND token NOT IN (SELECT token FROM attachment_refs)",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    std::path::PathBuf::from(row.get::<_, String>(1)?),
                ))
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn expired_unreferenced_files(
        &self,
        account_id: &str,
    ) -> Result<Vec<(String, std::path::PathBuf)>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT token,path FROM file_grants WHERE account_id=?1
                 AND created_at < datetime('now','-1 day')
                 AND token NOT IN (SELECT token FROM attachment_refs)",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    std::path::PathBuf::from(row.get::<_, String>(1)?),
                ))
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn remove_file_grant(&self, token: &str, account_id: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "DELETE FROM file_grants WHERE token=?1 AND account_id=?2 AND token NOT IN (SELECT token FROM attachment_refs)",
                params![token, account_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn legacy_settings(&self) -> Result<AppSettings, String> {
        let json: Option<String> = self
            .conn()?
            .query_row("SELECT value FROM settings WHERE key='app'", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)?;
        json.map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "Saved application settings are damaged.".to_string())
        })
        .transpose()
        .map(|settings| settings.unwrap_or_default())
    }

    #[cfg(test)]
    pub fn set_legacy_settings_raw_for_test(&self, value: &str) {
        self.conn()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('app',?1)",
                [value],
            )
            .unwrap();
    }

    pub fn cache_usage(&self, max_bytes: u64) -> Result<CacheUsage, String> {
        let conn = self.conn()?;
        let (bytes, message_count): (u64, u64) = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(raw_message)),0), COALESCE(SUM(CASE WHEN LENGTH(raw_message) > 0 THEN 1 ELSE 0 END),0) FROM messages",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        Ok(CacheUsage {
            bytes,
            max_bytes,
            message_count,
        })
    }

    pub fn clear_downloaded_mail(&self) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute("UPDATE message_fts SET body=''", [])
            .map_err(db_error)?;
        transaction
            .execute(
                "UPDATE messages SET preview='',text_body='',html_body=NULL,raw_message=X''",
                [],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn evict_to_policy(&self, policy: &CachePolicy) -> Result<(), String> {
        if policy.is_unlimited() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        if policy.mode == "recent" && policy.days > 0 {
            let transaction = conn.transaction().map_err(db_error)?;
            let cutoff = format!("-{} days", policy.days);
            transaction
                .execute(
                    "UPDATE message_fts SET body='' WHERE message_id IN (
                    SELECT id FROM messages WHERE received_at < datetime('now', ?1)
                    AND LENGTH(raw_message) > 0
                 )",
                    [&cutoff],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE messages SET text_body='',html_body=NULL,raw_message=X''
                 WHERE received_at < datetime('now', ?1) AND LENGTH(raw_message) > 0",
                    [&cutoff],
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
        }
        if policy.max_bytes > 0 {
            loop {
                let bytes: u64 = conn
                    .query_row(
                        "SELECT COALESCE(SUM(LENGTH(raw_message)),0) FROM messages",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(db_error)?;
                if bytes <= policy.max_bytes {
                    break;
                }
                let ids = {
                    let mut statement = conn
                        .prepare(
                            "SELECT id FROM messages WHERE LENGTH(raw_message) > 0
                         ORDER BY accessed_at ASC LIMIT 25",
                        )
                        .map_err(db_error)?;
                    let ids = statement
                        .query_map([], |row| row.get::<_, i64>(0))
                        .map_err(db_error)?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(db_error)?;
                    ids
                };
                if ids.is_empty() {
                    break;
                }
                let transaction = conn.transaction().map_err(db_error)?;
                for id in ids {
                    transaction
                        .execute("UPDATE message_fts SET body='' WHERE message_id=?1", [id])
                        .map_err(db_error)?;
                    transaction.execute(
                        "UPDATE messages SET text_body='',html_body=NULL,raw_message=X'' WHERE id=?1",
                        [id],
                    ).map_err(db_error)?;
                }
                transaction.commit().map_err(db_error)?;
            }
        }
        Ok(())
    }
}

const MESSAGE_SUMMARY_SELECT: &str = "SELECT m.id,m.account_id,m.mailbox_id,m.uid,m.message_id,m.subject,m.sender_name,m.sender_address,m.recipients,m.received_at,m.preview,m.is_read,m.is_starred,m.has_attachments,m.size,m.thread_root FROM messages m";
const MESSAGE_DETAIL_SELECT: &str = "SELECT m.id,m.account_id,m.mailbox_id,m.uid,m.message_id,m.subject,m.sender_name,m.sender_address,m.recipients,m.received_at,m.preview,m.is_read,m.is_starred,m.has_attachments,m.size,m.to_json,m.cc_json,m.reply_to,m.text_body,m.html_body,m.attachments_json FROM messages m";

fn map_message_summary(row: &Row<'_>) -> rusqlite::Result<MessageSummary> {
    Ok(MessageSummary {
        id: row.get(0)?,
        account_id: row.get(1)?,
        mailbox_id: row.get(2)?,
        uid: row.get(3)?,
        message_id: row.get(4)?,
        subject: row.get(5)?,
        sender_name: row.get(6)?,
        sender_address: row.get(7)?,
        recipients: row.get(8)?,
        received_at: row.get(9)?,
        preview: row.get(10)?,
        is_read: row.get::<_, i32>(11)? != 0,
        is_starred: row.get::<_, i32>(12)? != 0,
        has_attachments: row.get::<_, i32>(13)? != 0,
        size: row.get(14)?,
        thread_root: row.get(15)?,
    })
}

fn parse_provider(value: &str) -> ProviderKind {
    if value == "icloud" {
        ProviderKind::Icloud
    } else {
        ProviderKind::Manual
    }
}
fn parse_tls(value: &str) -> TlsMode {
    if value == "startTls" {
        TlsMode::StartTls
    } else {
        TlsMode::Tls
    }
}
fn parse_role(value: &str) -> MailboxRole {
    match value {
        "inbox" => MailboxRole::Inbox,
        "sent" => MailboxRole::Sent,
        "drafts" => MailboxRole::Drafts,
        "archive" => MailboxRole::Archive,
        "trash" => MailboxRole::Trash,
        "junk" => MailboxRole::Junk,
        _ => MailboxRole::Other,
    }
}
fn json_or_default<T: serde::de::DeserializeOwned + Default>(value: String) -> T {
    serde_json::from_str(&value).unwrap_or_default()
}
fn has_remote_images(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    lower.contains("src=\"http:")
        || lower.contains("src='http:")
        || lower.contains("src=\"https:")
        || lower.contains("src='https:")
}
fn fts_query(value: &str) -> String {
    value
        .split_whitespace()
        .map(|term| {
            let cleaned = term.replace('*', "");
            cleaned
                .trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.' && c != '_')
                .to_string()
        })
        .filter(|term| term.chars().any(|c| c.is_alphanumeric()))
        .take(12)
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}
fn db_error(error: rusqlite::Error) -> String {
    #[cfg(test)]
    return format!("Postal Snap could not access its local mail database: {error}");
    #[cfg(not(test))]
    {
        let _ = error;
        "Postal Snap could not access its local mail database.".into()
    }
}

fn migrate_schema(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(db_error)?;
    let mut version: u32 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err("This mail database was created by a newer Postal Snap version.".into());
    }
    if version < 1 {
        transaction.execute_batch(SCHEMA_V1).map_err(db_error)?;
        ensure_column(
            &transaction,
            "mailboxes",
            "backfill_uid",
            "ALTER TABLE mailboxes ADD COLUMN backfill_uid INTEGER",
        )?;
        ensure_column(
            &transaction,
            "messages",
            "pending_move_to",
            "ALTER TABLE messages ADD COLUMN pending_move_to INTEGER",
        )?;
        transaction
            .pragma_update(None, "user_version", 1)
            .map_err(db_error)?;
        version = 1;
    }
    if version < 2 {
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
            ensure_column(&transaction, table, column, sql)?;
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
        version = 2;
    }
    if version < 3 {
        ensure_column(
            &transaction,
            "mailboxes",
            "local_total_delta",
            "ALTER TABLE mailboxes ADD COLUMN local_total_delta INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &transaction,
            "mailboxes",
            "local_unread_delta",
            "ALTER TABLE mailboxes ADD COLUMN local_unread_delta INTEGER NOT NULL DEFAULT 0",
        )?;
        transaction
            .pragma_update(None, "user_version", 3)
            .map_err(db_error)?;
        version = 3;
    }
    if version < 4 {
        ensure_column(
            &transaction,
            "accounts",
            "aliases_json",
            "ALTER TABLE accounts ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(
            &transaction,
            "drafts",
            "sender_email",
            "ALTER TABLE drafts ADD COLUMN sender_email TEXT",
        )?;
        transaction
            .pragma_update(None, "user_version", 4)
            .map_err(db_error)?;
        version = 4;
    }
    if version < 5 {
        ensure_column(
            &transaction,
            "accounts",
            "auth_method",
            "ALTER TABLE accounts ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'",
        )?;
        transaction
            .pragma_update(None, "user_version", 5)
            .map_err(db_error)?;
        version = 5;
    }
    if version < 6 {
        // Drop storage that was created but never used: the inline-image blob
        // cache, the untouched protected-messages list, and the draft sender
        // column whose value always came from draft JSON instead.
        transaction
            .execute("DROP TABLE IF EXISTS attachment_blobs", [])
            .map_err(db_error)?;
        transaction
            .execute("DROP TABLE IF EXISTS protected_messages", [])
            .map_err(db_error)?;
        if column_exists(&transaction, "drafts", "sender_email")? {
            transaction
                .execute("ALTER TABLE drafts DROP COLUMN sender_email", [])
                .map_err(db_error)?;
        }
        transaction
            .execute(
                "UPDATE offline_ops SET dedupe_key='' WHERE dedupe_key IS NULL",
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
        version = 6;
    }
    if version < 7 {
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
        version = 7;
    }
    if version < 8 {
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
            ensure_column(&transaction, table, column, sql)?;
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
        version = 8;
    }
    if version < 9 {
        ensure_column(
            &transaction,
            "accounts",
            "signature",
            "ALTER TABLE accounts ADD COLUMN signature TEXT NOT NULL DEFAULT ''",
        )?;
        transaction
            .pragma_update(None, "user_version", 9)
            .map_err(db_error)?;
        version = 9;
    }
    if version < 10 {
        ensure_column(
            &transaction,
            "outbox",
            "send_at",
            "ALTER TABLE outbox ADD COLUMN send_at TEXT",
        )?;
        transaction
            .pragma_update(None, "user_version", 10)
            .map_err(db_error)?;
        version = 10;
    }
    if version < 11 {
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
        version = 11;
    }
    if version < 12 {
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
    }
    transaction
        .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    sql: &str,
) -> Result<(), String> {
    if !column_exists(connection, table, column)? {
        connection.execute(sql, []).map_err(db_error)?;
    }
    Ok(())
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(db_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(columns.iter().any(|existing| existing == column))
}

pub(crate) fn synthetic_thread_id(mailbox_id: i64, uid: u32) -> String {
    format!("<uid-{mailbox_id}-{uid}@local>")
}

/// Best-effort thread root at insert time from currently cached rows.
/// [`Database::repair_thread_roots`] corrects it once more of the thread
/// has synced.
fn provisional_thread_root(
    transaction: &rusqlite::Transaction,
    account_id: &str,
    mailbox_id: i64,
    message: &CachedMessage,
) -> Result<(Option<String>, String), String> {
    let own = message
        .message_id
        .clone()
        .unwrap_or_else(|| synthetic_thread_id(mailbox_id, message.uid));
    let root = match &message.thread_parent {
        Some(parent) => transaction
            .query_row(
                "SELECT COALESCE(thread_root, message_id, ?3) FROM messages WHERE account_id=?1 AND message_id=?2 LIMIT 1",
                params![account_id, parent, parent],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(db_error)?
            .flatten()
            .unwrap_or_else(|| parent.clone()),
        None => own.clone(),
    };
    Ok((message.thread_parent.clone(), root))
}

fn replace_attachment_refs(
    connection: &Connection,
    account_id: &str,
    owner_kind: &str,
    owner_id: &str,
    attachments: &[crate::models::ComposeAttachment],
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM attachment_refs WHERE owner_kind=?1 AND owner_id=?2",
            params![owner_kind, owner_id],
        )
        .map_err(db_error)?;
    for attachment in attachments {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM file_grants WHERE token=?1 AND account_id=?2)",
                params![attachment.token, account_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("A selected attachment is unavailable.".into());
        }
        connection
            .execute(
                "INSERT INTO attachment_refs(token,owner_kind,owner_id) VALUES(?1,?2,?3)",
                params![attachment.token, owner_kind, owner_id],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

fn adjust_mailbox_counts(
    connection: &Connection,
    mailbox_id: i64,
    total_delta: i32,
    unread_delta: Option<i32>,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE mailboxes SET
             local_total_delta=local_total_delta + ?2,
             local_unread_delta=local_unread_delta + COALESCE(?3,0)
             WHERE id=?1",
            params![mailbox_id, total_delta, unread_delta],
        )
        .map_err(db_error)?;
    Ok(())
}

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'idle', error TEXT,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_tls TEXT NOT NULL, imap_username TEXT NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_tls TEXT NOT NULL, smtp_username TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'other',
  uid_validity INTEGER, uid_next INTEGER, backfill_uid INTEGER, UNIQUE(account_id,name)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, uid INTEGER NOT NULL,
  message_id TEXT, subject TEXT NOT NULL DEFAULT '', sender_name TEXT NOT NULL DEFAULT '', sender_address TEXT NOT NULL DEFAULT '',
  recipients TEXT NOT NULL DEFAULT '', received_at TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0, to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', reply_to TEXT,
  text_body TEXT NOT NULL DEFAULT '', html_body TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', raw_message BLOB NOT NULL DEFAULT X'',
  accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, pending_move_to INTEGER, thread_parent TEXT, thread_root TEXT, UNIQUE(mailbox_id,uid)
);
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(message_id UNINDEXED, subject, sender, recipients, body, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, draft_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recipient_history (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, address TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', use_count INTEGER NOT NULL DEFAULT 0, last_used TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(account_id, address));
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, draft_json TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, send_at TEXT);
CREATE TABLE IF NOT EXISTS offline_ops (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS snoozed_messages (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, snoozed_until TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(account_id, message_id));
CREATE INDEX IF NOT EXISTS snoozed_messages_due ON snoozed_messages(account_id,snoozed_until);
CREATE TABLE IF NOT EXISTS filter_rules (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', field TEXT NOT NULL DEFAULT 'from', contains TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT 'mark_read', target_mailbox TEXT, enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS filter_rules_account ON filter_rules(account_id,position);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS file_grants (token TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS messages_mailbox_date ON messages(mailbox_id,received_at DESC);
CREATE INDEX IF NOT EXISTS messages_mailbox_date_uid ON messages(mailbox_id,received_at DESC,uid DESC);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id,thread_root);
CREATE INDEX IF NOT EXISTS messages_account ON messages(account_id);
CREATE TRIGGER IF NOT EXISTS messages_after_delete AFTER DELETE ON messages BEGIN DELETE FROM message_fts WHERE message_id=OLD.id; END;
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> AccountRecord {
        AccountRecord {
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
        }
    }

    fn account_with_id(id: &str, email: &str) -> AccountRecord {
        let mut value = account();
        value.summary.id = id.into();
        value.summary.email = email.into();
        value.summary.display_name = email.into();
        value.imap.username = email.into();
        value.smtp.username = email.into();
        value
    }

    fn message(uid: u32, received_at: &str) -> CachedMessage {
        CachedMessage {
            uid,
            message_id: Some(format!("<{uid}@example.com>")),
            subject: "Family picnic".into(),
            sender_name: "Jane".into(),
            sender_address: "jane@example.com".into(),
            recipients: "sam@example.com".into(),
            received_at: received_at.into(),
            preview: "Bring sandwiches".into(),
            is_read: false,
            is_starred: false,
            size: 32,
            to: vec!["sam@example.com".into()],
            cc: vec![],
            reply_to: None,
            thread_parent: None,
            text_body: "Bring sandwiches".into(),
            html_body: None,
            attachments: vec![],
            raw_message: b"Subject: Family picnic\r\n\r\nBring sandwiches".to_vec(),
        }
    }

    fn draft(account_id: &str) -> ComposeDraft {
        ComposeDraft {
            id: None,
            account_id: account_id.into(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Family update".into(),
            html_body: "<p>Hello</p>".into(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
        }
    }

    fn mailbox(db: &Database, account_id: &str, name: &str, role: &MailboxRole) -> i64 {
        db.upsert_mailbox(account_id, name, role, Some(1), Some(2), Some(0), 0)
            .unwrap()
    }

    #[test]
    fn settings_have_safe_recent_defaults() {
        let db = Database::memory();
        let settings = db.legacy_settings().unwrap();
        assert_eq!(settings.cache_policy.days, 90);
        assert_eq!(settings.cache_policy.max_bytes, 1_073_741_824);
    }

    #[test]
    fn damaged_legacy_settings_are_reported_instead_of_defaulted() {
        let db = Database::memory();
        db.conn()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES('app','not-json')",
                [],
            )
            .unwrap();

        assert_eq!(
            db.legacy_settings().unwrap_err(),
            "Saved application settings are damaged."
        );
    }

    #[test]
    fn fts_terms_are_quoted_and_bounded() {
        assert_eq!(fts_query("hello world"), "\"hello\"* AND \"world\"*");
        assert!(fts_query("").is_empty());
        assert_eq!(fts_query("::: ... ???"), "");
        assert_eq!(fts_query("user@example.com"), "\"user@example.com\"*");
        assert_eq!(fts_query("foo*bar a**b"), "\"foobar\"* AND \"ab\"*");
    }

    #[test]
    fn uidvalidity_change_resets_messages_and_backfill() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        db.set_backfill_cursor(mailbox, 40).unwrap();

        db.upsert_mailbox(
            &account.summary.id,
            "INBOX",
            &MailboxRole::Inbox,
            Some(2),
            Some(1),
            Some(0),
            0,
        )
        .unwrap();

        assert_eq!(db.max_uid(mailbox).unwrap(), 0);
        assert_eq!(db.backfill_cursor(mailbox).unwrap(), None);
    }

    #[test]
    fn mailbox_sync_state_reports_counts_for_skip_decision() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        db.upsert_mailbox(
            &account.summary.id,
            "INBOX",
            &MailboxRole::Inbox,
            Some(11),
            Some(100),
            Some(3),
            7,
        )
        .unwrap();
        assert_eq!(
            db.mailbox_sync_state(&account.summary.id, "INBOX").unwrap(),
            Some((Some(11), Some(100), 7, Some(3)))
        );
    }

    #[test]
    fn bulk_flag_updates_keep_unread_deltas_accurate() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(2, "2026-08-18T13:00:00Z"),
        )
        .unwrap();
        let unread = db.unread_message_ids(mailbox).unwrap();
        assert_eq!(unread.len(), 2);
        let ids: Vec<i64> = unread.iter().map(|(id, _)| *id).collect();
        db.set_flags_bulk(&ids, Some(true), None).unwrap();
        assert!(db.unread_message_ids(mailbox).unwrap().is_empty());
        db.set_flags_bulk(&[ids[0]], Some(false), Some(true))
            .unwrap();
        let unread = db.unread_message_ids(mailbox).unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].0, ids[0]);
    }

    #[test]
    fn newer_local_skip_still_tracks_server_uid() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let draft = draft(&account.summary.id);
        let id = db.save_draft(&draft).unwrap();
        db.update_remote_draft_tracking(&id, &account.summary.id, "Drafts", 77, Some(9), None)
            .unwrap();
        let known = db
            .remote_draft_uids(&account.summary.id, "Drafts", Some(9))
            .unwrap();
        assert!(known.contains(&77));
    }

    #[test]
    fn rename_mailbox_local_moves_draft_tracking() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        mailbox(&db, &account.summary.id, "Receipts", &MailboxRole::Other);
        let draft = draft(&account.summary.id);
        let id = db.save_draft(&draft).unwrap();
        db.update_remote_draft_tracking(&id, &account.summary.id, "Receipts", 12, Some(4), None)
            .unwrap();
        db.rename_mailbox_local(&account.summary.id, "Receipts", "Bills")
            .unwrap();
        let names = db
            .list_mailboxes(&account.summary.id)
            .unwrap()
            .into_iter()
            .map(|mailbox| mailbox.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"Bills".to_string()));
        let known = db
            .remote_draft_uids(&account.summary.id, "Bills", Some(4))
            .unwrap();
        assert!(known.contains(&12));
        assert!(db
            .rename_mailbox_local(&account.summary.id, "Missing", "Bills")
            .is_err());
    }

    #[test]
    fn delete_pending_drafts_stay_visible_for_retry() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mut draft = draft(&account.summary.id);
        draft.to = vec!["jane@example.com".into()];
        let id = db.save_draft(&draft).unwrap();
        db.conn()
            .unwrap()
            .execute(
                "UPDATE drafts SET remote_uid=5, sync_state='deletePending', deleted_at=CURRENT_TIMESTAMP WHERE id=?1",
                [id.clone()],
            )
            .unwrap();
        let listed = db.list_drafts(&account.summary.id).unwrap();
        assert!(listed.iter().any(|item| item.id == id));
        assert!(db.draft(&id, &account.summary.id).is_ok());
    }

    #[test]
    fn cursor_pagination_clamps_zero_limit_without_panicking() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let page = db.list_messages(mailbox, None, 0).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn folder_reconciliation_removes_only_missing_account_mailboxes() {
        let db = Database::memory();
        let first = account_with_id("account-1", "sam@example.com");
        let second = account_with_id("account-2", "jane@example.com");
        db.insert_account(&first).unwrap();
        db.insert_account(&second).unwrap();
        mailbox(&db, &first.summary.id, "INBOX", &MailboxRole::Inbox);
        mailbox(&db, &first.summary.id, "Old Folder", &MailboxRole::Other);
        mailbox(&db, &second.summary.id, "Old Folder", &MailboxRole::Other);

        db.reconcile_mailboxes(
            &first.summary.id,
            &["INBOX".to_string()].into_iter().collect(),
        )
        .unwrap();

        let first_names = db
            .list_mailboxes(&first.summary.id)
            .unwrap()
            .into_iter()
            .map(|mailbox| mailbox.name)
            .collect::<Vec<_>>();
        assert_eq!(first_names, vec!["INBOX"]);
        assert_eq!(db.list_mailboxes(&second.summary.id).unwrap().len(), 1);
    }

    #[test]
    fn search_indexes_cached_body_and_offline_ops_are_ordered() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let found = db
            .search(&SearchQuery {
                account_id: account.summary.id.clone(),
                mailbox_id: Some(mailbox),
                text: "sandwich".into(),
                all_folders: false,
                limit: 10,
            })
            .unwrap();
        assert_eq!(found.len(), 1);

        db.queue_operation(
            &account.summary.id,
            "flags",
            &serde_json::json!({ "uid": 1 }),
            Some("flags:inbox:1"),
        )
        .unwrap();
        assert_eq!(db.queued_operations(&account.summary.id).unwrap().len(), 1);
    }

    #[test]
    fn recent_policy_evicts_old_mail() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(1, "2000-01-01T00:00:00Z"),
        )
        .unwrap();
        db.evict_to_policy(&CachePolicy::default()).unwrap();
        let messages = db.list_messages(mailbox, None, 10).unwrap();
        assert_eq!(messages.items.len(), 1);
        assert!(!db
            .message_content_cached(messages.items[0].id, &account.summary.id)
            .unwrap());
    }

    #[test]
    fn recipient_history_ranks_reuse_and_matches_prefix() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        assert!(db
            .suggest_recipients(&account.summary.id, "ja", 8)
            .unwrap()
            .is_empty());
        assert!(db
            .suggest_recipients(&account.summary.id, "  ", 8)
            .unwrap()
            .is_empty());
        db.record_recipients(
            &account.summary.id,
            &[
                ("jane@example.com".into(), "Jane".into()),
                ("sam@example.com".into(), "".into()),
                ("not-an-address".into(), "".into()),
            ],
        )
        .unwrap();
        db.record_recipients(
            &account.summary.id,
            &[("jane@example.com".into(), "Jane Doe".into())],
        )
        .unwrap();
        let ranked = db.suggest_recipients(&account.summary.id, "ja", 8).unwrap();
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].address, "jane@example.com");
        assert_eq!(ranked[0].name, "Jane Doe");
        assert_eq!(ranked[0].use_count, 2);
        let by_name = db
            .suggest_recipients(&account.summary.id, "doe", 8)
            .unwrap();
        assert_eq!(by_name.len(), 1);
        // LIKE wildcards in the prefix match literally, not as patterns.
        assert!(db
            .suggest_recipients(&account.summary.id, "%", 8)
            .unwrap()
            .is_empty());
        assert!(db
            .suggest_recipients(&account.summary.id, "_", 8)
            .unwrap()
            .is_empty());
        // Other accounts never see these recipients.
        let other = account_with_id("account-2", "jane@example.com");
        db.insert_account(&other).unwrap();
        assert!(db
            .suggest_recipients(&other.summary.id, "ja", 8)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn thread_roots_converge_regardless_of_arrival_order() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        // Grandchild, child, then parent: every provisional root is wrong
        // until the ancestors arrive.
        let mut grandchild = message(3, "2026-08-18T14:00:00Z");
        grandchild.thread_parent = Some("<2@example.com>".into());
        db.upsert_envelope(&account.summary.id, mailbox, &grandchild)
            .unwrap();
        db.repair_thread_roots(&account.summary.id, &["<3@example.com>".into()])
            .unwrap();
        let mut child = message(2, "2026-08-18T13:00:00Z");
        child.thread_parent = Some("<1@example.com>".into());
        db.upsert_envelope(&account.summary.id, mailbox, &child)
            .unwrap();
        db.repair_thread_roots(&account.summary.id, &["<2@example.com>".into()])
            .unwrap();
        let parent = message(1, "2026-08-18T12:00:00Z");
        db.upsert_envelope(&account.summary.id, mailbox, &parent)
            .unwrap();
        db.repair_thread_roots(&account.summary.id, &["<1@example.com>".into()])
            .unwrap();
        let items = db.list_messages(mailbox, None, 10).unwrap().items;
        assert_eq!(items.len(), 3);
        assert!(
            items
                .iter()
                .all(|item| item.thread_root.as_deref() == Some("<1@example.com>")),
            "{items:?}"
        );
    }
    #[test]
    fn clearing_downloads_preserves_envelopes_and_subject_search() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let id = db.list_messages(mailbox, None, 10).unwrap().items[0].id;
        db.clear_downloaded_mail().unwrap();
        assert_eq!(db.list_messages(mailbox, None, 10).unwrap().items.len(), 1);
        assert!(!db.message_content_cached(id, &account.summary.id).unwrap());
        assert_eq!(
            db.search(&SearchQuery {
                account_id: account.summary.id,
                mailbox_id: Some(mailbox),
                text: "picnic".into(),
                all_folders: false,
                limit: 10,
            })
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn message_detail_reads_payload_columns_and_scopes_account() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut cached = message(1, "2026-08-18T12:00:00Z");
        cached.cc = vec!["family@example.com".into()];
        cached.reply_to = Some("reply@example.com".into());
        cached.html_body =
            Some(r#"<p>Bring sandwiches</p><img src="https://images.example.com/pic.png">"#.into());
        cached.attachments = vec![Attachment {
            id: "part-1".into(),
            filename: "pic.png".into(),
            content_type: "image/png".into(),
            size: 12,
            content_id: None,
            inline: false,
        }];
        db.upsert_message(&account.summary.id, mailbox, &cached)
            .unwrap();
        let id = db.list_messages(mailbox, None, 10).unwrap().items[0].id;

        let detail = db.message_detail(id, &account.summary.id).unwrap();
        assert_eq!(detail.to, vec!["sam@example.com"]);
        assert_eq!(detail.cc, vec!["family@example.com"]);
        assert_eq!(detail.reply_to.as_deref(), Some("reply@example.com"));
        assert_eq!(detail.html_body.as_deref(), cached.html_body.as_deref());
        assert!(detail.remote_images_blocked);
        assert_eq!(detail.attachments.len(), 1);
        assert_eq!(detail.attachments[0].id, "part-1");
        assert!(db.message_detail(id, "other-account").is_err());
    }

    #[test]
    fn migrates_v6_drops_dead_storage_and_indexes_pagination() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            let account = account();
            db.insert_account(&account).unwrap();
            db.conn()
                .unwrap()
                .execute_batch(
                    "CREATE TABLE attachment_blobs (message_id INTEGER, attachment_id TEXT, bytes BLOB, PRIMARY KEY(message_id,attachment_id));
                     CREATE TABLE protected_messages (message_id INTEGER PRIMARY KEY);
                     INSERT INTO offline_ops(account_id,kind,payload,dedupe_key) VALUES('account-1','flags','{}',NULL);
                     PRAGMA user_version=5;",
                )
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        let tables: Vec<String> = migrated
            .conn()
            .unwrap()
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('attachment_blobs','protected_messages')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(tables.is_empty());
        let nulls: i64 = migrated
            .conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM offline_ops WHERE dedupe_key IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(nulls, 0);
        let version: u32 = migrated
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migrates_v8_accounts_with_empty_signature() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            let account = account();
            db.insert_account(&account).unwrap();
        }
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "ALTER TABLE accounts DROP COLUMN signature;
                     PRAGMA user_version=8;",
                )
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        let listed = migrated.list_accounts().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].signature, "");
        let version: u32 = migrated
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn account_signatures_validate_and_round_trip() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        db.update_account_signature(&account.summary.id, "")
            .unwrap();
        assert_eq!(
            db.account(&account.summary.id).unwrap().summary.signature,
            ""
        );
        db.update_account_signature(&account.summary.id, "  Best,\nSam  ")
            .unwrap();
        assert_eq!(
            db.account(&account.summary.id).unwrap().summary.signature,
            "Best,\nSam"
        );
        assert!(db
            .update_account_signature(&account.summary.id, &"x".repeat(2001))
            .is_err());
        assert!(db
            .update_account_signature(&account.summary.id, "bad\x00sig")
            .is_err());
        assert!(db.update_account_signature("missing", "Hi").is_err());
    }

    #[test]
    fn interrupted_sends_need_attention_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        let account = account();
        let (attempted_id, queued_id) = {
            let db = Database::open(&path).unwrap();
            db.insert_account(&account).unwrap();
            let attempted = db
                .queue_outbox(
                    &draft(&account.summary.id),
                    "sending",
                    None,
                    "<stable@example.com>",
                    b"Subject: test\r\n\r\nbody",
                    None,
                )
                .unwrap();
            let queued = db
                .queue_outbox(
                    &draft(&account.summary.id),
                    "queued",
                    None,
                    "<never-attempted@example.com>",
                    b"Subject: queued\r\n\r\nbody",
                    None,
                )
                .unwrap();
            (attempted, queued)
        };
        let reopened = Database::open(&path).unwrap();
        let (_, attempted_state) = reopened.outbox(&attempted_id, &account.summary.id).unwrap();
        let (_, queued_state) = reopened.outbox(&queued_id, &account.summary.id).unwrap();
        assert_eq!(attempted_state, "needs_attention");
        assert_eq!(queued_state, "queued");
    }

    #[test]
    fn repairs_only_never_attempted_outbox_payloads() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let queued = db
            .queue_outbox(&draft(&account.summary.id), "queued", None, "", b"", None)
            .unwrap();
        db.prepare_queued_outbox(
            &queued,
            &account.summary.id,
            "<stable@example.com>",
            b"Subject: repaired\r\n\r\nbody",
        )
        .unwrap();
        let (_, state, message_id, mime) =
            db.outbox_delivery(&queued, &account.summary.id).unwrap();
        assert_eq!(state, "queued");
        assert_eq!(message_id, "<stable@example.com>");
        assert!(!mime.is_empty());

        let uncertain = db
            .queue_outbox(
                &draft(&account.summary.id),
                "needs_attention",
                None,
                "",
                b"",
                None,
            )
            .unwrap();
        assert!(db
            .prepare_queued_outbox(
                &uncertain,
                &account.summary.id,
                "<must-not-send@example.com>",
                b"Subject: unsafe\r\n\r\nbody",
            )
            .is_err());
    }

    #[test]
    fn scheduled_outbox_reports_only_due_messages() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let past = db
            .queue_outbox(
                &draft(&account.summary.id),
                "scheduled",
                None,
                "",
                b"",
                Some("2000-01-01T00:00:00Z"),
            )
            .unwrap();
        let future = db
            .queue_outbox(
                &draft(&account.summary.id),
                "scheduled",
                None,
                "",
                b"",
                Some("2999-01-01T00:00:00Z"),
            )
            .unwrap();
        let listed = db.list_outbox(&account.summary.id).unwrap();
        assert!(listed.iter().any(|item| item.id == past
            && item.state == "scheduled"
            && item.send_at.as_deref() == Some("2000-01-01T00:00:00Z")));
        let due = db
            .scheduled_due_outbox_ids(&account.summary.id, "2026-01-01T00:00:00Z")
            .unwrap();
        assert_eq!(due, vec![past]);
        assert!(!due.contains(&future));
    }

    #[test]
    fn snoozed_messages_hide_until_due_then_return() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let id = db.list_messages(mailbox, None, 10).unwrap().items[0].id;
        assert!(db
            .snooze_message("other-account", id, "2999-01-01T00:00:00+00:00")
            .is_err());
        db.snooze_message(&account.summary.id, id, "2999-01-01T00:00:00+00:00")
            .unwrap();
        assert!(db
            .list_messages(mailbox, None, 10)
            .unwrap()
            .items
            .is_empty());
        let snoozed = db
            .list_snoozed(&account.summary.id, "2026-01-01T00:00:00+00:00")
            .unwrap();
        assert_eq!(snoozed.len(), 1);
        assert_eq!(snoozed[0].message.id, id);
        // Expiry returns the message to its mailbox.
        let back = db
            .list_snoozed(&account.summary.id, "3000-01-01T00:00:00+00:00")
            .unwrap();
        assert!(back.is_empty());
        assert_eq!(db.list_messages(mailbox, None, 10).unwrap().items.len(), 1);
        assert!(db.unsnooze_message(&account.summary.id, id).is_err());
    }

    fn filter_rule(account_id: &str) -> FilterRule {
        FilterRule {
            id: String::new(),
            account_id: account_id.into(),
            name: "Power bills".into(),
            field: "from".into(),
            contains: "power".into(),
            action: "mark_read".into(),
            target_mailbox: None,
            enabled: true,
        }
    }

    #[test]
    fn filter_rules_match_unread_inbox_case_insensitively() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut bill = message(1, "2026-08-18T12:00:00Z");
        bill.sender_address = "bills@power.example.com".into();
        bill.sender_name = "Power Co".into();
        db.upsert_message(&account.summary.id, inbox, &bill)
            .unwrap();
        let family = message(2, "2026-08-18T13:00:00Z");
        db.upsert_message(&account.summary.id, inbox, &family)
            .unwrap();
        // Read mail never matches.
        let read_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.set_flags(read_id, Some(true), None).unwrap();

        let rule = filter_rule(&account.summary.id);
        let matches = db.find_rule_matches(&account.summary.id, &rule).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].1, 1);

        let mut subject_rule = filter_rule(&account.summary.id);
        subject_rule.field = "subject".into();
        subject_rule.contains = "PICNIC".into();
        let subject_matches = db
            .find_rule_matches(&account.summary.id, &subject_rule)
            .unwrap();
        assert_eq!(subject_matches.len(), 1);

        // LIKE metacharacters match literally.
        let mut wild = filter_rule(&account.summary.id);
        wild.contains = "%".into();
        assert!(db
            .find_rule_matches(&account.summary.id, &wild)
            .unwrap()
            .is_empty());

        // CRUD round trip.
        let created = db.create_filter_rule(&rule).unwrap();
        assert!(!created.id.is_empty());
        assert_eq!(db.list_filter_rules(&account.summary.id).unwrap().len(), 1);
        let mut updated = created.clone();
        updated.enabled = false;
        db.update_filter_rule(&updated).unwrap();
        assert!(!db.list_filter_rules(&account.summary.id).unwrap()[0].enabled);
        db.delete_filter_rule(&account.summary.id, &created.id)
            .unwrap();
        assert!(db
            .list_filter_rules(&account.summary.id)
            .unwrap()
            .is_empty());
        assert!(db
            .delete_filter_rule(&account.summary.id, &created.id)
            .is_err());
    }

    #[test]
    fn pending_moves_hide_without_reusing_destination_uids() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, &account.summary.id, "Archive", &MailboxRole::Archive);
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.mark_pending_move(id, archive).unwrap();
        assert!(db.list_messages(inbox, None, 10).unwrap().items.is_empty());
        assert!(db
            .list_messages(archive, None, 10)
            .unwrap()
            .items
            .is_empty());
        db.clear_pending_move(id).unwrap();
        assert_eq!(db.list_messages(inbox, None, 10).unwrap().items.len(), 1);
    }

    #[test]
    fn migrates_v1_data_transactionally() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(SCHEMA_V1).unwrap();
            connection.pragma_update(None, "user_version", 1).unwrap();
            connection
                .execute(
                    "INSERT INTO accounts(id,provider,email,display_name,imap_host,imap_port,imap_tls,imap_username,smtp_host,smtp_port,smtp_tls,smtp_username)
                     VALUES('account-1','manual','sam@example.com','Sam','imap.example.com',993,'tls','sam@example.com','smtp.example.com',587,'startTls','sam@example.com')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO offline_ops(account_id,kind,payload) VALUES('account-1','flags','{}')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO drafts(id,account_id,draft_json) VALUES('draft-legacy','account-1',?1)",
                    [r#"{"id":"draft-legacy","accountId":"account-1","to":[],"cc":[],"bcc":[],"subject":"Family update","htmlBody":"","textBody":"","attachments":[{"token":"draft-file","filename":"family.pdf","contentType":"application/pdf","inline":false,"contentId":null}]}"#],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO outbox(id,account_id,draft_json,state) VALUES('outbox-legacy','account-1',?1,'queued')",
                    [r#"{"accountId":"account-1","to":["jane@example.com"],"cc":[],"bcc":[],"subject":"Queued note","htmlBody":"","textBody":"","attachments":[{"token":"outbox-file","filename":"note.txt","contentType":"text/plain","inline":false,"contentId":null}]}"#],
                )
                .unwrap();
            connection
                .execute_batch(
                    "INSERT INTO file_grants(token,path) VALUES('orphan','/unsafe/orphan');
                     INSERT INTO file_grants(token,path) VALUES('draft-file','/private/draft-file');
                     INSERT INTO file_grants(token,path) VALUES('outbox-file','/private/outbox-file');",
                )
                .unwrap();
        }

        let db = Database::open(&path).unwrap();
        assert_eq!(db.list_accounts().unwrap().len(), 1);
        assert_eq!(db.queued_operations("account-1").unwrap().len(), 1);
        let conn = db.conn().unwrap();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM file_grants", [], |row| row
                .get::<_, u32>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM attachment_refs", [], |row| row
                .get::<_, u32>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT account_id FROM file_grants WHERE token='draft-file'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "account-1"
        );
        assert!(conn
            .prepare("SELECT sync_state,remote_uid FROM drafts")
            .is_ok());
    }

    #[test]
    fn migrates_v2_folder_counts_without_losing_authoritative_values() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            let account = account();
            db.insert_account(&account).unwrap();
            db.upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(8),
                Some(12),
                Some(4),
                11,
            )
            .unwrap();
        }
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "ALTER TABLE mailboxes DROP COLUMN local_total_delta;
                     ALTER TABLE mailboxes DROP COLUMN local_unread_delta;
                     PRAGMA user_version=2;",
                )
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        let inbox = migrated.list_mailboxes("account-1").unwrap().remove(0);
        assert_eq!((inbox.total_count, inbox.unread_count), (11, 4));
        let version: u32 = migrated
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migrates_v4_accounts_with_password_auth_default() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            let account = account();
            db.insert_account(&account).unwrap();
        }
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "ALTER TABLE accounts DROP COLUMN auth_method;
                     PRAGMA user_version=4;",
                )
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        let listed = migrated.list_accounts().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].auth_method, "password");
        assert_eq!(
            migrated.account("account-1").unwrap().summary.auth_method,
            "password"
        );
        let version: u32 = migrated
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn cursor_pagination_is_stable_for_equal_dates() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        for uid in 1..=5 {
            db.upsert_message(
                &account.summary.id,
                mailbox,
                &message(uid, "2026-08-18T12:00:00Z"),
            )
            .unwrap();
        }

        let first = db.list_messages(mailbox, None, 2).unwrap();
        assert_eq!(
            first.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            [5, 4]
        );
        assert!(first.has_more);
        let second = db
            .list_messages(mailbox, first.next_cursor.as_ref(), 2)
            .unwrap();
        assert_eq!(
            second.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            [3, 2]
        );
        let third = db
            .list_messages(mailbox, second.next_cursor.as_ref(), 2)
            .unwrap();
        assert_eq!(
            third.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            [1]
        );
        assert!(!third.has_more);
    }

    #[test]
    fn reconciliation_covers_more_than_five_hundred_cached_uids() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        for uid in 1..=650 {
            db.upsert_message(
                &account.summary.id,
                mailbox,
                &message(uid, "2026-08-18T12:00:00Z"),
            )
            .unwrap();
        }
        let cached = db.cached_uids(mailbox).unwrap();
        assert_eq!(cached.len(), 650);
        for chunk in cached.chunks(250) {
            let seen = chunk
                .iter()
                .filter(|uid| **uid != 625)
                .map(|uid| (*uid, true, false))
                .collect::<Vec<_>>();
            db.reconcile_flags(mailbox, &seen, chunk).unwrap();
        }
        let remaining = db.cached_uids(mailbox).unwrap();
        assert_eq!(remaining.len(), 649);
        assert!(!remaining.contains(&625));
    }

    #[test]
    fn authoritative_counts_and_pending_moves_update_immediately() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(43),
                Some(7),
                42,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account.summary.id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(4),
                Some(1),
                3,
            )
            .unwrap();
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.set_flags(id, Some(true), None).unwrap();
        db.mark_pending_move(id, archive).unwrap();
        db.mark_pending_move(id, archive).unwrap();
        let boxes = db.list_mailboxes(&account.summary.id).unwrap();
        let inbox_counts = boxes.iter().find(|item| item.id == inbox).unwrap();
        let archive_counts = boxes.iter().find(|item| item.id == archive).unwrap();
        assert_eq!(
            (inbox_counts.total_count, inbox_counts.unread_count),
            (41, 6)
        );
        assert_eq!(
            (archive_counts.total_count, archive_counts.unread_count),
            (4, 1)
        );
        let conn = db.conn().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT server_total,server_unread FROM mailboxes WHERE id=?1",
                [inbox],
                |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)),
            )
            .unwrap(),
            (42, 7)
        );
        assert_eq!(
            conn.query_row(
                "SELECT server_total,server_unread FROM mailboxes WHERE id=?1",
                [archive],
                |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)),
            )
            .unwrap(),
            (3, 1)
        );
    }

    #[test]
    fn offline_operations_dedupe_and_account_deletion_cascades() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        db.queue_operation(
            &account.summary.id,
            "flags",
            &serde_json::json!({ "isRead": true }),
            Some("flags:1:read"),
        )
        .unwrap();
        db.queue_operation(
            &account.summary.id,
            "flags",
            &serde_json::json!({ "isRead": false }),
            Some("flags:1:read"),
        )
        .unwrap();
        assert_eq!(db.queued_operations(&account.summary.id).unwrap().len(), 1);

        let path = std::path::Path::new("/private/managed-token");
        db.grant_file("token-1", &account.summary.id, path, 4)
            .unwrap();
        let mut draft = draft(&account.summary.id);
        draft.attachments.push(crate::models::ComposeAttachment {
            token: "token-1".into(),
            filename: "safe.txt".into(),
            content_type: Some("text/plain".into()),
            inline: false,
            content_id: None,
            size: Some(4),
        });
        db.save_draft(&draft).unwrap();
        db.queue_outbox(
            &draft,
            "queued",
            None,
            "<stable@example.com>",
            b"Subject: test\r\n\r\nbody",
            None,
        )
        .unwrap();
        db.remove_account(&account.summary.id).unwrap();
        let conn = db.conn().unwrap();
        for table in [
            "offline_ops",
            "drafts",
            "outbox",
            "file_grants",
            "attachment_refs",
        ] {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            assert_eq!(
                conn.query_row(&sql, [], |row| row.get::<_, u32>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn removing_an_unknown_account_fails_without_changing_account_count() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();

        assert_eq!(
            db.remove_account(&uuid::Uuid::new_v4().to_string()),
            Err("Account not found.".into())
        );
        assert_eq!(db.account_count().unwrap(), 1);
        assert!(db.account(&account.summary.id).is_ok());
    }

    #[test]
    fn attachment_grants_are_account_scoped() {
        let db = Database::memory();
        let first = account_with_id("account-1", "one@example.com");
        let second = account_with_id("account-2", "two@example.com");
        db.insert_account(&first).unwrap();
        db.insert_account(&second).unwrap();
        db.grant_file(
            "opaque-token",
            &first.summary.id,
            std::path::Path::new("/private/opaque-token"),
            8,
        )
        .unwrap();
        assert!(db.resolve_file("opaque-token", &first.summary.id).is_ok());
        assert!(db.resolve_file("opaque-token", &second.summary.id).is_err());
    }

    #[test]
    fn uncached_message_uids_returns_newest_empty_bodies() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox_id = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);

        for uid in 1..=4 {
            let mut msg = message(uid, &format!("2026-08-1{uid}T12:00:00Z"));
            if uid == 2 {
                msg.raw_message = b"cached body".to_vec();
            } else {
                msg.raw_message = vec![];
            }
            db.upsert_message(&account.summary.id, mailbox_id, &msg)
                .unwrap();
        }

        let uncached = db.uncached_message_uids(mailbox_id, 10, 1000).unwrap();
        assert_eq!(uncached, vec![4, 3, 1]);
    }

    #[test]
    fn account_aliases_persist_and_update() {
        let db = Database::memory();
        let mut account = account();
        account.summary.aliases = vec![
            "alias1@example.com".into(),
            "alias2@customdomain.com".into(),
        ];
        db.insert_account(&account).unwrap();

        let loaded = db.account(&account.summary.id).unwrap();
        assert_eq!(
            loaded.summary.aliases,
            vec!["alias1@example.com", "alias2@customdomain.com"]
        );

        let listed = db.list_accounts().unwrap();
        assert_eq!(
            listed[0].aliases,
            vec!["alias1@example.com", "alias2@customdomain.com"]
        );

        let updated = db
            .update_account_aliases(&account.summary.id, &["new@customdomain.com".into()])
            .unwrap();
        assert_eq!(updated.aliases, vec!["new@customdomain.com"]);

        let reloaded = db.account(&account.summary.id).unwrap();
        assert_eq!(reloaded.summary.aliases, vec!["new@customdomain.com"]);
    }

    #[test]
    fn multi_account_isolation_and_operations() {
        let db = Database::memory();

        let mut acc1 = account();
        acc1.summary.id = "acc-1".into();
        acc1.summary.email = "acc1@example.com".into();
        acc1.summary.display_name = "Account 1".into();
        db.insert_account(&acc1).unwrap();
        let acc1_inbox = db
            .upsert_mailbox(
                "acc-1",
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                None,
                0,
            )
            .unwrap();

        let mut acc2 = account();
        acc2.summary.id = "acc-2".into();
        acc2.summary.email = "acc2@example.com".into();
        acc2.summary.display_name = "Account 2".into();
        db.insert_account(&acc2).unwrap();
        let acc2_inbox = db
            .upsert_mailbox(
                "acc-2",
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                None,
                0,
            )
            .unwrap();

        let mut msg1 = message(101, "2026-09-01T10:00:00Z");
        msg1.subject = "Urgent project report".into();
        msg1.is_read = false;
        db.upsert_message("acc-1", acc1_inbox, &msg1).unwrap();
        let id1 = db
            .message_summary_by_uid(acc1_inbox, 101)
            .unwrap()
            .unwrap()
            .id;

        let mut msg2 = message(201, "2026-09-02T10:00:00Z");
        msg2.subject = "Project status update".into();
        msg2.is_read = false;
        db.upsert_message("acc-2", acc2_inbox, &msg2).unwrap();
        let id2 = db
            .message_summary_by_uid(acc2_inbox, 201)
            .unwrap()
            .unwrap()
            .id;

        let counts = db.list_account_inbox_counts().unwrap();
        assert_eq!(counts.len(), 2);
        assert_eq!(counts[0].account_id, "acc-1");
        assert_eq!(counts[0].unread_count, 1);
        assert_eq!(counts[1].account_id, "acc-2");
        assert_eq!(counts[1].unread_count, 1);

        let res1 = db
            .search(&SearchQuery {
                account_id: "acc-1".into(),
                mailbox_id: None,
                text: "project".into(),
                limit: 10,
                all_folders: true,
            })
            .unwrap();
        assert_eq!(res1.len(), 1);
        assert_eq!(res1[0].id, id1);

        let all_res = db.search_all_accounts("project", 10).unwrap();
        assert_eq!(all_res.len(), 2);

        let move_err = db.mark_pending_move(id1, acc2_inbox);
        assert!(move_err.is_err());
        assert!(move_err.unwrap_err().contains("different accounts"));

        db.update_account_display_name("acc-1", "Work Mail")
            .unwrap();
        assert_eq!(
            db.account("acc-1").unwrap().summary.display_name,
            "Work Mail"
        );
        assert_eq!(
            db.account("acc-2").unwrap().summary.display_name,
            "Account 2"
        );

        db.remove_account("acc-1").unwrap();
        assert_eq!(db.list_accounts().unwrap().len(), 1);
        assert!(db.account("acc-1").is_err());
        assert!(db.account("acc-2").is_ok());
        assert_eq!(db.list_mailboxes("acc-2").unwrap().len(), 1);
        assert_eq!(
            db.message_detail(id2, "acc-2").unwrap().summary.subject,
            "Project status update"
        );
    }
}
