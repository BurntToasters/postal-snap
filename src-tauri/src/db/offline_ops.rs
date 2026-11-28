//! Offline operation queue: flag changes, queued moves, and replay cleanup.

use super::messages::mark_pending_move_in_transaction;
use super::{adjust_mailbox_counts, clear_pending_move_in_transaction, db_error, Database};
use crate::date_time::{format_utc_millis_z, now_utc, parse_rfc3339};
use crate::mail::keywords::ColorChange;
use rusqlite::{params, OptionalExtension};
use std::collections::{HashMap, HashSet};
use time::OffsetDateTime;

const MAX_FAILED_OFFLINE_OPERATIONS: usize = 100;

fn failed_offline_kind(kind: &str) -> crate::models::FailedOfflineKind {
    match kind {
        "move" => crate::models::FailedOfflineKind::Move,
        "copy" => crate::models::FailedOfflineKind::Copy,
        "flags" => crate::models::FailedOfflineKind::Flags,
        "keyword" => crate::models::FailedOfflineKind::Keyword,
        _ => crate::models::FailedOfflineKind::Other,
    }
}

/// Dedupe key for a flag op. Plain ops keep their historical key; a color
/// op adds its color so differently colored ops never share a row.
fn flag_dedupe_key(
    message_id: i64,
    has_read: bool,
    has_star: bool,
    operation: &serde_json::Value,
) -> String {
    let base = format!("flags:{message_id}:{has_read}:{has_star}");
    match operation["flagColor"].as_u64() {
        Some(color) if has_star => format!("{base}:c{color}"),
        _ => base,
    }
}

/// Fixed-width UTC timestamp, so `not_before` compares as text in SQL.
fn format_instant(value: OffsetDateTime) -> String {
    format_utc_millis_z(value)
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
    ///
    /// Scoping invariant: every hold can only have been created through
    /// defer_moves by the single live frontend session, sessions rotate only
    /// at frontend boot when all existing holds belong to dead sessions, and
    /// defer_moves rejects a token from the previous session. So no hold from
    /// a live session exists when this runs, and this release-all UPDATE can
    /// never clear one — including holds from a different account.
    pub fn begin_undo_session(&self) -> Result<String, String> {
        let mut active_session = self
            .undo_session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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

    #[cfg(test)]
    pub fn record_flag_change(
        &self,
        account_id: &str,
        message_id: i64,
        is_read: Option<bool>,
        is_starred: Option<bool>,
        queued: Option<&serde_json::Value>,
    ) -> Result<(), String> {
        self.record_colored_flag_change(account_id, message_id, is_read, is_starred, None, queued)
    }

    /// Like `record_flag_change`, also updating the local flag color. A
    /// mailbox without keywords cannot hold a color, so it stores 0 there.
    pub fn record_colored_flag_change(
        &self,
        account_id: &str,
        message_id: i64,
        is_read: Option<bool>,
        is_starred: Option<bool>,
        color: Option<ColorChange>,
        queued: Option<&serde_json::Value>,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(db_error)?;
        record_colored_flag_change_tx(&tx, account_id, message_id, is_read, is_starred, color, queued)?;
        tx.commit().map_err(db_error)
    }

    pub fn record_bulk_flag_changes(
        &self,
        account_id: &str,
        items: &[(i64, Option<&serde_json::Value>)],
        is_read: Option<bool>,
        is_starred: Option<bool>,
        color: Option<ColorChange>,
    ) -> Result<Vec<i64>, String> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(db_error)?;
        let mut failed = Vec::new();
        for (message_id, queued) in items {
            if record_colored_flag_change_tx(
                &tx,
                account_id,
                *message_id,
                is_read,
                is_starred,
                color,
                *queued,
            )
            .is_err()
            {
                failed.push(*message_id);
            }
        }
        tx.commit().map_err(db_error)?;
        Ok(failed)
    }

    /// Local flag color after a replayed change. Mailboxes without keywords
    /// store 0, matching `record_colored_flag_change`.
    pub fn apply_flag_color(
        &self,
        message_id: i64,
        color: Option<ColorChange>,
    ) -> Result<(), String> {
        let value = match color {
            Some(ColorChange::Set(value)) => i64::from(value),
            Some(ColorChange::Clear) => 0,
            None => return Ok(()),
        };
        self.conn()?
            .execute(
                "UPDATE messages SET flag_color=CASE WHEN (SELECT s.allows_keywords FROM mailboxes s WHERE s.id=messages.mailbox_id)<>0 THEN ?2 ELSE 0 END WHERE id=?1",
                params![message_id, value],
            )
            .map(|_| ())
            .map_err(db_error)
    }

    /// Whether a mailbox accepts keywords, as recorded at its last SELECT.
    pub fn mailbox_allows_keywords(&self, account_id: &str, mailbox: &str) -> Result<bool, String> {
        Ok(self
            .read_conn()?
            .query_row(
                "SELECT allows_keywords != 0 FROM mailboxes WHERE account_id=?1 AND name=?2",
                params![account_id, mailbox],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .unwrap_or(false))
    }

    /// Whether an offline op row exists for this dedupe key, including deferred rows.
    pub fn has_offline_op_dedupe_key(
        &self,
        account_id: &str,
        dedupe_key: &str,
    ) -> Result<bool, String> {
        self.read_conn()?
            .query_row(
                "SELECT 1 FROM offline_ops WHERE account_id=?1 AND dedupe_key=?2 LIMIT 1",
                params![account_id, dedupe_key],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(db_error)
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
                "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key,state) VALUES(?1,?2,?3,?4,'queued')
                 ON CONFLICT(account_id,dedupe_key) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,created_at=CURRENT_TIMESTAMP,not_before=NULL,undo_token=NULL,state='queued',attempts=0",
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

    pub fn replay_source_barrier_operations(
        &self,
        account_id: &str,
    ) -> Result<Vec<(i64, String, String)>, String> {
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id,kind,payload FROM offline_ops
                 WHERE account_id=?1 AND (
                     (state IN ('queued','needs_attention') AND kind IN ('copy','keyword'))
                     OR (state='needs_attention' AND kind='flags')
                   ) ORDER BY id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    /// Due operations plus their transient failure counts, for batch planning.
    pub fn queued_operations_with_attempts(
        &self,
        account_id: &str,
    ) -> Result<Vec<(i64, String, String, i64)>, String> {
        let now = format_instant(now_utc());
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare(
                "SELECT o.id,o.kind,o.payload,o.attempts FROM offline_ops o
                 WHERE o.account_id=?1 AND o.state='queued'
                   AND (o.not_before IS NULL OR o.not_before<=?2)
                   AND NOT EXISTS (
                     SELECT 1 FROM offline_ops held
                     WHERE held.account_id=o.account_id AND held.state='queued' AND held.kind='move'
                       AND held.not_before IS NOT NULL AND held.not_before>?2
                       AND held.id<o.id
                       AND CASE WHEN json_valid(held.payload) THEN json_extract(held.payload,'$.messageId') END
                         = CASE WHEN json_valid(o.payload) THEN json_extract(o.payload,'$.messageId') END
                   )
                 ORDER BY o.id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![account_id, now], |row| {
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
        not_before: OffsetDateTime,
    ) -> Result<(), String> {
        let not_before = format_instant(not_before);
        let active_session = self
            .undo_session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
                    "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key,not_before,undo_token,attempts,state)
                     VALUES(?1,'move',?2,?3,?4,?5,0,'queued')
                     ON CONFLICT(account_id,dedupe_key) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,created_at=CURRENT_TIMESTAMP,not_before=excluded.not_before,undo_token=excluded.undo_token,attempts=0,state='queued'",
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
                "UPDATE offline_ops SET not_before=NULL WHERE account_id=?1 AND undo_token=?2 AND state='queued'",
                params![account_id, undo_token],
            )
            .map_err(db_error)?;
        Ok(())
    }

    /// Time until the next deferred operation becomes due, if any is still waiting.
    pub fn next_deferred_due(&self, account_id: &str) -> Result<Option<std::time::Duration>, String> {
        let now = now_utc();
        let next: Option<String> = self
            .read_conn()?
            .query_row(
                "SELECT MIN(not_before) FROM offline_ops
                 WHERE account_id=?1 AND state='queued' AND not_before>?2",
                params![account_id, format_instant(now)],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        Ok(next
            .and_then(|value| parse_rfc3339(&value).ok())
            .and_then(|when| std::time::Duration::try_from(when - now).ok()))
    }

    /// Count a transient replay failure so repeated failures are visible.
    pub fn record_operation_attempt(&self, account_id: &str, id: i64) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE offline_ops SET attempts=attempts+1 WHERE id=?1 AND account_id=?2 AND state='queued'",
                params![id, account_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn mark_operation_needs_attention(
        &self,
        account_id: &str,
        id: i64,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE offline_ops SET state='needs_attention',not_before=NULL,undo_token=NULL
                 WHERE id=?1 AND account_id=?2",
                params![id, account_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn offline_operations_needing_attention(&self, account_id: &str) -> Result<u32, String> {
        self.read_conn()?
            .query_row(
                "SELECT COUNT(*) FROM offline_ops WHERE account_id=?1 AND state='needs_attention'",
                [account_id],
                |row| row.get::<_, u32>(0),
            )
            .map_err(db_error)
    }

    /// Return a bounded, redacted list of failed local intents for one account.
    pub fn failed_offline_operations(
        &self,
        account_id: &str,
    ) -> Result<crate::models::FailedOfflineOperations, String> {
        let conn = self.read_conn()?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1)",
                [account_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("Account not found.".into());
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM offline_ops WHERE account_id=?1 AND state='needs_attention'",
                [account_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let mut statement = conn
            .prepare_cached(
                "SELECT id,kind,attention_token FROM offline_ops
                 WHERE account_id=?1 AND state='needs_attention'
                 ORDER BY id LIMIT ?2",
            )
            .map_err(db_error)?;
        let items = statement
            .query_map(
                params![account_id, MAX_FAILED_OFFLINE_OPERATIONS as i64],
                |row| {
                    let kind: String = row.get(1)?;
                    Ok(crate::models::FailedOfflineOperation {
                        id: row.get(0)?,
                        kind: failed_offline_kind(&kind),
                        review_token: row.get(2)?,
                    })
                },
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(crate::models::FailedOfflineOperations {
            items,
            total_count: count.clamp(0, i64::from(u32::MAX)) as u32,
        })
    }

    /// Atomically remove only the reviewed failed rows. This never replays mail
    /// commands; a newer queued move keeps its optimistic local hide marker.
    pub fn dismiss_failed_offline_operations(
        &self,
        account_id: &str,
        operations: &[crate::models::FailedOfflineOperationRef],
    ) -> Result<u32, String> {
        if operations.is_empty()
            || operations.len() > MAX_FAILED_OFFLINE_OPERATIONS
            || operations.iter().any(|operation| {
                operation.id <= 0
                    || operation.review_token.len() != 32
                    || !operation
                        .review_token
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err("Choose up to 100 failed changes to remove.".into());
        }
        let selected_ids = operations
            .iter()
            .map(|operation| operation.id)
            .collect::<HashSet<_>>();
        if selected_ids.len() != operations.len() {
            return Err("Choose each failed change only once.".into());
        }

        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1)",
                [account_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("Account not found.".into());
        }

        let mut selected_moves: HashMap<i64, HashSet<String>> = HashMap::new();
        for operation_ref in operations {
            let operation: Option<(String, String)> = transaction
                .query_row(
                    "SELECT kind,payload FROM offline_ops
                     WHERE id=?1 AND account_id=?2 AND state='needs_attention'
                       AND attention_token=?3",
                    params![operation_ref.id, account_id, operation_ref.review_token],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?;
            let Some((kind, payload)) = operation else {
                return Err(
                    "Some selected failed changes have changed. Refresh the list and try again."
                        .into(),
                );
            };
            if kind == "move" {
                let operation: serde_json::Value = serde_json::from_str(&payload)
                    .map_err(|_| "A failed local change could not be removed safely.".to_string())?;
                let message_id = operation["messageId"]
                    .as_i64()
                    .ok_or_else(|| "A failed local change could not be removed safely.".to_string())?;
                let destination = operation["destination"]
                    .as_str()
                    .ok_or_else(|| "A failed local change could not be removed safely.".to_string())?
                    .to_string();
                selected_moves
                    .entry(message_id)
                    .or_default()
                    .insert(destination);
            }
        }

        let selected_ids = operations
            .iter()
            .map(|operation| operation.id)
            .collect::<Vec<_>>();
        let selected_json = serde_json::to_string(&selected_ids)
            .map_err(|_| "Selected failed changes could not be read.".to_string())?;
        for (message_id, destinations) in selected_moves {
            let current: Option<(Option<i64>, Option<String>)> = transaction
                .query_row(
                    "SELECT m.pending_move_to,d.name
                     FROM messages m LEFT JOIN mailboxes d ON d.id=m.pending_move_to
                     WHERE m.id=?1 AND m.account_id=?2",
                    params![message_id, account_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?;
            let Some((Some(_), Some(destination))) = current else {
                continue;
            };
            if !destinations.contains(&destination) {
                continue;
            }
            let newer_move: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM offline_ops o
                       WHERE o.account_id=?1 AND o.kind='move'
                         AND o.id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?2))
                         AND (NOT json_valid(o.payload)
                              OR json_extract(o.payload,'$.messageId')=?3)
                     )",
                    params![account_id, selected_json, message_id],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if !newer_move {
                clear_pending_move_in_transaction(&transaction, message_id)?;
            }
        }

        for operation_ref in operations {
            let changed = transaction
                .execute(
                    "DELETE FROM offline_ops
                     WHERE id=?1 AND account_id=?2 AND state='needs_attention'
                       AND attention_token=?3",
                    params![operation_ref.id, account_id, operation_ref.review_token],
                )
                .map_err(db_error)?;
            if changed != 1 {
                return Err(
                    "Some selected failed changes have changed. Refresh the list and try again."
                        .into(),
                );
            }
        }
        transaction.commit().map_err(db_error)?;
        Ok(operations.len() as u32)
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

fn record_colored_flag_change_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    message_id: i64,
    is_read: Option<bool>,
    is_starred: Option<bool>,
    color: Option<ColorChange>,
    queued: Option<&serde_json::Value>,
) -> Result<(), String> {
    let (
        source_mailbox_id,
        pending_destination_id,
        was_read,
        source_overlay_active,
        destination_overlay_active,
        allows_keywords,
    ): (i64, Option<i64>, bool, bool, bool, bool) = tx
        .prepare_cached(
            "SELECT m.mailbox_id,m.pending_move_to,m.is_read != 0,
                     COALESCE(m.pending_move_to IS NOT NULL AND m.pending_source_generation=s.counts_generation,0),
                     COALESCE(m.pending_move_to IS NOT NULL AND m.pending_destination_generation=d.counts_generation,0),
                     s.allows_keywords != 0
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
                row.get(5)?,
            ))
        })
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Message not found.".to_string())?;
    let color_update: Option<i64> = match color {
        Some(ColorChange::Set(value)) if allows_keywords => Some(i64::from(value)),
        Some(ColorChange::Set(_)) | Some(ColorChange::Clear) => Some(0),
        None if is_starred == Some(false) => Some(0),
        None => None,
    };
    let operations: Vec<(i64, String)> = {
        let mut statement = tx
            .prepare_cached(
                "SELECT id,payload FROM offline_ops WHERE account_id=?1 AND kind='flags' AND json_valid(payload) AND json_extract(payload,'$.messageId')=?2 ORDER BY id",
            )
            .map_err(db_error)?;
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
            operation["flagColor"] = serde_json::Value::Null;
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
        let dedupe = flag_dedupe_key(message_id, has_read, has_star, &operation);
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
        tx.prepare_cached(
            "UPDATE offline_ops SET payload=?2,dedupe_key=?3,state='queued',attempts=0 WHERE id=?1",
        )
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
            if star.is_none() {
                field["flagColor"] = serde_json::Value::Null;
            }
            let dedupe = flag_dedupe_key(message_id, read.is_some(), star.is_some(), &field);
            tx.prepare_cached(
                "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key) VALUES(?1,'flags',?2,?3)
                 ON CONFLICT(account_id,dedupe_key) DO UPDATE SET payload=excluded.payload,created_at=CURRENT_TIMESTAMP,state='queued',attempts=0",
            )
            .map_err(db_error)?
            .execute(params![account_id, field.to_string(), dedupe])
            .map_err(db_error)?;
        }
    }
    tx.prepare_cached(
        "UPDATE messages SET is_read=COALESCE(?2,is_read),is_starred=COALESCE(?3,is_starred),flag_color=COALESCE(?4,flag_color) WHERE id=?1",
    )
    .map_err(db_error)?
    .execute(params![
        message_id,
        is_read.map(i32::from),
        is_starred.map(i32::from),
        color_update,
    ])
    .map_err(db_error)?;
    if let Some(is_read) = is_read.filter(|value| *value != was_read) {
        let delta = if is_read { -1 } else { 1 };
        if pending_destination_id.is_none() || !source_overlay_active {
            adjust_mailbox_counts(tx, source_mailbox_id, 0, Some(delta))?;
        }
        if let Some(destination_id) = pending_destination_id.filter(|_| destination_overlay_active)
        {
            adjust_mailbox_counts(tx, destination_id, 0, Some(delta))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::{flag_dedupe_key, format_instant, ColorChange};

    #[test]
    fn deferred_timestamp_is_exact_sortable_millisecond_utc() {
        let instant = crate::date_time::parse_rfc3339("2026-03-08T02:59:59.987654321+06:45")
            .unwrap()
            .to_offset(time::UtcOffset::UTC);
        assert_eq!(format_instant(instant), "2026-03-07T20:14:59.987Z");
    }

    const ACCOUNT: &str = "color-account";

    fn account() -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                notify_new_mail: true,
                default_body_format: crate::models::BodyFormat::Html,
                id: ACCOUNT.into(),
                provider: ProviderKind::Manual,
                provider_id: None,
                app_password_policy: None,
                app_password_url: None,
                password_format: None,
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
        }
    }

    fn message(uid: u32) -> CachedMessage {
        CachedMessage {
            uid,
            internal_at: None,
            message_id: Some(format!("<{uid}@example.com>")),
            subject: "Flagged".into(),
            sender_name: "Jane".into(),
            sender_address: "jane@example.com".into(),
            recipients: "sam@example.com".into(),
            received_at: "2026-01-01T12:00:00Z".into(),
            preview: String::new(),
            is_read: false,
            is_starred: false,
            size: 32,
            to: vec!["sam@example.com".into()],
            cc: vec![],
            bcc: vec![],
            reply_to: None,
            thread_parent: None,
            text_body: String::new(),
            html_body: None,
            attachments: vec![],
            raw_message: b"Subject: Flagged\r\n\r\n".to_vec(),
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

    /// One account, an INBOX with one cached message. Returns (mailbox, message).
    fn seed(db: &Database) -> (i64, i64) {
        db.insert_account(&account()).unwrap();
        let mailbox = db
            .upsert_mailbox_with_source(
                ACCOUNT,
                "INBOX",
                &crate::models::MailboxRole::Inbox,
                "specialUse",
                Some(1),
                Some(10),
                None,
                1,
            )
            .unwrap();
        db.upsert_envelopes(ACCOUNT, mailbox, &[message(1)])
            .unwrap();
        let id = db.list_messages(mailbox, None, 10).unwrap().items[0].id;
        (mailbox, id)
    }

    fn color_of(db: &Database, mailbox: i64) -> u8 {
        db.list_messages(mailbox, None, 10).unwrap().items[0].flag_color
    }

    fn offline_operation_id(db: &Database, account_id: &str) -> i64 {
        db.read_conn()
            .unwrap()
            .query_row(
                "SELECT id FROM offline_ops WHERE account_id=?1 ORDER BY id LIMIT 1",
                [account_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn dismiss_failed_offline_scopes_uidvalidity_rows_and_preserves_new_arrivals() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        let mut first = account();
        first.summary.id = "first-account".into();
        let mut second = account();
        second.summary.id = "second-account".into();
        second.summary.email = "reader@example.com".into();
        let db = Database::open(&path).unwrap();
        db.insert_account(&first).unwrap();
        db.insert_account(&second).unwrap();
        let inbox = db
            .upsert_mailbox_with_source(
                &first.summary.id,
                "INBOX",
                &crate::models::MailboxRole::Inbox,
                "specialUse",
                Some(1),
                Some(1),
                Some(1),
                1,
            )
            .unwrap();
        db.upsert_envelopes(&first.summary.id, inbox, &[message(1)])
            .unwrap();
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        let old_move = serde_json::json!({
            "messageId": message_id,
            "uid": 1,
            "source": "INBOX",
            "destination": "Archive",
            "uidValidity": 1
        });
        db.queue_operation(
            &first.summary.id,
            "move",
            &old_move,
            Some(&format!("move:{message_id}")),
        )
        .unwrap();
        db.purge_stale_mailbox(&first.summary.id, "INBOX", inbox)
            .unwrap();
        db.upsert_mailbox_with_source(
            &first.summary.id,
            "INBOX",
            &crate::models::MailboxRole::Inbox,
            "specialUse",
            Some(2),
            Some(1),
            Some(1),
            1,
        )
        .unwrap();
        let first_failed_id = offline_operation_id(&db, &first.summary.id);

        db.queue_operation(
            &second.summary.id,
            "keyword",
            &serde_json::json!({ "messageId": 900, "keyword": "$Junk" }),
            Some("second-failed"),
        )
        .unwrap();
        let second_failed_id = offline_operation_id(&db, &second.summary.id);
        db.mark_operation_needs_attention(&first.summary.id, first_failed_id)
            .unwrap();
        db.mark_operation_needs_attention(&second.summary.id, second_failed_id)
            .unwrap();
        drop(db);

        let db = Database::open(&path).unwrap();
        let reviewed = db.failed_offline_operations(&first.summary.id).unwrap();
        let reviewed_operation = reviewed.items[0].clone();
        assert_eq!(reviewed.total_count, 1);
        assert_eq!(reviewed.items.len(), 1);
        assert_eq!(reviewed.items[0].id, first_failed_id);
        assert_eq!(
            reviewed.items[0].kind,
            crate::models::FailedOfflineKind::Move
        );
        assert!(db.queued_operations(&first.summary.id).unwrap().is_empty());
        let second_reviewed = db
            .failed_offline_operations(&second.summary.id)
            .unwrap()
            .items[0]
            .clone();
        assert!(db
            .dismiss_failed_offline_operations(
                &first.summary.id,
                &[crate::models::FailedOfflineOperationRef {
                    id: second_reviewed.id,
                    review_token: second_reviewed.review_token,
                }],
            )
            .is_err());

        db.queue_operation(
            &first.summary.id,
            "flags",
            &serde_json::json!({
                "messageId": 901,
                "uid": 3,
                "mailbox": "INBOX",
                "uidValidity": 2,
                "isStarred": true
            }),
            Some("new-failed"),
        )
        .unwrap();
        let new_failed_id = db
            .read_conn()
            .unwrap()
            .query_row(
                "SELECT id FROM offline_ops WHERE account_id=?1 AND dedupe_key='new-failed'",
                [&first.summary.id],
                |row| row.get(0),
            )
            .unwrap();
        db.mark_operation_needs_attention(&first.summary.id, new_failed_id)
            .unwrap();
        db.queue_operation(
            &first.summary.id,
            "copy",
            &serde_json::json!({ "messageId": 902, "source": "INBOX", "destination": "Archive" }),
            Some("new-queued"),
        )
        .unwrap();

        assert_eq!(
            db.dismiss_failed_offline_operations(
                &first.summary.id,
                &[crate::models::FailedOfflineOperationRef {
                    id: reviewed_operation.id,
                    review_token: reviewed_operation.review_token,
                }],
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.failed_offline_operations(&first.summary.id)
                .unwrap()
                .items[0]
                .id,
            new_failed_id
        );
        assert_eq!(
            db.failed_offline_operations(&second.summary.id)
                .unwrap()
                .items[0]
                .id,
            second_failed_id
        );
        assert_eq!(db.queued_operations(&first.summary.id).unwrap().len(), 1);
        assert_eq!(
            db.connection_blockers(&first.summary.id)
                .unwrap()
                .queued_changes,
            2
        );
        assert!(db.identity_change_blocked(&first.summary.id).unwrap());
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.failed_offline_operations(&first.summary.id)
                .unwrap()
                .items[0]
                .id,
            new_failed_id
        );
        assert_eq!(
            db.failed_offline_operations(&second.summary.id)
                .unwrap()
                .items[0]
                .id,
            second_failed_id
        );
    }

    #[test]
    fn dismiss_failed_offline_does_not_clear_a_newer_move_or_override_sync_flags() {
        let db = Database::memory();
        let (inbox, message_id) = seed(&db);
        let archive = db
            .upsert_mailbox_with_source(
                ACCOUNT,
                "Archive",
                &crate::models::MailboxRole::Archive,
                "specialUse",
                Some(1),
                Some(1),
                Some(0),
                0,
            )
            .unwrap();
        let trash = db
            .upsert_mailbox_with_source(
                ACCOUNT,
                "Trash",
                &crate::models::MailboxRole::Trash,
                "specialUse",
                Some(1),
                Some(1),
                Some(0),
                0,
            )
            .unwrap();
        let older = serde_json::json!({
            "messageId": message_id,
            "uid": 1,
            "source": "INBOX",
            "destination": "Archive",
            "uidValidity": 1
        });
        db.queue_operation(ACCOUNT, "move", &older, Some("older-move"))
            .unwrap();
        let old_id = offline_operation_id(&db, ACCOUNT);
        db.mark_operation_needs_attention(ACCOUNT, old_id).unwrap();
        let old_reviewed = db.failed_offline_operations(ACCOUNT).unwrap().items[0].clone();
        db.mark_pending_move(message_id, archive).unwrap();

        let newer = serde_json::json!({
            "messageId": message_id,
            "uid": 1,
            "source": "INBOX",
            "destination": "Trash",
            "uidValidity": 1
        });
        db.queue_operation(ACCOUNT, "move", &newer, None).unwrap();
        db.mark_pending_move(message_id, trash).unwrap();
        db.dismiss_failed_offline_operations(
            ACCOUNT,
            &[crate::models::FailedOfflineOperationRef {
                id: old_reviewed.id,
                review_token: old_reviewed.review_token,
            }],
        )
        .unwrap();
        assert!(db.list_messages(inbox, None, 10).unwrap().items.is_empty());
        assert_eq!(db.queued_operations(ACCOUNT).unwrap().len(), 1);

        let flags = serde_json::json!({
            "messageId": message_id,
            "uid": 1,
            "mailbox": "INBOX",
            "uidValidity": 1,
            "isRead": null,
            "isStarred": true
        });
        db.record_flag_change(ACCOUNT, message_id, None, Some(true), Some(&flags))
            .unwrap();
        let flag_id = db
            .read_conn()
            .unwrap()
            .query_row(
                "SELECT id FROM offline_ops WHERE account_id=?1 AND kind='flags'",
                [ACCOUNT],
                |row| row.get(0),
            )
            .unwrap();
        db.mark_operation_needs_attention(ACCOUNT, flag_id).unwrap();
        let flag_reviewed = db.failed_offline_operations(ACCOUNT).unwrap().items[0].clone();
        db.dismiss_failed_offline_operations(
            ACCOUNT,
            &[crate::models::FailedOfflineOperationRef {
                id: flag_reviewed.id,
                review_token: flag_reviewed.review_token,
            }],
        )
        .unwrap();
        assert!(db
            .read_conn()
            .unwrap()
            .query_row(
                "SELECT is_starred FROM messages WHERE id=?1",
                [message_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        db.reconcile_flags(inbox, &[(1, false, false)], &[])
            .unwrap();
        assert!(!db
            .read_conn()
            .unwrap()
            .query_row(
                "SELECT is_starred FROM messages WHERE id=?1",
                [message_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
    }

    #[test]
    fn color_only_server_change_is_written_by_flag_sync() {
        let db = Database::memory();
        let (mailbox, _) = seed(&db);
        db.reconcile_flags(mailbox, &[(1, false, true)], &[])
            .unwrap();
        db.reconcile_flag_colors(mailbox, &[(1, 3)]).unwrap();
        assert_eq!(color_of(&db, mailbox), 3);
        db.reconcile_flag_colors(mailbox, &[(1, 0)]).unwrap();
        assert_eq!(color_of(&db, mailbox), 0);
    }

    #[test]
    fn color_is_stored_only_when_the_mailbox_allows_keywords() {
        let db = Database::memory();
        let (mailbox, id) = seed(&db);
        db.set_mailbox_allows_keywords(mailbox, false).unwrap();
        db.record_colored_flag_change(
            ACCOUNT,
            id,
            None,
            Some(true),
            Some(ColorChange::Set(3)),
            None,
        )
        .unwrap();
        let summary = db.list_messages(mailbox, None, 10).unwrap().items[0].clone();
        assert!(summary.is_starred, "\\Flagged still applies");
        assert_eq!(summary.flag_color, 0, "no keywords means no color locally");
        db.set_mailbox_allows_keywords(mailbox, true).unwrap();
        db.record_colored_flag_change(
            ACCOUNT,
            id,
            None,
            Some(true),
            Some(ColorChange::Set(3)),
            None,
        )
        .unwrap();
        assert_eq!(color_of(&db, mailbox), 3);
    }

    #[test]
    fn clearing_a_flag_clears_its_local_color() {
        let db = Database::memory();
        let (mailbox, id) = seed(&db);
        db.record_colored_flag_change(
            ACCOUNT,
            id,
            None,
            Some(true),
            Some(ColorChange::Set(5)),
            None,
        )
        .unwrap();
        assert_eq!(color_of(&db, mailbox), 5);
        db.record_colored_flag_change(
            ACCOUNT,
            id,
            None,
            Some(false),
            Some(ColorChange::Clear),
            None,
        )
        .unwrap();
        let summary = db.list_messages(mailbox, None, 10).unwrap().items[0].clone();
        assert!(!summary.is_starred);
        assert_eq!(summary.flag_color, 0);
    }

    #[test]
    fn replayed_color_is_applied_locally_only_where_keywords_are_allowed() {
        let db = Database::memory();
        let (mailbox, id) = seed(&db);
        db.set_mailbox_allows_keywords(mailbox, false).unwrap();
        db.apply_flag_color(id, Some(ColorChange::Set(2))).unwrap();
        assert_eq!(color_of(&db, mailbox), 0);
        db.set_mailbox_allows_keywords(mailbox, true).unwrap();
        db.apply_flag_color(id, Some(ColorChange::Set(2))).unwrap();
        assert_eq!(color_of(&db, mailbox), 2);
        db.apply_flag_color(id, None).unwrap();
        assert_eq!(color_of(&db, mailbox), 2, "no change op leaves color alone");
    }

    #[test]
    fn plain_star_ops_keep_their_historical_dedupe_key() {
        let plain = serde_json::json!({ "isRead": null, "isStarred": true, "flagColor": null });
        assert_eq!(
            flag_dedupe_key(7, false, true, &plain),
            "flags:7:false:true"
        );
        let colored = serde_json::json!({ "isRead": null, "isStarred": true, "flagColor": 4 });
        assert_eq!(
            flag_dedupe_key(7, false, true, &colored),
            "flags:7:false:true:c4"
        );
        let legacy = serde_json::json!({ "isRead": true, "isStarred": null });
        assert_eq!(
            flag_dedupe_key(7, true, false, &legacy),
            "flags:7:true:false"
        );
    }

    #[test]
    fn dismiss_failed_offline_rejects_replaced_dedupe_generation_atomically() {
        let db = Database::memory();
        seed(&db);
        let original = serde_json::json!({"messageId": 1, "destination": "Archive"});
        db.queue_operation(ACCOUNT, "move", &original, Some("same-dedupe"))
            .unwrap();
        let reviewed_id = offline_operation_id(&db, ACCOUNT);
        db.mark_operation_needs_attention(ACCOUNT, reviewed_id)
            .unwrap();
        let old_review = db.failed_offline_operations(ACCOUNT).unwrap().items[0].clone();

        let replacement = serde_json::json!({"messageId": 2, "destination": "Trash"});
        db.queue_operation(ACCOUNT, "move", &replacement, Some("same-dedupe"))
            .unwrap();
        db.mark_operation_needs_attention(ACCOUNT, reviewed_id)
            .unwrap();
        let current_review = db.failed_offline_operations(ACCOUNT).unwrap().items[0].clone();
        assert_eq!(current_review.id, old_review.id);
        assert_ne!(current_review.review_token, old_review.review_token);

        db.queue_operation(
            ACCOUNT,
            "keyword",
            &serde_json::json!({"messageId": 3, "keyword": "$Junk"}),
            Some("second-dedupe"),
        )
        .unwrap();
        let second_id = db
            .read_conn()
            .unwrap()
            .query_row(
                "SELECT id FROM offline_ops WHERE account_id=?1 AND dedupe_key='second-dedupe'",
                [ACCOUNT],
                |row| row.get(0),
            )
            .unwrap();
        db.mark_operation_needs_attention(ACCOUNT, second_id)
            .unwrap();
        let second_review = db
            .failed_offline_operations(ACCOUNT)
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.id == second_id)
            .unwrap();

        let stale = crate::models::FailedOfflineOperationRef {
            id: old_review.id,
            review_token: old_review.review_token,
        };
        let current = crate::models::FailedOfflineOperationRef {
            id: current_review.id,
            review_token: current_review.review_token,
        };
        let second = crate::models::FailedOfflineOperationRef {
            id: second_review.id,
            review_token: second_review.review_token,
        };
        assert!(db
            .dismiss_failed_offline_operations(ACCOUNT, &[stale, second.clone()])
            .is_err());
        assert_eq!(
            db.failed_offline_operations(ACCOUNT).unwrap().total_count,
            2,
            "a stale member must prevent partial cleanup of the valid selection"
        );
        assert_eq!(
            db.dismiss_failed_offline_operations(ACCOUNT, &[current])
                .unwrap(),
            1
        );
        assert_eq!(
            db.failed_offline_operations(ACCOUNT).unwrap().items[0].id,
            second.id
        );
    }

    #[test]
    fn dismiss_failed_offline_rejects_reused_deleted_id() {
        let db = Database::memory();
        seed(&db);
        db.queue_operation(
            ACCOUNT,
            "keyword",
            &serde_json::json!({"messageId": 1, "keyword": "$Junk"}),
            Some("deleted-id"),
        )
        .unwrap();
        let reviewed_id = offline_operation_id(&db, ACCOUNT);
        db.mark_operation_needs_attention(ACCOUNT, reviewed_id)
            .unwrap();
        let old_review = db.failed_offline_operations(ACCOUNT).unwrap().items[0].clone();
        db.remove_operation(ACCOUNT, reviewed_id).unwrap();

        db.queue_operation(
            ACCOUNT,
            "flags",
            &serde_json::json!({"messageId": 2, "isStarred": true}),
            Some("replacement-id"),
        )
        .unwrap();
        let replacement_id = offline_operation_id(&db, ACCOUNT);
        assert_eq!(replacement_id, reviewed_id);
        db.mark_operation_needs_attention(ACCOUNT, replacement_id)
            .unwrap();
        let current_review = db.failed_offline_operations(ACCOUNT).unwrap().items[0].clone();
        assert_ne!(current_review.review_token, old_review.review_token);

        assert!(db
            .dismiss_failed_offline_operations(
                ACCOUNT,
                &[crate::models::FailedOfflineOperationRef {
                    id: old_review.id,
                    review_token: old_review.review_token,
                }],
            )
            .is_err());
        assert_eq!(
            db.failed_offline_operations(ACCOUNT).unwrap().items.len(),
            1
        );
        assert_eq!(
            db.failed_offline_operations(ACCOUNT).unwrap().items[0].review_token,
            current_review.review_token
        );
    }
}
