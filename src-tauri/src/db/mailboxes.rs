use super::{db_error, messages::NOT_SNOOZED_SQL, parse_role, Database};

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

database_operations! {
impl Database {
    /// Mark UIDNEXT unknown so the next pass does not treat the folder as
    /// unchanged while new mail is still being fetched.
    pub fn forget_uid_next(&self, mailbox_id: i64) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE mailboxes SET uid_next=NULL WHERE id=?1",
                [mailbox_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

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
        // Folder IDs can remain selected after their cached rows disappear.
        let existing: Option<i64> = transaction
            .query_row(
                "SELECT id FROM mailboxes WHERE account_id=?1 AND name=?2",
                params![account_id, name],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let stable_id = match existing {
            Some(id) => id,
            None => transaction.query_row("UPDATE mailbox_id_sequence SET last_id=MAX(last_id,(SELECT COALESCE(MAX(id),0) FROM (SELECT id FROM mailboxes UNION ALL SELECT mailbox_id AS id FROM folder_assignments)))+1 WHERE singleton=1 RETURNING last_id", [], |row| row.get::<_, i64>(0)).map_err(db_error)?,
        };
        transaction.execute(
            "INSERT INTO mailboxes (id, account_id, name, display_name, role, role_source, uid_validity, uid_next, server_unread, server_total, counts_updated_at)
             VALUES (?9, ?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
             ON CONFLICT(account_id, name) DO UPDATE SET role=excluded.role, role_source=excluded.role_source, uid_validity=excluded.uid_validity,
             uid_next=excluded.uid_next, server_unread=excluded.server_unread, server_total=excluded.server_total,
             counts_updated_at=CURRENT_TIMESTAMP, local_total_delta=0, local_unread_delta=0,
             counts_generation=mailboxes.counts_generation+1, server_available=1",
            params![account_id, name, role.as_str(), role_source, uid_validity, uid_next, server_unread, server_total, stable_id],
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
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare_cached(&format!(
                "SELECT f.id, f.account_id, f.name, f.display_name,
                    COALESCE((SELECT a.role FROM folder_assignments a WHERE a.account_id=f.account_id AND a.mailbox_id=f.id), CASE WHEN EXISTS(SELECT 1 FROM folder_assignments a WHERE a.account_id=f.account_id AND a.role=f.role) THEN 'other' ELSE f.role END),
                    MAX(0, COALESCE(f.server_unread, SUM(CASE WHEN m.is_read = 0 AND m.pending_move_to IS NULL AND {NOT_SNOOZED_SQL} THEN 1 ELSE 0 END)) + f.local_unread_delta),
                    MAX(0, COALESCE(f.server_total, SUM(CASE WHEN m.pending_move_to IS NULL AND m.id IS NOT NULL AND {NOT_SNOOZED_SQL} THEN 1 ELSE 0 END)) + f.local_total_delta),
                    f.delimiter
             FROM mailboxes f LEFT JOIN messages m ON m.mailbox_id = f.id
             WHERE f.account_id = ?1 GROUP BY f.id
             ORDER BY CASE f.role WHEN 'inbox' THEN 0 WHEN 'starred' THEN 1 WHEN 'drafts' THEN 2 WHEN 'sent' THEN 3 WHEN 'archive' THEN 4 WHEN 'junk' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END, f.display_name COLLATE NOCASE"
            ))
            .map_err(db_error)?;
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
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare_cached(&format!(
                "SELECT f.id, f.account_id, f.name, f.display_name,
                    COALESCE((SELECT a.role FROM folder_assignments a WHERE a.account_id=f.account_id AND a.mailbox_id=f.id), CASE WHEN EXISTS(SELECT 1 FROM folder_assignments a WHERE a.account_id=f.account_id AND a.role=f.role) THEN 'other' ELSE f.role END),
                    MAX(0, COALESCE(f.server_unread, SUM(CASE WHEN m.is_read = 0 AND m.pending_move_to IS NULL AND {NOT_SNOOZED_SQL} THEN 1 ELSE 0 END)) + f.local_unread_delta),
                    MAX(0, COALESCE(f.server_total, SUM(CASE WHEN m.pending_move_to IS NULL AND m.id IS NOT NULL AND {NOT_SNOOZED_SQL} THEN 1 ELSE 0 END)) + f.local_total_delta),
                    f.delimiter
             FROM mailboxes f LEFT JOIN messages m ON m.mailbox_id = f.id
             GROUP BY f.id
             ORDER BY f.account_id, CASE f.role WHEN 'inbox' THEN 0 WHEN 'starred' THEN 1 WHEN 'drafts' THEN 2 WHEN 'sent' THEN 3 WHEN 'archive' THEN 4 WHEN 'junk' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END, f.display_name COLLATE NOCASE"
            ))
            .map_err(db_error)?;
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
        let conn = self.read_conn()?;
        // One row per account: recompute each inbox-role folder from cached
        // rows, then sum across folders. The badge layer keeps only the first
        // row per account, so multiple inbox-role folders must not surface
        // separately here.
        let mut statement = conn
            .prepare_cached(&format!(
                "SELECT per_folder.account_id, SUM(per_folder.unread), SUM(per_folder.total)
              FROM (
                SELECT f.account_id AS account_id,
                    MAX(0, COALESCE(COALESCE(f.server_unread, SUM(CASE WHEN m.is_read = 0 AND m.pending_move_to IS NULL AND {NOT_SNOOZED_SQL} THEN 1 ELSE 0 END)) + f.local_unread_delta, 0)) AS unread,
                    MAX(0, COALESCE(COALESCE(f.server_total, SUM(CASE WHEN m.pending_move_to IS NULL AND m.id IS NOT NULL AND {NOT_SNOOZED_SQL} THEN 1 ELSE 0 END)) + f.local_total_delta, 0)) AS total
                FROM mailboxes f LEFT JOIN messages m ON m.mailbox_id = f.id
                WHERE f.role = 'inbox'
                GROUP BY f.id, f.account_id
              ) per_folder
              GROUP BY per_folder.account_id
              ORDER BY per_folder.account_id"
            ))
            .map_err(db_error)?;
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
        let conn = self.conn()?;
        let explicit: Option<i64> = conn
            .query_row(
                "SELECT mailbox_id FROM folder_assignments WHERE account_id=?1 AND role=?2",
                params![account_id, role],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(id) = explicit {
            return conn.query_row("SELECT id,name FROM mailboxes WHERE account_id=?1 AND id=?2 AND server_available=1", params![account_id,id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(db_error)?.map(Some).ok_or_else(|| "Assigned folder needs attention. Choose another folder or Automatic in Settings.".into());
        }
        conn
            .query_row(
                "SELECT id, name FROM mailboxes WHERE account_id = ?1 AND role = ?2 AND server_available=1 AND NOT EXISTS(SELECT 1 FROM folder_assignments a WHERE a.account_id=mailboxes.account_id AND a.mailbox_id=mailboxes.id) ORDER BY CASE COALESCE(role_source, 'name') WHEN 'specialUse' THEN 0 ELSE 1 END, id LIMIT 1",
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
        transaction
            .execute(
                "UPDATE mailboxes SET server_available=0 WHERE account_id=?1",
                [account_id],
            )
            .map_err(db_error)?;
        for name in server_names {
            transaction
                .execute(
                    "UPDATE mailboxes SET server_available=1 WHERE account_id=?1 AND name=?2",
                    params![account_id, name],
                )
                .map_err(db_error)?;
        }
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
            .prepare("SELECT id,kind,payload,created_at FROM offline_ops WHERE account_id=?1 ORDER BY id")
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
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
        drop(statement);
        for (id, kind, payload, created_at) in rows {
            let mut value: serde_json::Value = serde_json::from_str(&payload)
                .map_err(|_| "Queued changes are damaged.".to_string())?;
            let mut dirty = false;
            let mut copy_destination_changed = false;
            if kind == "flags" || kind == "keyword" {
                if value.get("mailbox").and_then(|name| name.as_str()) == Some(old_name) {
                    value["mailbox"] = serde_json::Value::String(new_name.to_string());
                    dirty = true;
                }
            } else if kind == "move" || kind == "copy" {
                if value.get("source").and_then(|name| name.as_str()) == Some(old_name) {
                    value["source"] = serde_json::Value::String(new_name.to_string());
                    dirty = true;
                }
                if value.get("destination").and_then(|name| name.as_str()) == Some(old_name) {
                    value["destination"] = serde_json::Value::String(new_name.to_string());
                    dirty = true;
                    copy_destination_changed = kind == "copy";
                }
            }
            if dirty {
                let rewritten = serde_json::to_string(&value)
                    .map_err(|_| "Queued changes are damaged.".to_string())?;
                if copy_destination_changed {
                    let message_id = value
                        .get("messageId")
                        .and_then(serde_json::Value::as_i64)
                        .ok_or_else(|| "Queued changes are damaged.".to_string())?;
                    let dedupe_key = format!("copy:{message_id}:{new_name}");
                    let collision: Option<(i64, String, String)> = transaction
                        .query_row(
                            "SELECT id,kind,created_at FROM offline_ops WHERE account_id=?1 AND dedupe_key=?2 AND id<>?3",
                            params![account_id, dedupe_key, id],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        )
                        .optional()
                        .map_err(db_error)?;
                    if let Some((collision_id, collision_kind, collision_created_at)) = collision {
                        if collision_kind != "copy" {
                            return Err("Queued changes are damaged.".into());
                        }
                        // Same-second queue timestamps use ID as a stable tie breaker.
                        let current_is_newer = created_at.as_str() > collision_created_at.as_str()
                            || (created_at == collision_created_at && id > collision_id);
                        if current_is_newer {
                            transaction
                                .execute(
                                    "UPDATE offline_ops SET payload=?2,created_at=?3,not_before=NULL,undo_token=NULL WHERE id=?1 AND account_id=?4",
                                    params![collision_id, rewritten, created_at, account_id],
                                )
                                .map_err(db_error)?;
                        }
                        transaction
                            .execute(
                                "DELETE FROM offline_ops WHERE id=?1 AND account_id=?2",
                                params![id, account_id],
                            )
                            .map_err(db_error)?;
                    } else {
                        transaction
                            .execute(
                                "UPDATE offline_ops SET payload=?2,dedupe_key=?3 WHERE id=?1 AND account_id=?4",
                                params![id, rewritten, dedupe_key, account_id],
                            )
                            .map_err(db_error)?;
                    }
                } else {
                    transaction
                        .execute(
                            "UPDATE offline_ops SET payload=?2 WHERE id=?1 AND account_id=?3",
                            params![id, rewritten, account_id],
                        )
                        .map_err(db_error)?;
                }
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

    pub fn mailbox_delimiter(&self, id: i64) -> Result<Option<String>, String> {
        self.conn()?
            .query_row("SELECT delimiter FROM mailboxes WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Mailbox not found.".into())
    }

    pub fn max_uid(&self, mailbox_id: i64) -> Result<u32, String> {
        self.read_conn()?
            .query_row(
                "SELECT COALESCE(MAX(uid), 0) FROM messages WHERE mailbox_id = ?1",
                [mailbox_id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }

    pub fn min_uid(&self, mailbox_id: i64) -> Result<Option<u32>, String> {
        self.read_conn()?
            .query_row(
                "SELECT MIN(uid) FROM messages WHERE mailbox_id = ?1",
                [mailbox_id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }

    pub fn cached_uids(&self, mailbox_id: i64) -> Result<Vec<u32>, String> {
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare_cached("SELECT uid FROM messages WHERE mailbox_id=?1 ORDER BY uid")
            .map_err(db_error)?;
        let rows = statement
            .query_map([mailbox_id], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn message_received_at(&self, id: i64) -> Result<Option<String>, String> {
        self.read_conn()?
            .query_row(
                "SELECT received_at FROM messages WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)
    }

    pub fn mailbox_sync_meta(&self, mailbox_id: i64) -> Result<MailboxSyncMeta, String> {
        self.read_conn()?
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
        let mut delete = transaction
            .prepare_cached(
                "DELETE FROM messages WHERE mailbox_id=?1 AND uid=?2 AND pending_move_to IS NULL",
            )
            .map_err(db_error)?;
        for uid in cached.into_iter().filter(|uid| !server_uids.contains(uid)) {
            removed += delete
                .execute(params![mailbox_id, uid])
                .map_err(db_error)? as u32;
        }
        drop(delete);
        transaction.commit().map_err(db_error)?;
        Ok(removed)
    }

    /// Delete cached rows for UIDs a QRESYNC VANISHED response named.
    /// Scoped to one mailbox; rows under a pending local move stay.
    pub fn apply_vanished(&self, mailbox_id: i64, uids: &[u32]) -> Result<u32, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let mut removed = 0u32;
        let mut delete = transaction
            .prepare_cached(
                "DELETE FROM messages WHERE mailbox_id=?1 AND uid=?2 AND pending_move_to IS NULL",
            )
            .map_err(db_error)?;
        for uid in uids {
            removed += delete
                .execute(params![mailbox_id, uid])
                .map_err(db_error)? as u32;
        }
        drop(delete);
        transaction.commit().map_err(db_error)?;
        Ok(removed)
    }

    pub fn cached_message_count(&self, mailbox_id: i64) -> Result<u32, String> {
        self.read_conn()?
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{CachedMessage, Database};
    use crate::models::{AccountRecord, AccountSummary, ProviderKind, ServerConfig, TlsMode};

    fn account_with(id: &str, email: &str) -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: id.into(),
                provider: ProviderKind::Manual,
                email: email.into(),
                display_name: email.into(),
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
                username: email.into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: email.into(),
            },
        }
    }

    fn message(uid: u32, received_at: &str) -> CachedMessage {
        CachedMessage {
            uid,
            internal_at: None,
            message_id: Some(format!("<{uid}@example.com>")),
            subject: format!("Letter {uid}"),
            sender_name: "Jane".into(),
            sender_address: "jane@example.com".into(),
            recipients: "sam@example.com".into(),
            received_at: received_at.into(),
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
            raw_message: b"Subject: Letter\r\n\r\nHello".to_vec(),
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

    /// Server unread stays None so unread comes from the cached-row SUM
    /// branch the snooze exclusion touches; total stays STATUS-authoritative.
    fn fixture_mailbox(db: &Database, account_id: &str, name: &str, total: u32) -> i64 {
        db.upsert_mailbox(
            account_id,
            name,
            &MailboxRole::Inbox,
            Some(2),
            Some(3),
            None,
            total,
        )
        .unwrap()
    }

    fn counts_for(db: &Database, account_id: &str, mailbox_id: i64) -> (u32, u32) {
        let mailboxes = db.list_mailboxes(account_id).unwrap();
        let mailbox = mailboxes
            .iter()
            .find(|item| item.id == mailbox_id)
            .unwrap()
            .clone();
        (mailbox.unread_count, mailbox.total_count)
    }

    #[test]
    fn mailbox_counts_exclude_snoozed_messages() {
        let db = Database::memory();
        let account = account_with("account-1", "sam@example.com");
        db.insert_account(&account).unwrap();
        let account_id = account.summary.id.clone();
        let inbox = fixture_mailbox(&db, &account_id, "INBOX", 2);
        db.upsert_message(&account_id, inbox, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap();
        db.upsert_message(&account_id, inbox, &message(2, "2026-08-18T13:00:00Z"))
            .unwrap();
        assert_eq!(counts_for(&db, &account_id, inbox), (2, 2));

        let first = db
            .list_messages(inbox, None, 10)
            .unwrap()
            .items
            .remove(0)
            .id;
        db.snooze_message(&account_id, first, "2999-01-01T00:00:00+00:00")
            .unwrap();

        // The list and the cached unread count hide the snoozed row. The
        // total follows the server's STATUS value until the next refresh.
        let visible = db.list_messages(inbox, None, 10).unwrap().items;
        assert_eq!(visible.len(), 1);
        assert_ne!(visible[0].id, first);
        assert_eq!(counts_for(&db, &account_id, inbox), (1, 2));
        let all = db
            .list_all_mailboxes()
            .unwrap()
            .into_iter()
            .find(|mailbox| mailbox.id == inbox)
            .unwrap();
        assert_eq!((all.unread_count, all.total_count), (1, 2));

        // Expiry lets it count again.
        db.unsnooze_message(&account_id, first).unwrap();
        assert_eq!(counts_for(&db, &account_id, inbox), (2, 2));
    }

    #[test]
    fn inbox_badge_counts_are_one_row_per_account_summed_over_folders() {
        let db = Database::memory();
        db.insert_account(&account_with("account-1", "sam@example.com"))
            .unwrap();
        db.insert_account(&account_with("account-2", "lee@example.com"))
            .unwrap();
        let first = fixture_mailbox(&db, "account-1", "INBOX", 2);
        let second = fixture_mailbox(&db, "account-1", "Second Inbox", 1);
        let third = fixture_mailbox(&db, "account-2", "INBOX", 2);
        db.upsert_message("account-1", first, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap();
        db.upsert_message("account-1", first, &message(2, "2026-08-18T13:00:00Z"))
            .unwrap();
        db.upsert_message("account-1", second, &message(3, "2026-08-18T14:00:00Z"))
            .unwrap();
        db.upsert_message("account-2", third, &message(4, "2026-08-18T15:00:00Z"))
            .unwrap();
        db.upsert_message("account-2", third, &message(5, "2026-08-18T16:00:00Z"))
            .unwrap();

        assert_eq!(
            db.list_account_inbox_counts()
                .unwrap()
                .into_iter()
                .map(|count| (count.account_id, count.unread_count, count.total_count))
                .collect::<Vec<_>>(),
            vec![("account-1".into(), 3, 3), ("account-2".into(), 2, 2),]
        );

        // A snoozed row leaves both the folder and the badge.
        let fifth = db
            .list_messages(third, None, 10)
            .unwrap()
            .items
            .into_iter()
            .find(|message| message.uid == 5)
            .unwrap()
            .id;
        db.snooze_message("account-2", fifth, "2999-01-01T00:00:00+00:00")
            .unwrap();
        assert_eq!(
            db.list_account_inbox_counts()
                .unwrap()
                .into_iter()
                .map(|count| (count.account_id, count.unread_count, count.total_count))
                .collect::<Vec<_>>(),
            vec![("account-1".into(), 3, 3), ("account-2".into(), 1, 2),]
        );
    }
}
