use super::{
    db_error, map_message_summary, replace_attachment_refs, Database, MESSAGE_SUMMARY_SELECT,
};
use crate::outbox_reason::OutboxReason;
use rusqlite::{params, OptionalExtension};

use crate::models::{ComposeDraft, FilterMatchPreview, FilterRule, OutboxSummary, SnoozedSummary};

/// Failed sends are preserved for an explicit user retry, but the outbox does
/// not silently grow without bound: once this many messages (or bytes of
/// stored MIME) need attention, new sends queue behind a user decision.
const MAX_NEEDS_ATTENTION_OUTBOX_MESSAGES: i64 = 25;
const MAX_NEEDS_ATTENTION_OUTBOX_BYTES: i64 = 256 * 1024 * 1024;
/// Bytes of stored MIME one account may have waiting to go out across queued,
/// scheduled, and needs-attention rows. The stricter needs-attention caps
/// cover the parked subset; this bounds the whole waiting backlog.
const MAX_PENDING_OUTBOX_BYTES: i64 = 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct OutboxArchiveSource {
    pub message_id: i64,
    pub source_mailbox_id: i64,
    pub current_mailbox_id: Option<i64>,
    pub pending_move_to: Option<i64>,
}

enum StoredDetail<'a> {
    Legacy(Option<&'a str>),
    Reason(Option<OutboxReason>),
}

impl<'a> StoredDetail<'a> {
    fn parts(self) -> (Option<&'static str>, Option<&'a str>) {
        let (reason, legacy) = match self {
            Self::Legacy(detail) => (detail.and_then(OutboxReason::from_legacy), detail),
            Self::Reason(reason) => (reason, None),
        };
        (
            reason.map(OutboxReason::code),
            if reason.is_some() { None } else { legacy },
        )
    }
}

database_operations! {
impl Database {
    pub fn outbox_archive_source(
        &self,
        id: &str,
        account_id: &str,
    ) -> Result<Option<OutboxArchiveSource>, String> {
        self.conn()?
            .query_row(
                "SELECT o.archive_message_id,o.archive_source_mailbox_id,m.mailbox_id,m.pending_move_to
                 FROM outbox o LEFT JOIN messages m ON m.id=o.archive_message_id AND m.account_id=o.account_id
                 WHERE o.id=?1 AND o.account_id=?2",
                params![id, account_id],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)
            .and_then(|row| match row {
                Some((Some(message_id), Some(source_mailbox_id), current_mailbox_id, pending_move_to)) => {
                    Ok(Some(OutboxArchiveSource {
                        message_id,
                        source_mailbox_id,
                        current_mailbox_id,
                        pending_move_to,
                    }))
                }
                Some((None, None, _, _)) => Ok(None),
                Some(_) => Err("The queued archive source could not be read.".into()),
                None => Err("Queued message not found.".into()),
            })
    }
    #[allow(dead_code)]
    pub fn queue_outbox(
        &self,
        draft: &ComposeDraft,
        state: &str,
        detail: Option<&str>,
        message_id: &str,
        mime_bytes: &[u8],
        send_at: Option<&str>,
    ) -> Result<String, String> {
        self.queue_outbox_with_archive(draft, state, detail, message_id, mime_bytes, send_at, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn queue_outbox_with_reason(
        &self, draft: &ComposeDraft, state: &str, reason: Option<OutboxReason>,
        message_id: &str, mime_bytes: &[u8], send_at: Option<&str>, archive_source: Option<(i64, i64)>,
    ) -> Result<String, String> {
        self.queue_outbox_with_archive(draft, state, reason.map(OutboxReason::message), message_id, mime_bytes, send_at, archive_source)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn queue_outbox_with_archive(
        &self,
        draft: &ComposeDraft,
        state: &str,
        detail: Option<&str>,
        message_id: &str,
        mime_bytes: &[u8],
        send_at: Option<&str>,
        archive_source: Option<(i64, i64)>,
    ) -> Result<String, String> {
        let (reason, detail) = StoredDetail::Legacy(detail).parts();
        let id = uuid::Uuid::new_v4().to_string();
        let json =
            serde_json::to_string(draft).map_err(|_| "Could not queue message.".to_string())?;
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        if let Some(source_id) = draft.id.as_deref() {
            super::drafts::ensure_draft_queueable(
                &transaction,
                source_id,
                &draft.account_id,
            )?;
        }
        let (terminal_count, terminal_bytes): (i64, i64) = transaction
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(mime_bytes)),0) FROM outbox
                 WHERE account_id=?1 AND state='needs_attention'",
                [&draft.account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        if terminal_count >= MAX_NEEDS_ATTENTION_OUTBOX_MESSAGES
            || terminal_bytes >= MAX_NEEDS_ATTENTION_OUTBOX_BYTES
        {
            return Err(
                "Messages in the outbox need attention. Retry or delete them before sending more."
                    .into(),
            );
        }
        // Same backlog idea across every waiting state, so nothing parked does
        // not mean nothing bounded: the queued and scheduled stores still stop
        // growing once this many MIME bytes already wait to leave.
        if pending_sends_denied(pending_outbox_bytes(&transaction, &draft.account_id)?) {
            return Err(
                "The sending queue is at its size limit. Retry or delete waiting messages before sending more."
                    .into(),
            );
        }
        transaction
            .execute(
                "INSERT INTO outbox(id,account_id,draft_json,state,detail,message_id,mime_bytes,send_at,updated_at,archive_message_id,archive_source_mailbox_id,reason_code)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,CURRENT_TIMESTAMP,?9,?10,?11)",
                params![
                    id,
                    draft.account_id,
                    json,
                    state,
                    detail,
                    message_id,
                    mime_bytes,
                    send_at,
                    archive_source.map(|source| source.0),
                    archive_source.map(|source| source.1),
                    reason,
                ],
            )
            .map_err(db_error)?;
        replace_attachment_refs(
            &transaction,
            &draft.account_id,
            "outbox",
            &id,
            &draft.attachments,
        )?;
        if let Some(source_id) = draft.id.as_deref() {
            super::drafts::retire_outbox_source_draft_in_transaction(
                &transaction,
                source_id,
                &draft.account_id,
            )?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(id)
    }

    #[allow(dead_code)]
    pub fn set_outbox_state(&self, id: &str, account_id: &str, state: &str, detail: Option<&str>) -> Result<bool, String> {
        self.write_outbox_state(id, account_id, state, StoredDetail::Legacy(detail), false)
    }

    pub fn set_outbox_reason(&self, id: &str, account_id: &str, state: &str, reason: Option<OutboxReason>) -> Result<bool, String> {
        self.write_outbox_state(id, account_id, state, StoredDetail::Reason(reason), false)
    }

    /// Commit confirmed delivery before any follow-up network operation.
    pub fn set_outbox_reason_durable(&self, id: &str, account_id: &str, state: &str, reason: Option<OutboxReason>) -> Result<bool, String> {
        self.write_outbox_state(id, account_id, state, StoredDetail::Reason(reason), true)
    }

    fn write_outbox_state(&self, id: &str, account_id: &str, state: &str, detail: StoredDetail<'_>, durable: bool) -> Result<bool, String> {
        let (reason, legacy) = detail.parts();
        let conn = self.conn()?;
        if durable { conn.pragma_update(None, "synchronous", "FULL").map_err(db_error)?; }
        let changed = conn.execute(
            "UPDATE outbox SET state=?3,detail=?4,reason_code=?5,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND account_id=?2",
            params![id, account_id, state, legacy, reason],
        );
        let restored = if durable { conn.pragma_update(None, "synchronous", "NORMAL") } else { Ok(()) };
        let changed = changed.map_err(db_error)?;
        restored.map_err(db_error)?;
        Ok(changed == 1)
    }

    pub fn remove_outbox(&self, id: &str, account_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let changed = transaction
            .execute(
                "DELETE FROM outbox WHERE id=?1 AND account_id=?2",
                params![id, account_id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("Queued message not found.".into());
        }
        transaction
            .execute(
                "DELETE FROM attachment_refs WHERE owner_kind='outbox' AND owner_id=?1",
                [id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn list_outbox(&self, account_id: &str) -> Result<Vec<OutboxSummary>, String> {
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id,draft_json,state,detail,created_at,send_at,reason_code FROM outbox WHERE account_id=?1 ORDER BY created_at DESC",
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
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows.into_iter()
            .map(|(id, json, state, detail, created_at, send_at, reason_code)| {
                let detail = reason_code.as_deref().and_then(OutboxReason::from_code).map(|reason| reason.message().to_string()).or(detail);
                let draft: ComposeDraft = serde_json::from_str(&json)
                    .map_err(|_| "A queued message could not be read.".to_string())?;
                Ok(OutboxSummary {
                    id,
                    account_id: account_id.to_string(),
                    recipients: draft.to.join(", "),
                    subject: draft.subject,
                    state,
                    detail,
                    reason_code,
                    created_at,
                    send_at,
                    preview: super::drafts::draft_preview(&draft.text_body, &draft.html_body),
                    attachment_count: super::drafts::draft_file_count(&draft.attachments),
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
        let mut draft: ComposeDraft = serde_json::from_str(&row.0)
            .map_err(|_| "This queued message could not be read.".to_string())?;
        draft.html_body = crate::html_sanitize::sanitize_compose_html(&draft.html_body);
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

    /// Retire a legacy editable source only when its saved content still
    /// matches the snapshot that was delivered.
    pub fn finalize_outbox_source_draft(
        &self,
        id: &str,
        account_id: &str,
    ) -> Result<bool, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let queued_json: Option<String> = transaction
            .query_row(
                "SELECT draft_json FROM outbox WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let Some(queued_json) = queued_json else {
            return Ok(false);
        };
        let queued: ComposeDraft = serde_json::from_str(&queued_json)
            .map_err(|_| "This queued message could not be read.".to_string())?;
        if queued.account_id != account_id {
            return Err("Queued message does not belong to this account.".into());
        }
        let Some(source_id) = queued.id.as_deref() else {
            return Ok(false);
        };
        let source: Option<(String, String, Option<String>)> = transaction
            .query_row(
                "SELECT account_id,draft_json,deleted_at FROM drafts WHERE id=?1",
                [source_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db_error)?;
        let Some((owner, current_json, deleted_at)) = source else {
            return Ok(false);
        };
        if owner != account_id {
            return Err("Draft does not belong to this account.".into());
        }
        if deleted_at.is_some() || !same_draft_content(&queued, &current_json)? {
            return Ok(false);
        }
        let changed = super::drafts::retire_outbox_source_draft_in_transaction(
            &transaction,
            source_id,
            account_id,
        )?;
        transaction.commit().map_err(db_error)?;
        Ok(changed)
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

    /// Queued rows whose retry wait has passed, oldest first.
    pub fn due_queued_outbox_ids(&self, account_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id FROM outbox WHERE account_id=?1 AND state='queued'
                 AND (retry_after IS NULL OR retry_after<=strftime('%Y-%m-%dT%H:%M:%S+00:00','now'))
                 ORDER BY created_at",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    /// Record a definite "try later" reply and wait 1, 2, 4… up to 60 minutes
    /// before the next automatic try. False once `max_attempts` is spent.
    /// SQLite evaluates the SET expressions against the pre-update row, so the
    /// first try reads `retry_attempts=0` and waits one minute.
    pub fn defer_outbox_retry(
        &self,
        id: &str,
        account_id: &str,
        max_attempts: u32,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE outbox SET retry_attempts=retry_attempts+1,
             retry_after=strftime('%Y-%m-%dT%H:%M:%S+00:00','now',
               '+' || MIN(60, 1 << MIN(retry_attempts, 6)) || ' minutes')
             WHERE id=?1 AND account_id=?2",
            params![id, account_id],
        )
        .map_err(db_error)?;
        let attempts: u32 = conn
            .query_row(
                "SELECT retry_attempts FROM outbox WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .unwrap_or(u32::MAX);
        Ok(attempts < max_attempts)
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

    /// Snooze every id, or none of them. A missing or foreign message rolls back.
    pub fn snooze_messages(
        &self,
        account_id: &str,
        message_ids: &[i64],
        until_iso: &str,
    ) -> Result<(), String> {
        if message_ids.is_empty() {
            return Err("Choose a message to snooze.".into());
        }
        if message_ids.len() > 200 {
            return Err("Select up to 200 messages at a time.".into());
        }
        let mut unique = Vec::new();
        for id in message_ids {
            if !unique.contains(id) {
                unique.push(*id);
            }
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        for id in unique {
            let owner: Option<String> = transaction
                .query_row("SELECT account_id FROM messages WHERE id=?1", [id], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(db_error)?;
            if owner.as_deref() != Some(account_id) {
                return Err("Message does not belong to this account.".into());
            }
            transaction
                .execute(
                    "INSERT INTO snoozed_messages(account_id,message_id,snoozed_until)
                     VALUES(?1,?2,?3)
                     ON CONFLICT(account_id,message_id) DO UPDATE SET snoozed_until=excluded.snoozed_until",
                    params![account_id, id, until_iso],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
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
        let conn = self.read_conn()?;
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

    /// Persist rule order. `ordered_ids` must list this account's rules once.
    pub fn reorder_filter_rules(
        &self,
        account_id: &str,
        ordered_ids: &[String],
    ) -> Result<Vec<FilterRule>, String> {
        let existing = self.list_filter_rules(account_id)?;
        let have: std::collections::HashSet<&str> =
            existing.iter().map(|rule| rule.id.as_str()).collect();
        let requested: std::collections::HashSet<&str> =
            ordered_ids.iter().map(String::as_str).collect();
        if requested.len() != ordered_ids.len() || requested != have {
            return Err("Rule order is invalid.".into());
        }
        {
            let mut conn = self.conn()?;
            let transaction = conn.transaction().map_err(db_error)?;
            for (position, id) in ordered_ids.iter().enumerate() {
                transaction
                    .execute(
                        "UPDATE filter_rules SET position=?3 WHERE id=?1 AND account_id=?2",
                        params![id, account_id, position as i64],
                    )
                    .map_err(db_error)?;
            }
            transaction.commit().map_err(db_error)?;
        }
        self.list_filter_rules(account_id)
    }

    /// Unread inbox candidates for one rule. Bounded so a broad match cannot
    /// flood the offline queue. `newer_than_id` limits evaluation to rows
    /// cached by the current sync pass.
    pub fn find_rule_matches(
        &self,
        account_id: &str,
        rule: &FilterRule,
        newer_than_id: Option<i64>,
    ) -> Result<Vec<(i64, u32, String, i64)>, String> {
        let Some(pattern) = rule_match_pattern(rule) else {
            return Ok(Vec::new());
        };
        let conn = self.read_conn()?;
        let condition = rule_match_condition(&pattern, RuleMatchQuery::Find);
        let (primary, domain_like) = rule_match_params(&pattern);
        let mut statement = conn
            .prepare(&format!(
                "SELECT m.id,m.uid,f.name,f.id FROM messages m JOIN mailboxes f ON f.id=m.mailbox_id
                 WHERE m.account_id=?1 AND f.role='inbox' AND m.is_read=0 AND m.pending_move_to IS NULL
                 AND (?3 IS NULL OR m.id > ?3)
                 AND {condition}
                 ORDER BY m.uid DESC LIMIT 100"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map(
                params![account_id, primary, newer_than_id, domain_like],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    /// Same unread Inbox scan as filing, without changing mail.
    pub fn preview_rule_matches(
        &self,
        account_id: &str,
        rule: &FilterRule,
    ) -> Result<FilterMatchPreview, String> {
        let Some(pattern) = rule_match_pattern(rule) else {
            return Ok(FilterMatchPreview {
                matched: 0,
                capped: false,
                subjects: Vec::new(),
            });
        };
        let conn = self.conn()?;
        let condition = rule_match_condition(&pattern, RuleMatchQuery::Preview);
        let (primary, domain_like) = rule_match_params(&pattern);
        let mut statement = conn
            .prepare(&format!(
                "SELECT m.subject FROM messages m JOIN mailboxes f ON f.id=m.mailbox_id
                 WHERE m.account_id=?1 AND f.role='inbox' AND m.is_read=0 AND m.pending_move_to IS NULL
                 AND {condition}
                 ORDER BY m.uid DESC LIMIT 100"
            ))
            .map_err(db_error)?;
        let subjects = statement
            .query_map(params![account_id, primary, domain_like], |row| {
                row.get::<_, String>(0)
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let capped = subjects.len() == 100;
        Ok(FilterMatchPreview {
            matched: subjects.len() as u32,
            capped,
            subjects: subjects.into_iter().take(5).map(preview_subject).collect(),
        })
    }

    pub fn list_snoozed(&self, account_id: &str, now: &str) -> Result<Vec<SnoozedSummary>, String> {
        self.prune_expired_snoozes(account_id, now)?;
        let conn = self.read_conn()?;
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
                    snoozed_until: row.get("snoozed_until")?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    /// Earliest `send_at` among held or scheduled messages, so the account
    /// worker can wake exactly when the next one is due.
    pub fn next_scheduled_send_at(&self, account_id: &str) -> Result<Option<String>, String> {
        self.conn()?
            .query_row(
                "SELECT MIN(send_at) FROM outbox WHERE account_id=?1 AND state='scheduled' AND send_at IS NOT NULL",
                [account_id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }

    /// Move one row from `from_state` to `sending`. `from_state` must be the
    /// state the caller checked under the account lock: accepting any
    /// sendable state would let a stale caller resend a message another
    /// delivery just left in `needs_attention`.
    pub fn claim_outbox_delivery(
        &self,
        id: &str,
        account_id: &str,
        from_state: &str,
    ) -> Result<bool, String> {
        if !matches!(from_state, "queued" | "scheduled" | "needs_attention") {
            return Ok(false);
        }
        let conn = self.conn()?;
        // The database runs with synchronous=NORMAL for sync throughput. This
        // one commit must survive power loss: rolling back to `queued` would
        // let a restart resend a message SMTP may already have accepted.
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(db_error)?;
        let changed = conn.execute(
            "UPDATE outbox SET state='sending',updated_at=CURRENT_TIMESTAMP,
                 retry_after=NULL,
                 retry_attempts=CASE WHEN ?3='needs_attention' THEN 0 ELSE retry_attempts END
                 WHERE id=?1 AND account_id=?2 AND state=?3",
            params![id, account_id, from_state],
        );
        let restored = conn.pragma_update(None, "synchronous", "NORMAL");
        let changed = changed.map_err(db_error)?;
        restored.map_err(db_error)?;
        Ok(changed == 1)
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
                // Only rows with nothing to send yet are touched; a retry of
                // prepared content must neither clobber nor regenerate the
                // exact MIME that already reached SMTP once.
                "UPDATE outbox SET message_id=?3,mime_bytes=?4,updated_at=CURRENT_TIMESTAMP
                 WHERE id=?1 AND account_id=?2
                 AND state IN ('queued','scheduled','needs_attention')
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

    pub fn dismiss_archive_warning(&self, id: &str, account_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let changed = transaction
            .execute(
                "DELETE FROM outbox WHERE id=?1 AND account_id=?2 AND state='archive_pending'",
                params![id, account_id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("Post-send archive warning not found.".into());
        }
        transaction
            .execute(
                "DELETE FROM attachment_refs WHERE owner_kind='outbox' AND owner_id=?1",
                [id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    /// Restore queued content as a local draft before removing its outbox row.
    /// Both writes share one transaction so a crash cannot lose the only copy.
    pub fn restore_outbox_as_draft(
        &self,
        id: &str,
        account_id: &str,
    ) -> Result<ComposeDraft, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let (json, state, archive_message_id, archive_source_mailbox_id):
            (String, String, Option<i64>, Option<i64>) = transaction
            .query_row(
                "SELECT draft_json,state,archive_message_id,archive_source_mailbox_id FROM outbox WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Queued message not found.".to_string())?;
        if state == "sending" {
            return Err("This message is already sending and cannot be stopped.".into());
        }
        if !matches!(state.as_str(), "scheduled" | "queued" | "needs_attention") {
            return Err("This message cannot be restored.".into());
        }
        let mut draft: ComposeDraft = serde_json::from_str(&json)
            .map_err(|_| "This queued message could not be read.".to_string())?;
        if draft.account_id != account_id {
            return Err("Queued message does not belong to this account.".into());
        }
        draft.html_body = crate::html_sanitize::sanitize_compose_html(&draft.html_body);
        if let (Some(message_id), Some(source_mailbox_id)) =
            (archive_message_id, archive_source_mailbox_id)
        {
            super::cancel_pending_move_in_transaction(
                &transaction,
                account_id,
                message_id,
                source_mailbox_id,
            )?;
        }
        if let Some(source_id) = draft.id.as_deref() {
            let source: Option<(String, String, Option<u32>, Option<String>)> = transaction
                .query_row(
                    "SELECT account_id,draft_json,remote_uid,deleted_at FROM drafts WHERE id=?1",
                    [source_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(db_error)?;
            if let Some((owner, current_json, _, deleted_at)) = source {
                if owner != account_id {
                    return Err("Draft does not belong to this account.".into());
                }
                if deleted_at.is_none() {
                    let current: ComposeDraft = serde_json::from_str(&current_json)
                        .map_err(|_| "This saved draft could not be read.".to_string())?;
                    if !same_draft_content(&draft, &current_json)? {
                        let mut newer_copy = current;
                        newer_copy.id = None;
                        super::drafts::save_draft_in_transaction(&transaction, &newer_copy)?;
                    }
                    super::drafts::retire_outbox_source_draft_in_transaction(
                        &transaction,
                        source_id,
                        account_id,
                    )?;
                }
            }
            // Restored content gets a fresh identity. The retired ID remains
            // reserved so an in-flight autosave cannot overwrite Undo/Edit.
            draft.id = None;
        }
        let draft_id = super::drafts::save_draft_in_transaction(&transaction, &draft)?;
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
        draft.id = Some(draft_id);
        Ok(draft)
    }
}
}

fn same_draft_content(queued: &ComposeDraft, current_json: &str) -> Result<bool, String> {
    let current: ComposeDraft = serde_json::from_str(current_json)
        .map_err(|_| "This saved draft could not be read.".to_string())?;
    let queued =
        serde_json::to_value(queued).map_err(|_| "Could not read queued message.".to_string())?;
    let current =
        serde_json::to_value(current).map_err(|_| "Could not read saved draft.".to_string())?;
    Ok(queued == current)
}

/// Stored MIME bytes waiting to leave one account: queued, scheduled, or
/// parked for attention. Pure accounting over the outbox table.
fn pending_outbox_bytes(conn: &rusqlite::Connection, account_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(mime_bytes)),0) FROM outbox
         WHERE account_id=?1 AND state IN ('queued','scheduled','needs_attention')",
        [account_id],
        |row| row.get(0),
    )
    .map_err(db_error)
}

/// Only an already-at-cap backlog blocks a new send. The incoming message is
/// not charged: parking normal-sized sends for a byte test would strand mail
/// behind the limits in queue_outbox_with_archive.
fn pending_sends_denied(pending_bytes: i64) -> bool {
    pending_bytes >= MAX_PENDING_OUTBOX_BYTES
}

enum RuleMatchPattern {
    ColumnLike {
        column: &'static str,
        like: String,
        domain_like: String,
    },
    ToAddressExact {
        address: String,
    },
}

enum RuleMatchQuery {
    Find,
    Preview,
}

const RULE_MATCH_TO_ADDRESS_EXACT: &str = "(
                   EXISTS (
                     SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) AS addr
                     WHERE lower(addr.value)=?2
                   )
                   OR EXISTS (
                     SELECT 1 FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) AS addr
                     WHERE lower(addr.value)=?2
                   )
                 )";

fn rule_match_params(pattern: &RuleMatchPattern) -> (String, String) {
    match pattern {
        RuleMatchPattern::ColumnLike {
            like, domain_like, ..
        } => (like.clone(), domain_like.clone()),
        RuleMatchPattern::ToAddressExact { address } => (address.clone(), String::new()),
    }
}

fn rule_match_condition(pattern: &RuleMatchPattern, query: RuleMatchQuery) -> String {
    let domain_param = match query {
        RuleMatchQuery::Find => "?4",
        RuleMatchQuery::Preview => "?3",
    };
    match pattern {
        RuleMatchPattern::ToAddressExact { .. } => format!(
            "({RULE_MATCH_TO_ADDRESS_EXACT} AND LENGTH({domain_param}) >= 0)"
        ),
        RuleMatchPattern::ColumnLike { column, .. } => format!(
            "(
                   LOWER({column}) LIKE ?2 ESCAPE '\\'
                   OR (LENGTH({domain_param}) > 0 AND LOWER(m.sender_address) LIKE {domain_param} ESCAPE '\\')
                 )"
        ),
    }
}

fn rule_match_pattern(rule: &FilterRule) -> Option<RuleMatchPattern> {
    let trimmed = rule.contains.trim();
    let lowered = trimmed.to_ascii_lowercase();
    let needle: String = lowered
        .chars()
        .flat_map(|character| match character {
            '\\' => vec!['\\', '\\'],
            '%' => vec!['\\', '%'],
            '_' => vec!['\\', '_'],
            other => vec![other],
        })
        .collect();
    if needle.is_empty() {
        return None;
    }
    if rule.field == "domain" {
        if !crate::models::valid_sender_domain(trimmed) {
            return None;
        }
        return Some(RuleMatchPattern::ColumnLike {
            column: "m.sender_address",
            like: format!("%@{needle}"),
            domain_like: format!("%@%.{needle}"),
        });
    }
    if rule.field == "from" && is_full_address(trimmed) {
        // Exact address: no wildcards, so "me@x.io" never hits "me@x.io.com".
        return Some(RuleMatchPattern::ColumnLike {
            column: "m.sender_address",
            like: needle,
            domain_like: String::new(),
        });
    }
    if rule.field == "to" && is_full_address(trimmed) {
        return Some(RuleMatchPattern::ToAddressExact { address: lowered });
    }
    let column = match rule.field.as_str() {
        "subject" => "m.subject",
        "to" => "m.recipients",
        "from" => "(m.sender_name || ' ' || m.sender_address)",
        _ => return None,
    };
    Some(RuleMatchPattern::ColumnLike {
        column,
        like: format!("%{needle}%"),
        domain_like: String::new(),
    })
}

/// One bare `local@domain.tld`: one '@', non-empty local part, dotted domain, no spaces.
fn is_full_address(value: &str) -> bool {
    if value.contains(char::is_whitespace) || value.matches('@').count() != 1 {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn preview_subject(value: String) -> String {
    let mut subject = String::new();
    let mut pending_space = false;
    for character in value.trim().chars() {
        if character.is_control() || character.is_whitespace() {
            pending_space = !subject.is_empty();
            continue;
        }
        if pending_space {
            if subject.chars().count() + 1 >= 80 {
                break;
            }
            subject.push(' ');
            pending_space = false;
        }
        if subject.chars().count() == 80 {
            break;
        }
        subject.push(character);
    }
    subject
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CachedMessage;
    use crate::models::{
        AccountRecord, AccountSummary, BodyFormat, ComposeDraft, FilterRule, MailboxRole,
        ProviderKind, ServerConfig, TlsMode,
    };
    use std::collections::HashSet;

    fn account() -> AccountRecord {
        AccountRecord {
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
        }
    }

    fn with_account() -> (Database, String) {
        let database = Database::memory();
        let account = account();
        database.insert_account(&account).unwrap();
        (database, account.summary.id.clone())
    }

    fn draft() -> ComposeDraft {
        ComposeDraft {
            body_format: BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            include_signature: true,
            importance: String::new(),
            request_receipt: false,
            reply_to: None,
            id: None,
            account_id: "account-1".into(),
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
            send_at: None,
        }
    }

    fn draft_with_id(db: &Database, account_id: &str) -> ComposeDraft {
        let mut draft = draft();
        draft.account_id = account_id.to_string();
        let id = db.save_draft(&draft).unwrap();
        draft.id = Some(id);
        draft
    }

    fn add_second_account(db: &Database) -> String {
        let mut second = account();
        second.summary.id = "account-2".into();
        second.summary.email = "lee@example.com".into();
        second.summary.display_name = "Lee".into();
        second.imap.username = "lee@example.com".into();
        second.smtp.username = "lee@example.com".into();
        db.insert_account(&second).unwrap();
        second.summary.id
    }

    fn add_attachment(db: &Database, account_id: &str, draft: &mut ComposeDraft, token: &str) {
        db.conn()
            .unwrap()
            .execute(
                "INSERT INTO file_grants(token,account_id,path,size) VALUES(?1,?2,'/tmp/attachment.txt',4)",
                params![token, account_id],
            )
            .unwrap();
        draft.attachments.push(crate::models::ComposeAttachment {
            token: token.into(),
            filename: "attachment.txt".into(),
            content_type: Some("text/plain".into()),
            inline: false,
            content_id: None,
            size: Some(4),
        });
    }

    fn insert_legacy_outbox(db: &Database, draft: &ComposeDraft, state: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let json = serde_json::to_string(draft).unwrap();
        db.conn()
            .unwrap()
            .execute(
                "INSERT INTO outbox(id,account_id,draft_json,state,message_id,mime_bytes,updated_at)
                 VALUES(?1,?2,?3,?4,'<legacy@example.test>',X'6D696D65',CURRENT_TIMESTAMP)",
                params![id, draft.account_id, json, state],
            )
            .unwrap();
        id
    }

    #[test]
    fn queue_atomically_owns_draft_and_rejects_stale_saves_or_requeues() {
        let (db, account_id) = with_account();
        for (index, state) in ["queued", "scheduled", "needs_attention"]
            .into_iter()
            .enumerate()
        {
            let mut source = draft_with_id(&db, &account_id);
            source.subject = format!("Queued source {index}");
            if state == "scheduled" {
                source.send_at = Some("2099-01-01T00:00:00Z".into());
            }
            let id = source.id.clone().unwrap();
            let token = format!("attachment-{index}");
            add_attachment(&db, &account_id, &mut source, &token);
            db.save_draft(&source).unwrap();

            let outbox_id = db
                .queue_outbox(&source, state, None, "<queued@example.test>", b"mime", None)
                .unwrap();

            assert!(
                db.draft(&id, &account_id).is_err(),
                "{state} left source editable"
            );
            assert!(!db
                .list_drafts(&account_id)
                .unwrap()
                .iter()
                .any(|item| item.id == id));
            let mut stale = source.clone();
            stale.subject = "Late autosave must not resurrect the source".into();
            assert!(
                db.save_draft(&stale).is_err(),
                "{state} accepted stale autosave"
            );
            assert!(
                db.queue_outbox(
                    &stale,
                    state,
                    None,
                    "<duplicate@example.test>",
                    b"mime",
                    None
                )
                .is_err(),
                "{state} accepted duplicate queueing by source ID"
            );

            let owners = db
                .conn()
                .unwrap()
                .prepare("SELECT owner_kind,owner_id FROM attachment_refs WHERE token=?1")
                .unwrap()
                .query_map([&token], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(owners, vec![("outbox".into(), outbox_id)]);
        }
    }

    #[test]
    fn queue_rejects_a_draft_id_owned_by_another_account() {
        let (db, account_id) = with_account();
        let second_account = add_second_account(&db);
        let source = draft_with_id(&db, &account_id);
        let mut cross_account = source.clone();
        cross_account.account_id = second_account.clone();

        assert!(db
            .queue_outbox(
                &cross_account,
                "scheduled",
                None,
                "<cross-account@example.test>",
                b"mime",
                Some("2099-01-01T00:00:00Z"),
            )
            .is_err());
        assert!(db.draft(source.id.as_deref().unwrap(), &account_id).is_ok());
        assert!(db.list_outbox(&second_account).unwrap().is_empty());
    }

    #[test]
    fn restore_transfers_local_attachment_ownership_and_releases_source_reservation() {
        let (db, account_id) = with_account();
        let mut source = draft_with_id(&db, &account_id);
        let token = "restore-attachment";
        add_attachment(&db, &account_id, &mut source, token);
        db.save_draft(&source).unwrap();
        let source_id = source.id.clone().unwrap();
        let outbox_id = db
            .queue_outbox(
                &source,
                "scheduled",
                None,
                "<restore@example.test>",
                b"mime",
                Some("2099-01-01T00:00:00Z"),
            )
            .unwrap();

        let restored = db.restore_outbox_as_draft(&outbox_id, &account_id).unwrap();
        let restored_id = restored.id.clone().unwrap();
        assert_ne!(restored_id, source_id);
        assert!(db.outbox(&outbox_id, &account_id).is_err());
        assert!(db.draft(&source_id, &account_id).is_err());
        assert!(db.draft(&restored_id, &account_id).is_ok());
        let owners = db
            .conn()
            .unwrap()
            .prepare("SELECT owner_kind,owner_id FROM attachment_refs WHERE token=?1")
            .unwrap()
            .query_map([token], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(owners, vec![("draft".into(), restored_id.clone())]);

        let mut edited = restored;
        edited.subject = "Explicitly edited after Undo".into();
        assert_eq!(db.save_draft(&edited).unwrap(), restored_id);
        let mut stale = source;
        stale.subject = "Stale autosave after restore".into();
        assert!(db.save_draft(&stale).is_err());
    }

    #[test]
    fn restoring_remote_source_preserves_delete_tombstone_and_attachment_refs() {
        let (db, account_id) = with_account();
        let mut source = draft_with_id(&db, &account_id);
        let token = "remote-restore-attachment";
        add_attachment(&db, &account_id, &mut source, token);
        db.save_draft(&source).unwrap();
        let source_id = source.id.clone().unwrap();
        db.conn()
            .unwrap()
            .execute(
                "UPDATE drafts SET sync_state='synced',remote_mailbox='Drafts',remote_uid=18,
                 remote_uid_validity=7 WHERE id=?1 AND account_id=?2",
                params![source_id, account_id],
            )
            .unwrap();
        let outbox_id = db
            .queue_outbox(
                &source,
                "queued",
                None,
                "<remote-restore@example.test>",
                b"mime",
                None,
            )
            .unwrap();

        let pending = db.pending_draft_sync(&account_id).unwrap();
        assert!(pending
            .iter()
            .any(|record| record.id == source_id && record.deleted));
        let restored = db.restore_outbox_as_draft(&outbox_id, &account_id).unwrap();
        let restored_id = restored.id.clone().unwrap();
        assert_ne!(restored_id, source_id);
        assert!(db.draft(&restored_id, &account_id).is_ok());
        assert!(db
            .pending_draft_sync(&account_id)
            .unwrap()
            .iter()
            .any(|record| { record.id == source_id && record.deleted }));

        let owners = db
            .conn()
            .unwrap()
            .prepare("SELECT owner_kind,owner_id FROM attachment_refs WHERE token=?1 ORDER BY owner_kind")
            .unwrap()
            .query_map([token], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(owners, vec![("draft".into(), restored_id)]);
        db.finish_remote_draft_delete(&source_id, &account_id)
            .unwrap();
        assert!(db.draft(&source_id, &account_id).is_err());
        assert!(db.draft(&restored.id.unwrap(), &account_id).is_ok());
    }

    #[test]
    fn legacy_restore_keeps_a_newer_draft_and_restores_queued_snapshot_separately() {
        let (db, account_id) = with_account();
        let source = draft_with_id(&db, &account_id);
        let source_id = source.id.clone().unwrap();
        let mut newer = source.clone();
        newer.subject = "Newer draft must survive".into();
        db.save_draft(&newer).unwrap();
        let outbox_id = insert_legacy_outbox(&db, &source, "scheduled");

        let restored = db.restore_outbox_as_draft(&outbox_id, &account_id).unwrap();
        assert_ne!(restored.id.as_deref(), Some(source_id.as_str()));
        assert!(db.draft(&source_id, &account_id).is_err());
        assert_eq!(restored.subject, source.subject);
        assert_eq!(
            db.draft(restored.id.as_deref().unwrap(), &account_id)
                .unwrap()
                .subject,
            source.subject
        );
        let drafts = db.list_drafts(&account_id).unwrap();
        assert!(drafts
            .iter()
            .any(|item| item.subject == "Newer draft must survive"));
        assert!(drafts.iter().any(|item| item.subject == source.subject));
        let newer_copy = drafts
            .iter()
            .find(|item| item.subject == "Newer draft must survive")
            .unwrap();
        assert_ne!(newer_copy.id, source_id);
        let mut stale = newer;
        stale.subject = "Stale autosave after legacy restore".into();
        assert!(db.save_draft(&stale).is_err());
        assert!(db.outbox(&outbox_id, &account_id).is_err());
    }

    #[test]
    fn failed_queue_keeps_source_and_draft_attachment_references() {
        let (db, account_id) = with_account();
        for index in 0..MAX_NEEDS_ATTENTION_OUTBOX_MESSAGES {
            db.queue_outbox(
                &draft(),
                "needs_attention",
                None,
                &format!("<parked-{index}@example.test>"),
                b"parked",
                None,
            )
            .unwrap();
        }
        let mut source = draft_with_id(&db, &account_id);
        add_attachment(&db, &account_id, &mut source, "failed-queue-attachment");
        db.save_draft(&source).unwrap();
        let source_id = source.id.clone().unwrap();

        assert!(db
            .queue_outbox(
                &source,
                "scheduled",
                None,
                "<blocked@example.test>",
                b"mime",
                Some("2099-01-01T00:00:00Z"),
            )
            .is_err());
        assert!(db.draft(&source_id, &account_id).is_ok());
        let owner: String = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT owner_kind FROM attachment_refs WHERE token='failed-queue-attachment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owner, "draft");
    }

    #[test]
    fn legacy_delivery_cleanup_preserves_new_edits_and_removes_matching_source() {
        let (db, account_id) = with_account();
        let source = draft_with_id(&db, &account_id);
        let source_id = source.id.clone().unwrap();
        let mut newer = source.clone();
        newer.subject = "Newer unsent edit".into();
        db.save_draft(&newer).unwrap();
        let outbox_id = insert_legacy_outbox(&db, &source, "queued");
        assert!(!db
            .finalize_outbox_source_draft(&outbox_id, &account_id)
            .unwrap());
        assert_eq!(
            db.draft(&source_id, &account_id).unwrap().subject,
            "Newer unsent edit"
        );

        let matching_outbox = insert_legacy_outbox(&db, &newer, "queued");
        assert!(db
            .finalize_outbox_source_draft(&matching_outbox, &account_id)
            .unwrap());
        assert!(db.draft(&source_id, &account_id).is_err());
    }

    #[test]
    fn prepare_queued_outbox_repairs_any_waiting_state_but_never_overwrites() {
        let (db, account_id) = with_account();
        for state in ["queued", "scheduled", "needs_attention"] {
            let id = db
                .queue_outbox(&draft(), state, None, "", b"", None)
                .unwrap();
            db.prepare_queued_outbox(
                &id,
                &account_id,
                &format!("<repaired-{state}@example.com>"),
                b"Subject: repaired\r\n\r\nbody",
            )
            .unwrap();
            let (_, prepared_state, message_id, mime) =
                db.outbox_delivery(&id, &account_id).unwrap();
            assert_eq!(prepared_state, state);
            assert_eq!(message_id, format!("<repaired-{state}@example.com>"));
            assert_eq!(mime, b"Subject: repaired\r\n\r\nbody");
        }

        // A row that already carries content is guarded, not clobbered.
        let filled = db
            .queue_outbox(
                &draft(),
                "needs_attention",
                None,
                "<filled@example.com>",
                b"already attempted",
                None,
            )
            .unwrap();
        assert!(db
            .prepare_queued_outbox(
                &filled,
                &account_id,
                "<must-not-send@example.com>",
                b"multiple versions of the same mail",
            )
            .is_err());
        let (_, _, message_id, mime) = db.outbox_delivery(&filled, &account_id).unwrap();
        assert_eq!(message_id, "<filled@example.com>");
        assert_eq!(mime, b"already attempted");
    }

    fn inbox_rule_message(
        uid: u32,
        subject: &str,
        to: Vec<String>,
        cc: Vec<String>,
        bcc: Vec<String>,
        recipients: &str,
    ) -> CachedMessage {
        CachedMessage {
            uid,
            internal_at: None,
            message_id: Some(format!("<{uid}@filter.example.com>")),
            subject: subject.into(),
            sender_name: "Sender".into(),
            sender_address: "sender@example.com".into(),
            recipients: recipients.into(),
            received_at: "2026-08-18T12:00:00Z".into(),
            preview: subject.into(),
            is_read: false,
            is_starred: false,
            size: 32,
            to,
            cc,
            bcc,
            reply_to: None,
            thread_parent: None,
            text_body: subject.into(),
            html_body: None,
            attachments: vec![],
            raw_message: b"stub".to_vec(),
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

    #[test]
    fn full_address_to_rule_matches_to_and_cc_json_exactly() {
        // Full-address To rule must not match a lookalike local part or longer domain.
        let (db, account_id) = with_account();
        let inbox = db
            .upsert_mailbox(
                &account_id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(10),
                Some(0),
                0,
            )
            .unwrap();
        let rule = FilterRule {
            id: "rule-1".into(),
            account_id: account_id.clone(),
            name: "To Alice".into(),
            field: "to".into(),
            contains: "alice@company.com".into(),
            action: "mark_read".into(),
            target_mailbox: None,
            enabled: true,
        };
        let cases = [
            (
                1,
                "To Alice",
                vec!["alice@company.com".into()],
                vec![],
                vec![],
                "alice@company.com",
                true,
            ),
            (
                2,
                "Cc Alice",
                vec!["bob@example.com".into()],
                vec!["alice@company.com".into()],
                vec![],
                "bob@example.com, alice@company.com",
                true,
            ),
            (
                3,
                "Not Alice local",
                vec!["notalice@company.com".into()],
                vec![],
                vec![],
                "notalice@company.com",
                false,
            ),
            (
                4,
                "Evil domain",
                vec!["alice@company.com.evil".into()],
                vec![],
                vec![],
                "alice@company.com.evil",
                false,
            ),
            (
                5,
                "Bcc only",
                vec!["bob@example.com".into()],
                vec![],
                vec!["alice@company.com".into()],
                "bob@example.com, alice@company.com",
                false,
            ),
        ];
        for (uid, subject, to, cc, bcc, recipients, _) in &cases {
            db.upsert_message(
                &account_id,
                inbox,
                &inbox_rule_message(
                    *uid,
                    subject,
                    to.clone(),
                    cc.clone(),
                    bcc.clone(),
                    recipients,
                ),
            )
            .unwrap();
        }

        let matches = db.find_rule_matches(&account_id, &rule, None).unwrap();
        let matched_uids: HashSet<u32> = matches.iter().map(|(_, uid, _, _)| *uid).collect();
        let expected: HashSet<u32> = cases
            .iter()
            .filter(|(_, _, _, _, _, _, keep)| *keep)
            .map(|(uid, _, _, _, _, _, _)| *uid)
            .collect();
        assert_eq!(matched_uids, expected);

        let preview = db.preview_rule_matches(&account_id, &rule).unwrap();
        assert_eq!(preview.matched, expected.len() as u32);
        assert!(preview.subjects.iter().any(|s| s.contains("To Alice")));
        assert!(preview.subjects.iter().any(|s| s.contains("Cc Alice")));
    }

    #[test]
    fn pending_backlog_bytes_count_every_waiting_state() {
        let (db, account_id) = with_account();
        db.queue_outbox(&draft(), "queued", None, "<q@e>", &[0u8; 100], None)
            .unwrap();
        db.queue_outbox(&draft(), "scheduled", None, "<s@e>", &[0u8; 50], None)
            .unwrap();
        db.queue_outbox(
            &draft(),
            "needs_attention",
            None,
            "<a@e>",
            &[0u8; 500],
            None,
        )
        .unwrap();
        db.queue_outbox(&draft(), "sent", None, "<t@e>", &[0u8; 900], None)
            .unwrap();
        let conn = db.conn().unwrap();
        assert_eq!(pending_outbox_bytes(&conn, &account_id).unwrap(), 650);
        assert_eq!(pending_outbox_bytes(&conn, "other-account").unwrap(), 0);

        // Boundary: denial starts once the backlog IS the cap, not before it.
        assert!(!pending_sends_denied(MAX_PENDING_OUTBOX_BYTES - 1));
        assert!(pending_sends_denied(MAX_PENDING_OUTBOX_BYTES));
    }

    fn retry_wait_seconds(db: &Database, id: &str) -> i64 {
        let retry_after: String = db
            .conn()
            .unwrap()
            .query_row("SELECT retry_after FROM outbox WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .unwrap();
        let due = chrono::DateTime::parse_from_rfc3339(&retry_after).unwrap();
        (due.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds()
    }

    #[test]
    fn defer_outbox_retry_ladder_waits_one_two_four_minutes_then_caps() {
        let (db, account_id) = with_account();
        let id = db
            .queue_outbox(&draft(), "queued", None, "<l@e>", b"mail", None)
            .unwrap();
        // SQLite evaluates the SET against the pre-update row: the k-th try
        // reads retry_attempts=k-1, so the waits are 1, 2, 4… minutes.
        for (index, minutes) in [1i64, 2, 4, 8, 16, 32, 60, 60].iter().enumerate() {
            assert!(db.defer_outbox_retry(&id, &account_id, 100).unwrap());
            let wait = retry_wait_seconds(&db, &id);
            let expected = minutes * 60;
            assert!(
                (expected - 10..=expected + 20).contains(&wait),
                "try {} waited {}s, expected ~{} min",
                index + 1,
                wait,
                minutes
            );
        }
        // The call that reaches max_attempts reports exhaustion, so the
        // caller parks instead of assuming another automatic try.
        assert!(!db.defer_outbox_retry(&id, &account_id, 8).unwrap());
        let fresh = db
            .queue_outbox(&draft(), "queued", None, "<m@e>", b"mail", None)
            .unwrap();
        assert!(db.defer_outbox_retry(&fresh, &account_id, 3).unwrap());
        assert!(db.defer_outbox_retry(&fresh, &account_id, 3).unwrap());
        assert!(!db.defer_outbox_retry(&fresh, &account_id, 3).unwrap());
    }
}
