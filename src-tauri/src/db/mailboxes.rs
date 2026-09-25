use super::{db_error, parse_role, Database};

#[derive(Clone, Debug, Default)]
pub struct MailboxSyncMeta {
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub server_total: Option<u32>,
    pub server_unread: Option<u32>,
    pub highest_modseq: Option<u64>,
    pub backfill_state: String,
    pub last_flag_scan_at: Option<String>,
}
use rusqlite::{params, OptionalExtension};

use crate::models::{AccountInboxCount, MailboxRole, MailboxSummary, ROLE_SOURCE_NAME};

impl Database {
    #[allow(dead_code, clippy::too_many_arguments)]
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
        self.upsert_mailbox_with_source(
            account_id,
            name,
            role,
            ROLE_SOURCE_NAME,
            uid_validity,
            uid_next,
            server_unread,
            server_total,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_mailbox_with_source(
        &self,
        account_id: &str,
        name: &str,
        role: &MailboxRole,
        role_source: &str,
        uid_validity: Option<u32>,
        uid_next: Option<u32>,
        server_unread: Option<u32>,
        server_total: u32,
    ) -> Result<i64, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let previous_validity: Option<Option<u32>> = transaction
            .query_row(
                "SELECT uid_validity FROM mailboxes WHERE account_id = ?1 AND name = ?2",
                params![account_id, name],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        transaction.execute(
            "INSERT INTO mailboxes (account_id, name, display_name, role, role_source, uid_validity, uid_next, server_unread, server_total, counts_updated_at)
             VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
             ON CONFLICT(account_id, name) DO UPDATE SET role=excluded.role, role_source=excluded.role_source, uid_validity=excluded.uid_validity,
             uid_next=excluded.uid_next, server_unread=excluded.server_unread, server_total=excluded.server_total,
             counts_updated_at=CURRENT_TIMESTAMP, local_total_delta=0, local_unread_delta=0",
            params![account_id, name, role.as_str(), role_source, uid_validity, uid_next, server_unread, server_total],
        ).map_err(db_error)?;
        let id: i64 = transaction
            .query_row(
                "SELECT id FROM mailboxes WHERE account_id = ?1 AND name = ?2",
                params![account_id, name],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if previous_validity.is_some() && previous_validity != Some(uid_validity) {
            transaction
                .execute("DELETE FROM messages WHERE mailbox_id = ?1", [id])
                .map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE mailboxes SET backfill_uid=NULL,backfill_state='active',highest_modseq=NULL,last_flag_scan_at=NULL WHERE id=?1",
                    [id],
                )
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
                    MAX(0, COALESCE(f.server_total, SUM(CASE WHEN m.pending_move_to IS NULL AND m.id IS NOT NULL THEN 1 ELSE 0 END)) + f.local_total_delta),
                    f.delimiter
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
                    delimiter: row.get(7)?,
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
                    MAX(0, COALESCE(f.server_total, SUM(CASE WHEN m.pending_move_to IS NULL AND m.id IS NOT NULL THEN 1 ELSE 0 END)) + f.local_total_delta),
                    f.delimiter
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
                    delimiter: row.get(7)?,
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
                "SELECT id, name FROM mailboxes WHERE account_id = ?1 AND role = ?2 ORDER BY CASE COALESCE(role_source, 'name') WHEN 'specialUse' THEN 0 ELSE 1 END, id LIMIT 1",
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
                    "DELETE FROM message_fts WHERE rowid IN (SELECT id FROM messages WHERE mailbox_id=?1)",
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
        let delimiter: Option<Option<String>> = transaction
            .query_row(
                "SELECT delimiter FROM mailboxes WHERE account_id=?1 AND name=?2",
                params![account_id, old_name],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let Some(delimiter) = delimiter else {
            return Err("That folder is no longer available.".into());
        };
        // Servers rename the whole subtree; follow it locally so children keep
        // their cached mail instead of being dropped and downloaded again.
        let mut renames = vec![(old_name.to_string(), new_name.to_string())];
        if let Some(delimiter) = delimiter.filter(|value| !value.is_empty()) {
            let prefix = format!("{old_name}{delimiter}");
            let mut statement = transaction
                .prepare("SELECT name FROM mailboxes WHERE account_id=?1 AND substr(name,1,length(?2))=?2")
                .map_err(db_error)?;
            let children = statement
                .query_map(params![account_id, prefix], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            drop(statement);
            for child in children {
                let suffix = &child[prefix.len()..];
                renames.push((child.clone(), format!("{new_name}{delimiter}{suffix}")));
            }
        }
        for (from, to) in &renames {
            transaction
                .execute(
                    "UPDATE mailboxes SET name=?3, display_name=?3 WHERE account_id=?1 AND name=?2",
                    params![account_id, from, to],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE drafts SET remote_mailbox=?3 WHERE account_id=?1 AND remote_mailbox=?2",
                    params![account_id, from, to],
                )
                .map_err(db_error)?;
            Self::rewrite_queued_mailbox_names(&transaction, account_id, from, to)?;
        }
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

    pub fn message_received_at(&self, id: i64) -> Result<Option<String>, String> {
        self.conn()?
            .query_row(
                "SELECT received_at FROM messages WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)
    }

    pub fn mailbox_sync_meta(&self, mailbox_id: i64) -> Result<MailboxSyncMeta, String> {
        self.conn()?
            .query_row(
                "SELECT uid_validity, uid_next, server_total, server_unread, highest_modseq,
                        backfill_state, last_flag_scan_at
                 FROM mailboxes WHERE id=?1",
                [mailbox_id],
                |row| {
                    Ok(MailboxSyncMeta {
                        uid_validity: row.get(0)?,
                        uid_next: row.get(1)?,
                        server_total: row.get(2)?,
                        server_unread: row.get(3)?,
                        highest_modseq: row
                            .get::<_, Option<i64>>(4)?
                            .map(|value| value.max(0) as u64),
                        backfill_state: row.get(5)?,
                        last_flag_scan_at: row.get(6)?,
                    })
                },
            )
            .map_err(db_error)
    }

    pub fn set_backfill(
        &self,
        mailbox_id: i64,
        cursor: Option<u32>,
        state: &str,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE mailboxes SET backfill_uid=?2, backfill_state=?3 WHERE id=?1",
                params![mailbox_id, cursor, state],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn set_mailbox_listing(
        &self,
        mailbox_id: i64,
        delimiter: Option<&str>,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE mailboxes SET delimiter=?2 WHERE id=?1",
                params![mailbox_id, delimiter],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn set_mailbox_sync_error(
        &self,
        account_id: &str,
        name: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE mailboxes SET sync_error=?3 WHERE account_id=?1 AND name=?2",
                params![account_id, name, error],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn set_highest_modseq(&self, mailbox_id: i64, modseq: Option<u64>) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE mailboxes SET highest_modseq=?2 WHERE id=?1",
                params![
                    mailbox_id,
                    modseq.map(|value| value.min(i64::MAX as u64) as i64)
                ],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn mark_flag_scan(&self, mailbox_id: i64) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE mailboxes SET last_flag_scan_at=strftime('%Y-%m-%dT%H:%M:%S+00:00','now') WHERE id=?1",
                [mailbox_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    /// Delete cached rows in `[low, high]` that the server no longer lists.
    /// Rows hidden by a pending local move stay: the queued move owns them.
    pub fn reconcile_expunged(
        &self,
        mailbox_id: i64,
        low: u32,
        high: u32,
        server_uids: &std::collections::HashSet<u32>,
    ) -> Result<u32, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let cached = {
            let mut statement = transaction
                .prepare(
                    "SELECT uid FROM messages WHERE mailbox_id=?1 AND uid BETWEEN ?2 AND ?3 AND pending_move_to IS NULL",
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(params![mailbox_id, low, high], |row| row.get::<_, u32>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            rows
        };
        let mut removed = 0u32;
        for uid in cached.into_iter().filter(|uid| !server_uids.contains(uid)) {
            removed += transaction
                .execute(
                    "DELETE FROM messages WHERE mailbox_id=?1 AND uid=?2 AND pending_move_to IS NULL",
                    params![mailbox_id, uid],
                )
                .map_err(db_error)? as u32;
        }
        transaction.commit().map_err(db_error)?;
        Ok(removed)
    }

    pub fn cached_message_count(&self, mailbox_id: i64) -> Result<u32, String> {
        self.conn()?
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE mailbox_id=?1",
                [mailbox_id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }

    /// Envelope and body download totals for one account, recomputed from the
    /// database so progress survives restarts.
    pub fn account_sync_progress(
        &self,
        account_id: &str,
        policy: &crate::models::CachePolicy,
    ) -> Result<crate::models::SyncProgress, String> {
        let cutoff = policy.cutoff().map(crate::mail::parse::canonical_time);
        let conn = self.conn()?;
        let (server_total, backfilling): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(server_total),0),
                        COALESCE(SUM(CASE WHEN backfill_state='active' THEN 1 ELSE 0 END),0)
                 FROM mailboxes WHERE account_id=?1 AND role NOT IN ('junk','trash')",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        let (cached, bodies_wanted, bodies_done): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN m.prefetch_failures<5 AND (?2 IS NULL OR julianday(COALESCE(m.internal_at,m.received_at)) >= julianday(?2)) THEN 1 ELSE 0 END),0),
                        COALESCE(SUM(CASE WHEN m.body_bytes>0 AND (?2 IS NULL OR julianday(COALESCE(m.internal_at,m.received_at)) >= julianday(?2)) THEN 1 ELSE 0 END),0)
                 FROM messages m JOIN mailboxes box ON box.id=m.mailbox_id
                 WHERE m.account_id=?1 AND box.role NOT IN ('junk','trash')",
                params![account_id, cutoff],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(db_error)?;
        Ok(crate::models::SyncProgress {
            account_id: account_id.to_string(),
            folder: None,
            envelopes_done: cached.max(0) as u64,
            envelopes_total: if policy.mode == "full" {
                (server_total.max(cached)).max(0) as u64
            } else {
                cached.max(0) as u64
            },
            bodies_done: bodies_done.max(0) as u64,
            bodies_total: bodies_wanted.max(bodies_done).max(0) as u64,
            backfilling: backfilling > 0,
        })
    }
}
