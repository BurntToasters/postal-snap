//! Offline operation queue: flag changes, queued moves, and replay cleanup.

use super::messages::mark_pending_move_in_transaction;
use super::{adjust_mailbox_counts, clear_pending_move_in_transaction, db_error, Database};
use rusqlite::{params, OptionalExtension};

/// Fixed-width UTC timestamp, so `not_before` compares as text in SQL.
fn format_instant(value: chrono::DateTime<chrono::Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn token_session(undo_token: &str) -> Option<&str> {
    let bytes = undo_token.as_bytes();
    if bytes.len() == 64 && bytes.iter().all(|byte| byte.is_ascii_hexdigit()) {
        Some(&undo_token[..32])
    } else {
        None
    }
}

database_operations! {
impl Database {
    /// Rotate the live frontend session and release holds from the old one.
    pub fn begin_undo_session(&self) -> Result<String, String> {
        let mut active_session = self
            .undo_session
            .lock()
            .map_err(|_| "The undo session is unavailable.".to_string())?;
        let next_session = uuid::Uuid::new_v4().simple().to_string();
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute(
                "UPDATE offline_ops SET not_before=NULL WHERE kind='move' AND not_before IS NOT NULL",
                [],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        *active_session = next_session.clone();
        Ok(next_session)
    }

    pub fn record_flag_change(
        &self,
        account_id: &str,
        message_id: i64,
        is_read: Option<bool>,
        is_starred: Option<bool>,
        queued: Option<&serde_json::Value>,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(db_error)?;
        let (
            source_mailbox_id,
            pending_destination_id,
            was_read,
            source_overlay_active,
            destination_overlay_active,
        ): (i64, Option<i64>, bool, bool, bool) = tx
            .prepare_cached(
                "SELECT m.mailbox_id,m.pending_move_to,m.is_read != 0,
                         COALESCE(m.pending_move_to IS NOT NULL AND m.pending_source_generation=s.counts_generation,0),
                         COALESCE(m.pending_move_to IS NOT NULL AND m.pending_destination_generation=d.counts_generation,0)
                 FROM messages m JOIN mailboxes s ON s.id=m.mailbox_id
                 LEFT JOIN mailboxes d ON d.id=m.pending_move_to
                 WHERE m.id=?1 AND m.account_id=?2",
            )
            .map_err(db_error)?
            .query_row(params![message_id, account_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Message not found.".to_string())?;
        let operations: Vec<(i64, String)> = {
            let mut statement = tx.prepare_cached(
                "SELECT id,payload FROM offline_ops WHERE account_id=?1 AND kind='flags' AND json_valid(payload) AND json_extract(payload,'$.messageId')=?2 ORDER BY id"
            ).map_err(db_error)?;
            let rows = statement
                .query_map(params![account_id, message_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<_, _>>()
                .map_err(db_error)?;
            rows
        };
        for (id, payload) in operations {
            let mut operation: serde_json::Value = serde_json::from_str(&payload)
                .map_err(|_| "Queued flag change could not be read.".to_string())?;
            if is_read.is_some() {
                operation["isRead"] = serde_json::Value::Null;
            }
            if is_starred.is_some() {
                operation["isStarred"] = serde_json::Value::Null;
            }
            let has_read = !operation["isRead"].is_null();
            let has_star = !operation["isStarred"].is_null();
            if !has_read && !has_star {
                tx.prepare_cached("DELETE FROM offline_ops WHERE id=?1")
                    .map_err(db_error)?
                    .execute([id])
                    .map_err(db_error)?;
                continue;
            }
            let dedupe = format!("flags:{message_id}:{has_read}:{has_star}");
            let collision: Option<i64> = tx
                .prepare_cached(
                    "SELECT id FROM offline_ops WHERE account_id=?1 AND dedupe_key=?2 AND id<>?3",
                )
                .map_err(db_error)?
                .query_row(params![account_id, dedupe, id], |row| row.get(0))
                .optional()
                .map_err(db_error)?;
            if let Some(other_id) = collision {
                let older = id.min(other_id);
                tx.prepare_cached("DELETE FROM offline_ops WHERE id=?1")
                    .map_err(db_error)?
                    .execute([older])
                    .map_err(db_error)?;
                if older == id {
                    continue;
                }
            }
            tx.prepare_cached("UPDATE offline_ops SET payload=?2,dedupe_key=?3 WHERE id=?1")
                .map_err(db_error)?
                .execute(params![id, operation.to_string(), dedupe])
                .map_err(db_error)?;
        }
        if let Some(operation) = queued {
            for (read, star) in [(is_read, None), (None, is_starred)] {
                if read.is_none() && star.is_none() {
                    continue;
                }
                let mut field = operation.clone();
                field["isRead"] = read
                    .map(serde_json::Value::Bool)
                    .unwrap_or(serde_json::Value::Null);
                field["isStarred"] = star
                    .map(serde_json::Value::Bool)
                    .unwrap_or(serde_json::Value::Null);
                let dedupe = format!("flags:{message_id}:{}:{}", read.is_some(), star.is_some());
                tx.prepare_cached(
                    "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key) VALUES(?1,'flags',?2,?3)
                     ON CONFLICT(account_id,dedupe_key) DO UPDATE SET payload=excluded.payload,created_at=CURRENT_TIMESTAMP",
                )
                .map_err(db_error)?
                .execute(params![account_id, field.to_string(), dedupe])
                .map_err(db_error)?;
            }
        }
        tx.prepare_cached(
            "UPDATE messages SET is_read=COALESCE(?2,is_read),is_starred=COALESCE(?3,is_starred) WHERE id=?1",
        )
        .map_err(db_error)?
        .execute(params![message_id, is_read.map(i32::from), is_starred.map(i32::from)])
        .map_err(db_error)?;
        if let Some(is_read) = is_read.filter(|value| *value != was_read) {
            let delta = if is_read { -1 } else { 1 };
            if pending_destination_id.is_none() || !source_overlay_active {
                adjust_mailbox_counts(&tx, source_mailbox_id, 0, Some(delta))?;
            }
            if let Some(destination_id) =
                pending_destination_id.filter(|_| destination_overlay_active)
            {
                adjust_mailbox_counts(&tx, destination_id, 0, Some(delta))?;
            }
        }
        tx.commit().map_err(db_error)
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
                 ON CONFLICT(account_id,dedupe_key) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,created_at=CURRENT_TIMESTAMP,not_before=NULL,undo_token=NULL",
                params![account_id, kind, json, dedupe_key],
            )
            .map_err(db_error)?;
        Ok(())
    }

    /// Operations due for replay. Operations for a message wait behind that
    /// message's undo-window move until the move is due.
    pub fn queued_operations(
        &self,
        account_id: &str,
    ) -> Result<Vec<(i64, String, String)>, String> {
        Ok(self
            .queued_operations_with_attempts(account_id)?
            .into_iter()
            .map(|(id, kind, payload, _)| (id, kind, payload))
            .collect())
    }

    /// Due operations plus their transient failure counts, for batch planning.
    pub fn queued_operations_with_attempts(
        &self,
        account_id: &str,
    ) -> Result<Vec<(i64, String, String, i64)>, String> {
        let session = self.current_undo_session()?;
        let now = format_instant(chrono::Utc::now());
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT o.id,o.kind,o.payload,o.attempts FROM offline_ops o
                 WHERE o.account_id=?1
                   AND (o.not_before IS NULL OR o.not_before<=?2)
                   AND NOT (o.kind='move' AND o.not_before IS NOT NULL
                     AND COALESCE(length(o.undo_token)=64 AND substr(o.undo_token,1,32)=?3,0))
                   AND NOT EXISTS (
                     SELECT 1 FROM offline_ops held
                     WHERE held.account_id=o.account_id AND held.kind='move'
                       AND held.not_before IS NOT NULL
                       AND (held.not_before>?2 OR COALESCE(length(held.undo_token)=64 AND substr(held.undo_token,1,32)=?3,0))
                       AND held.id<o.id
                       AND CASE WHEN json_valid(held.payload) THEN json_extract(held.payload,'$.messageId') END
                         = CASE WHEN json_valid(o.payload) THEN json_extract(o.payload,'$.messageId') END
                   )
                 ORDER BY o.id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![account_id, now, session], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    /// Queue moves that stay hidden until `not_before` or a commit. The queue
    /// rows and the local pending marks commit together or not at all.
    pub fn defer_moves<T: serde::Serialize>(
        &self,
        account_id: &str,
        entries: &[(i64, T, i64)],
        undo_token: &str,
        not_before: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), String> {
        let not_before = format_instant(not_before);
        let active_session = self
            .undo_session
            .lock()
            .map_err(|_| "The undo session is unavailable.".to_string())?;
        if token_session(undo_token).is_some_and(|session| session != active_session.as_str()) {
            return Err("This undo request is no longer valid.".into());
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        for (message_id, operation, destination_id) in entries {
            let json = serde_json::to_string(operation)
                .map_err(|_| "Could not queue the offline change.".to_string())?;
            let dedupe_key = format!("move:{message_id}");
            transaction
                .prepare_cached(
                    "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key,not_before,undo_token,attempts)
                     VALUES(?1,'move',?2,?3,?4,?5,0)
                     ON CONFLICT(account_id,dedupe_key) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,created_at=CURRENT_TIMESTAMP,not_before=excluded.not_before,undo_token=excluded.undo_token,attempts=0",
                )
                .map_err(db_error)?
                .execute(params![account_id, json, dedupe_key, not_before, undo_token])
                .map_err(db_error)?;
            mark_pending_move_in_transaction(&transaction, *message_id, *destination_id)?;
        }
        transaction.commit().map_err(db_error)
    }

    /// Cancel the still-queued moves for one undo token. Returns how many
    /// messages were restored, and `true` when nothing was left to cancel
    /// because replay already ran.
    pub fn undo_deferred(
        &self,
        account_id: &str,
        undo_token: &str,
    ) -> Result<(usize, bool), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let operations: Vec<(i64, String)> = {
            let mut statement = transaction
                .prepare(
                    "SELECT id,payload FROM offline_ops WHERE account_id=?1 AND undo_token=?2 AND kind='move' ORDER BY id",
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(params![account_id, undo_token], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<_, _>>()
                .map_err(db_error)?;
            rows
        };
        if operations.is_empty() {
            return Ok((0, true));
        }
        let mut restored = 0usize;
        for (id, payload) in operations {
            transaction
                .execute(
                    "DELETE FROM offline_ops WHERE id=?1 AND account_id=?2",
                    params![id, account_id],
                )
                .map_err(db_error)?;
            let message_id = serde_json::from_str::<serde_json::Value>(&payload)
                .ok()
                .and_then(|value| value["messageId"].as_i64());
            if let Some(message_id) = message_id {
                clear_pending_move_in_transaction(&transaction, message_id)?;
                restored += 1;
            }
        }
        transaction.commit().map_err(db_error)?;
        Ok((restored, false))
    }

    /// Make the moves for one undo token due now.
    pub fn commit_deferred(&self, account_id: &str, undo_token: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE offline_ops SET not_before=NULL WHERE account_id=?1 AND undo_token=?2",
                params![account_id, undo_token],
            )
            .map_err(db_error)?;
        Ok(())
    }

    /// Time until the next deferred operation becomes due, if any is still waiting.
    pub fn next_deferred_due(&self, account_id: &str) -> Result<Option<std::time::Duration>, String> {
        let session = self.current_undo_session()?;
        let now = chrono::Utc::now();
        let next: Option<String> = self
            .read_conn()?
            .query_row(
                "SELECT MIN(not_before) FROM offline_ops
                 WHERE account_id=?1 AND not_before>?2
                   AND NOT COALESCE(length(undo_token)=64 AND substr(undo_token,1,32)=?3,0)",
                params![account_id, format_instant(now), session],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        Ok(next
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .and_then(|when| (when.with_timezone(&chrono::Utc) - now).to_std().ok()))
    }

    /// Count a transient replay failure so repeated failures are visible.
    pub fn record_operation_attempt(&self, account_id: &str, id: i64) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE offline_ops SET attempts=attempts+1 WHERE id=?1 AND account_id=?2",
                params![id, account_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn remove_operation(&self, account_id: &str, id: i64) -> Result<(), String> {
        self.conn()?
            .execute(
                "DELETE FROM offline_ops WHERE id=?1 AND account_id=?2",
                params![id, account_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn remove_operation_by_dedupe(
        &self,
        account_id: &str,
        dedupe_key: &str,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "DELETE FROM offline_ops WHERE account_id=?1 AND dedupe_key=?2",
                params![account_id, dedupe_key],
            )
            .map_err(db_error)?;
        Ok(())
    }
}
}
