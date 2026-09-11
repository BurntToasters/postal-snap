use super::{
    db_error, map_message_summary, replace_attachment_refs, Database, MESSAGE_SUMMARY_SELECT,
};
use rusqlite::{params, OptionalExtension};

use crate::models::{ComposeDraft, FilterRule, OutboxSummary, SnoozedSummary};

impl Database {
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

    pub fn claim_outbox_delivery(&self, id: &str, account_id: &str) -> Result<bool, String> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE outbox SET state='sending',attempt_started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
                 WHERE id=?1 AND account_id=?2 AND state IN ('queued','scheduled','needs_attention')",
                params![id, account_id],
            )
            .map_err(db_error)?;
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
}
