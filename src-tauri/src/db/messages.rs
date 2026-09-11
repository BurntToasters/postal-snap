use super::{
    adjust_mailbox_counts, db_error, fts_query, has_remote_images, json_or_default,
    map_message_summary, provisional_thread_root, references_from_raw, CachedMessage, Database,
    MailboxSyncState, MESSAGE_DETAIL_SELECT, MESSAGE_SUMMARY_SELECT,
};
use rusqlite::{params, OptionalExtension};

use crate::models::{
    MessageCursor, MessageDetail, MessagePage, MessageSummary, RecipientSuggestion, SearchQuery,
};

impl Database {
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
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'',?10,?11,?12,?13,?14,?15,?16,?17,?18,'',NULL,'[]',X'',CURRENT_TIMESTAMP)
             ON CONFLICT(mailbox_id, uid) DO UPDATE SET
                message_id=excluded.message_id, subject=excluded.subject, sender_name=excluded.sender_name,
                sender_address=excluded.sender_address, recipients=excluded.recipients, received_at=excluded.received_at,
                is_read=excluded.is_read, is_starred=excluded.is_starred, size=excluded.size,
                to_json=excluded.to_json, cc_json=excluded.cc_json, reply_to=excluded.reply_to,
                thread_parent=excluded.thread_parent, thread_root=excluded.thread_root,
                has_attachments=CASE WHEN excluded.has_attachments=1 THEN 1 ELSE has_attachments END",
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
                i32::from(message.has_attachments || !message.attachments.is_empty()),
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
                let sanitized = html_body
                    .as_deref()
                    .map(crate::html_sanitize::sanitize_received_html);
                Ok(MessageDetail {
                    summary: map_message_summary(row)?,
                    to: json_or_default(row.get::<_, String>(15)?),
                    cc: json_or_default(row.get::<_, String>(16)?),
                    reply_to: row.get(17)?,
                    text_body: row.get(18)?,
                    remote_images_blocked: sanitized.as_ref().is_some_and(|item| {
                        item.blocked_images > 0 || has_remote_images(&item.html)
                    }),
                    html_body: sanitized.map(|item| item.html),
                    attachments: json_or_default(row.get::<_, String>(20)?),
                    references: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Message not found in the local cache.".into())
    }

    pub fn message_references(&self, id: i64, account_id: &str) -> Result<Vec<String>, String> {
        let (thread_parent, raw): (Option<String>, Vec<u8>) = self
            .conn()?
            .query_row(
                "SELECT thread_parent, raw_message FROM messages WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Message not found in the local cache.".to_string())?;
        let mut references = references_from_raw(&raw);
        if references.is_empty() {
            if let Some(parent) = thread_parent {
                references.push(parent);
            }
        }
        Ok(references)
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

    pub fn mailbox_id_for_name(
        &self,
        account_id: &str,
        mailbox: &str,
    ) -> Result<Option<i64>, String> {
        self.conn()?
            .query_row(
                "SELECT id FROM mailboxes WHERE account_id=?1 AND name=?2",
                params![account_id, mailbox],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)
    }

    pub fn update_mailbox_status(
        &self,
        mailbox_id: i64,
        uid_validity: Option<u32>,
        uid_next: Option<u32>,
        server_unread: Option<u32>,
        server_total: u32,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE mailboxes SET uid_validity=?2, uid_next=?3, server_unread=?4, server_total=?5,
                 counts_updated_at=CURRENT_TIMESTAMP, local_total_delta=0, local_unread_delta=0
                 WHERE id=?1",
                params![mailbox_id, uid_validity, uid_next, server_unread, server_total],
            )
            .map_err(db_error)?;
        Ok(())
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
}
