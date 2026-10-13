use super::{
    adjust_mailbox_counts, db_error, fts_query, has_remote_images, json_or_default,
    map_message_summary, provisional_thread_root, references_from_raw, CachedMessage, Database,
    MailboxSyncState, MESSAGE_DETAIL_SELECT, MESSAGE_SUMMARY_SELECT,
};
use rusqlite::{params, OptionalExtension};

use crate::models::{
    MessageCursor, MessageDetail, MessageListFilter, MessageListSort, MessagePage, MessageSummary,
    RecipientSuggestion, SearchQuery,
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
            let overlay: Option<(bool, Option<i64>, bool)> = transaction
                .query_row(
                    "SELECT m.is_read != 0,m.pending_move_to,
                            COALESCE(m.pending_move_to IS NOT NULL AND m.pending_destination_generation=d.counts_generation,0)
                     FROM messages m LEFT JOIN mailboxes d ON d.id=m.pending_move_to
                     WHERE m.mailbox_id=?1 AND m.uid=?2",
                    params![mailbox_id, uid],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(db_error)?;
            if let Some((was_read, Some(destination_id), true)) = overlay {
                if was_read != *is_read {
                    let delta = if *is_read { -1 } else { 1 };
                    adjust_mailbox_counts(&transaction, destination_id, 0, Some(delta))?;
                }
            }
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

    /// Server truth for `\\Answered` / `$Forwarded`, keyed by UID.
    pub fn reconcile_reply_flags(
        &self,
        mailbox_id: i64,
        seen: &[(u32, bool, bool)],
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        for (uid, answered, forwarded) in seen {
            transaction
                .execute(
                    "UPDATE messages SET is_answered=?3,is_forwarded=?4 WHERE mailbox_id=?1 AND uid=?2",
                    params![mailbox_id, uid, *answered as i32, *forwarded as i32],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    /// Optimistic local mark after a confirmed send; only ever turns flags on.
    pub fn mark_replied(
        &self,
        id: i64,
        account_id: &str,
        answered: bool,
        forwarded: bool,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE messages SET is_answered=is_answered OR ?3, is_forwarded=is_forwarded OR ?4
                 WHERE id=?1 AND account_id=?2",
                params![id, account_id, answered as i32, forwarded as i32],
            )
            .map_err(db_error)?;
        Ok(())
    }

    #[cfg(test)]
    pub fn upsert_message(
        &self,
        account_id: &str,
        mailbox_id: i64,
        message: &CachedMessage,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        write_full_message(&transaction, account_id, mailbox_id, message)?;
        transaction.commit().map_err(db_error)
    }

    /// Store a downloaded body only when the envelope row still exists in the
    /// same mailbox generation. A body fetched while a UIDVALIDITY purge or an
    /// expunge ran must never resurrect the row under a recycled UID.
    pub fn attach_body_if_current(
        &self,
        mailbox_id: i64,
        expected_uid_validity: u32,
        message: &CachedMessage,
    ) -> Result<bool, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let current: Option<(String, Option<u32>)> = transaction
            .query_row(
                "SELECT m.account_id, box.uid_validity FROM messages m JOIN mailboxes box ON box.id=m.mailbox_id
                 WHERE m.mailbox_id=?1 AND m.uid=?2",
                params![mailbox_id, message.uid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        let Some((account_id, uid_validity)) = current else {
            return Ok(false);
        };
        if uid_validity != Some(expected_uid_validity) {
            return Ok(false);
        }
        write_full_message(&transaction, &account_id, mailbox_id, message)?;
        transaction.commit().map_err(db_error)?;
        Ok(true)
    }

    /// Record a failed background body download so poison messages back off
    /// exponentially instead of being re-selected first on every pass.
    pub fn record_prefetch_failure(&self, mailbox_id: i64, uid: u32) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE messages SET prefetch_failures=prefetch_failures+1,
                 prefetch_retry_at=strftime('%Y-%m-%dT%H:%M:%S+00:00','now',
                   '+' || (15 * (1 << MIN(prefetch_failures, 8))) || ' minutes')
                 WHERE mailbox_id=?1 AND uid=?2",
                params![mailbox_id, uid],
            )
            .map_err(db_error)?;
        Ok(())
    }

    #[cfg(test)]
    pub fn upsert_envelope(
        &self,
        account_id: &str,
        mailbox_id: i64,
        message: &CachedMessage,
    ) -> Result<(), String> {
        self.upsert_envelopes(account_id, mailbox_id, std::slice::from_ref(message))
    }

    /// Write a fetched envelope chunk in one transaction: all rows and their
    /// FTS entries land together or not at all.
    pub fn upsert_envelopes(
        &self,
        account_id: &str,
        mailbox_id: i64,
        messages: &[CachedMessage],
    ) -> Result<(), String> {
        if messages.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        for message in messages {
            write_envelope(&transaction, account_id, mailbox_id, message)?;
        }
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

    #[cfg(test)]
    pub fn list_messages(
        &self,
        mailbox_id: i64,
        cursor: Option<&MessageCursor>,
        limit: u32,
    ) -> Result<MessagePage, String> {
        self.list_messages_filtered(
            mailbox_id,
            cursor,
            limit,
            MessageListFilter::All,
            MessageListSort::Date,
        )
    }

    pub fn list_messages_filtered(
        &self,
        mailbox_id: i64,
        cursor: Option<&MessageCursor>,
        limit: u32,
        filter: MessageListFilter,
        sort: MessageListSort,
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
        let filter_sql = match filter {
            MessageListFilter::All => "",
            MessageListFilter::Unread => " AND m.is_read=0",
            MessageListFilter::Starred => " AND m.is_starred=1",
            MessageListFilter::Attachments => " AND m.has_attachments=1",
            MessageListFilter::Pinned => " AND m.pinned=1",
            MessageListFilter::ToMe => " AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=m.account_id AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) AS addr WHERE lower(addr.value)=lower(a.email) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(a.aliases_json) THEN a.aliases_json ELSE '[]' END) AS alias WHERE lower(alias.value)=lower(addr.value))))",
            MessageListFilter::Invitations => " AND m.has_calendar=1",
        };
        // A cursor from another order would skip the wrong rows.
        let cursor = cursor.filter(|item| item.sort == sort);
        let sender_sort = "(CASE WHEN sender_name != '' THEN sender_name ELSE sender_address END)";
        // Pins stay above the chosen order. The cursor remembers whether the
        // last row was pinned so the next page does not repeat it.
        let (inner_cursor, order_sql) = match sort {
            MessageListSort::Date => (
                "(?2 IS NULL OR received_at < ?2 OR (received_at = ?2 AND uid < ?3))",
                "ORDER BY pinned DESC, received_at DESC, uid DESC",
            ),
            MessageListSort::DateOldest => (
                "(?2 IS NULL OR received_at > ?2 OR (received_at = ?2 AND uid > ?3))",
                "ORDER BY pinned DESC, received_at ASC, uid ASC",
            ),
            MessageListSort::Sender => (
                "(?2 IS NULL OR sender_sort > ?2 COLLATE NOCASE OR (sender_sort = ?2 COLLATE NOCASE AND uid < ?3))",
                "ORDER BY pinned DESC, sender_sort COLLATE NOCASE ASC, uid DESC",
            ),
            MessageListSort::SenderDesc => (
                "(?2 IS NULL OR sender_sort < ?2 COLLATE NOCASE OR (sender_sort = ?2 COLLATE NOCASE AND uid > ?3))",
                "ORDER BY pinned DESC, sender_sort COLLATE NOCASE DESC, uid ASC",
            ),
            MessageListSort::Subject => (
                "(?2 IS NULL OR subject > ?2 COLLATE NOCASE OR (subject = ?2 COLLATE NOCASE AND uid < ?3))",
                "ORDER BY pinned DESC, subject COLLATE NOCASE ASC, uid DESC",
            ),
            MessageListSort::SubjectDesc => (
                "(?2 IS NULL OR subject < ?2 COLLATE NOCASE OR (subject = ?2 COLLATE NOCASE AND uid > ?3))",
                "ORDER BY pinned DESC, subject COLLATE NOCASE DESC, uid ASC",
            ),
            MessageListSort::Size => (
                "(?2 IS NULL OR size < ?2 OR (size = ?2 AND uid < ?3))",
                "ORDER BY pinned DESC, size DESC, uid DESC",
            ),
            MessageListSort::SizeAsc => (
                "(?2 IS NULL OR size > ?2 OR (size = ?2 AND uid > ?3))",
                "ORDER BY pinned DESC, size ASC, uid ASC",
            ),
        };
        let cursor_sql =
            format!("AND (?5 IS NULL OR pinned < ?5 OR (pinned = ?5 AND {inner_cursor}))")
                .replace("sender_sort", sender_sort);
        let order_sql = order_sql.replace("sender_sort", sender_sort);
        let mut statement = conn
            .prepare(&format!(
                "{} WHERE mailbox_id = ?1 AND pending_move_to IS NULL
                 AND NOT EXISTS (SELECT 1 FROM snoozed_messages s WHERE s.message_id=m.id)
                 {filter_sql}
                 {cursor_sql}
                 {order_sql} LIMIT ?4",
                MESSAGE_SUMMARY_SELECT,
            ))
            .map_err(db_error)?;
        let cursor_uid = cursor.map(|value| value.uid);
        let cursor_pin = cursor.map(|item| i64::from(i32::from(item.pinned)));
        let mut items = if sort == MessageListSort::Size || sort == MessageListSort::SizeAsc {
            let size_key = cursor.and_then(|item| item.key.parse::<i64>().ok());
            statement
                .query_map(
                    params![mailbox_id, size_key, cursor_uid, page_size + 1, cursor_pin],
                    map_message_summary,
                )
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
        } else if sort == MessageListSort::Date || sort == MessageListSort::DateOldest {
            let cursor_date = cursor.map(|value| value.received_at.as_str());
            statement
                .query_map(
                    params![
                        mailbox_id,
                        cursor_date,
                        cursor_uid,
                        page_size + 1,
                        cursor_pin
                    ],
                    map_message_summary,
                )
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
        } else {
            let text_key = cursor.map(|item| item.key.clone());
            statement
                .query_map(
                    params![mailbox_id, text_key, cursor_uid, page_size + 1, cursor_pin],
                    map_message_summary,
                )
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
        }
        .map_err(db_error)?;
        let has_more = items.len() > page_size as usize;
        if has_more {
            items.truncate(page_size as usize);
        }
        let next_cursor = has_more
            .then(|| items.last())
            .flatten()
            .map(|last| list_cursor(sort, last));
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
            &format!("{} JOIN mailboxes box ON box.id=m.mailbox_id WHERE m.account_id=?1 AND box.role='inbox' AND m.pending_move_to IS NULL ORDER BY m.received_at DESC,m.uid DESC LIMIT 1", MESSAGE_SUMMARY_SELECT),
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
        let mut detail = conn
            .query_row(
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
                    let list_unsubscribe: Option<String> = row.get("list_unsubscribe")?;
                    let list_unsubscribe_post: Option<String> = row.get("list_unsubscribe_post")?;
                    let calendar_json: Option<String> = row.get("calendar_json")?;
                    Ok(MessageDetail {
                        summary: map_message_summary(row)?,
                        to: json_or_default(row.get::<_, String>(15)?),
                        cc: json_or_default(row.get::<_, String>(16)?),
                        bcc: json_or_default(row.get::<_, String>("bcc_json")?),
                        reply_to: row.get(17)?,
                        text_body: row.get(18)?,
                        remote_images_blocked: sanitized.as_ref().is_some_and(|item| {
                            item.blocked_images > 0 || has_remote_images(&item.html)
                        }),
                        html_body: sanitized.map(|item| item.html),
                        attachments: json_or_default(row.get::<_, String>(20)?),
                        references: Vec::new(),
                        body_status: "available".into(),
                        unsubscribe: crate::mail::list_unsubscribe::options(
                            list_unsubscribe.as_deref(),
                            list_unsubscribe_post.as_deref(),
                        ),
                        list_unsubscribe,
                        list_unsubscribe_post,
                        list_post: None,
                        invite: calendar_json
                            .as_deref()
                            .and_then(|json| serde_json::from_str(json).ok()),
                        disposition_to: crate::models::receipt_mailbox(
                            &row.get::<_, String>("disposition_to")?,
                        )
                        .unwrap_or_default(),
                        receipt_choice: match row.get::<_, String>("receipt_choice")?.as_str() {
                            "sent" => "sent".to_string(),
                            "declined" => "declined".to_string(),
                            _ => String::new(),
                        },
                    })
                },
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Message not found in the local cache.".to_string())?;
        let raw: Option<Vec<u8>> = conn
            .query_row(
                // substr() of an empty or NULL blob is NULL; coalesce to an empty blob.
                "SELECT COALESCE(substr(raw_message, 1, 16384), X'') FROM messages WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(raw) = raw {
            detail.list_post = crate::mail::list_unsubscribe::list_post_address(&raw);
        }
        Ok(detail)
    }

    /// Record a read-receipt choice once. A later choice does not replace it.
    pub fn set_receipt_choice(
        &self,
        id: i64,
        account_id: &str,
        choice: &str,
    ) -> Result<String, String> {
        if choice != "sent" && choice != "declined" {
            return Err("Could not save that choice.".into());
        }
        let conn = self.conn()?;
        conn.execute(
            "UPDATE messages SET receipt_choice=?1 WHERE id=?2 AND account_id=?3 AND receipt_choice=''",
            params![choice, id, account_id],
        )
        .map_err(db_error)?;
        conn.query_row(
            "SELECT receipt_choice FROM messages WHERE id=?1 AND account_id=?2",
            params![id, account_id],
            |row| row.get(0),
        )
        .map_err(|_| "Message not found in the local cache.".to_string())
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

    /// The cached copy of a Message-ID. A trash or junk copy loses to any other folder.
    pub fn find_message_by_header_id(
        &self,
        account_id: &str,
        header_id: &str,
    ) -> Result<Option<MessageSummary>, String> {
        if header_id.is_empty() {
            return Ok(None);
        }
        self.conn()?
            .query_row(
                &format!(
                    "{MESSAGE_SUMMARY_SELECT} JOIN mailboxes box ON box.id=m.mailbox_id \
                     WHERE m.account_id=?1 AND m.message_id=?2 AND m.pending_move_to IS NULL \
                     ORDER BY CASE WHEN box.role IN ('trash','junk') THEN 1 ELSE 0 END, \
                     m.received_at DESC, m.uid DESC LIMIT 1"
                ),
                params![account_id, header_id],
                map_message_summary,
            )
            .optional()
            .map_err(db_error)
    }

    /// Find the refreshed local copy in one destination mailbox.
    pub fn find_message_by_header_id_in_mailbox(
        &self,
        account_id: &str,
        mailbox_id: i64,
        header_id: &str,
    ) -> Result<Option<MessageSummary>, String> {
        if header_id.is_empty() {
            return Ok(None);
        }
        self.conn()?
            .query_row(
                &format!(
                    "{MESSAGE_SUMMARY_SELECT} WHERE m.account_id=?1 AND m.mailbox_id=?2 \
                     AND m.message_id=?3 AND m.pending_move_to IS NULL \
                     ORDER BY m.received_at DESC, m.uid DESC LIMIT 1"
                ),
                params![account_id, mailbox_id, header_id],
                map_message_summary,
            )
            .optional()
            .map_err(db_error)
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
        let (
            source_mailbox_id,
            pending_destination_id,
            was_read,
            source_overlay_active,
            destination_overlay_active,
        ): (i64, Option<i64>, bool, bool, bool) = transaction
            .query_row(
                "SELECT m.mailbox_id,m.pending_move_to,m.is_read != 0,
                         COALESCE(m.pending_move_to IS NOT NULL AND m.pending_source_generation=s.counts_generation,0),
                         COALESCE(m.pending_move_to IS NOT NULL AND m.pending_destination_generation=d.counts_generation,0)
                 FROM messages m JOIN mailboxes s ON s.id=m.mailbox_id
                 LEFT JOIN mailboxes d ON d.id=m.pending_move_to
                 WHERE m.id=?1",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
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
            if pending_destination_id.is_none() || !source_overlay_active {
                adjust_mailbox_counts(&transaction, source_mailbox_id, 0, Some(delta))?;
            }
            if let Some(destination_id) =
                pending_destination_id.filter(|_| destination_overlay_active)
            {
                adjust_mailbox_counts(&transaction, destination_id, 0, Some(delta))?;
            }
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    /// Local pin. Sync and envelope refresh leave the stored value alone.
    pub fn set_pinned(&self, account_id: &str, ids: &[i64], pinned: bool) -> Result<u32, String> {
        if ids.is_empty() {
            return Ok(0);
        }
        if ids.len() > 200 {
            return Err("Select up to 200 messages at a time.".into());
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let mut updated = 0u32;
        for id in ids {
            let changed = transaction
                .execute(
                    "UPDATE messages SET pinned=?1 WHERE id=?2 AND account_id=?3",
                    params![i32::from(pinned), id, account_id],
                )
                .map_err(db_error)?;
            updated += u32::try_from(changed).unwrap_or(0);
        }
        transaction.commit().map_err(db_error)?;
        Ok(updated)
    }

    #[cfg(test)]
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
            .prepare("SELECT uid FROM messages WHERE mailbox_id=?1 AND pending_move_to IS NOT NULL ORDER BY uid DESC")
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
                "DELETE FROM message_fts WHERE rowid IN (SELECT id FROM messages WHERE mailbox_id=?1)",
                [mailbox_id],
            )
            .map_err(db_error)?;
        transaction
            .execute("DELETE FROM messages WHERE mailbox_id=?1", [mailbox_id])
            .map_err(db_error)?;
        transaction
            .execute(
                "UPDATE mailboxes SET backfill_uid=NULL,backfill_state='active',highest_modseq=NULL,last_flag_scan_at=NULL WHERE id=?1",
                [mailbox_id],
            )
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
        let (source_id, is_read, current_pending, source_overlay, destination_overlay):
            (i64, bool, Option<i64>, Option<i64>, Option<i64>) = transaction
            .query_row(
                "SELECT mailbox_id,is_read != 0,pending_move_to,pending_source_generation,pending_destination_generation FROM messages WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
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
        let source_generation: i64 = transaction
            .query_row(
                "SELECT counts_generation FROM mailboxes WHERE id=?1",
                [source_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let destination_generation: i64 = transaction
            .query_row(
                "SELECT counts_generation FROM mailboxes WHERE id=?1",
                [mailbox_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        match current_pending {
            None => {
                adjust_mailbox_counts(&transaction, source_id, -1, (!is_read).then_some(-1))?;
                adjust_mailbox_counts(&transaction, mailbox_id, 1, (!is_read).then_some(1))?;
            }
            Some(previous_id) if previous_id != mailbox_id => {
                let previous_generation: i64 = transaction
                    .query_row(
                        "SELECT counts_generation FROM mailboxes WHERE id=?1",
                        [previous_id],
                        |row| row.get(0),
                    )
                    .map_err(db_error)?;
                if destination_overlay == Some(previous_generation) {
                    adjust_mailbox_counts(&transaction, previous_id, -1, (!is_read).then_some(-1))?;
                }
                adjust_mailbox_counts(&transaction, mailbox_id, 1, (!is_read).then_some(1))?;
            }
            Some(_) => {}
        }
        let next_source_overlay = if current_pending.is_none() {
            Some(source_generation)
        } else {
            source_overlay
        };
        let next_destination_overlay = if current_pending == Some(mailbox_id) {
            destination_overlay
        } else {
            Some(destination_generation)
        };
        transaction.execute(
            "UPDATE messages SET pending_move_to=?2,pending_source_generation=?3,pending_destination_generation=?4 WHERE id=?1",
            params![id, mailbox_id, next_source_overlay, next_destination_overlay],
        ).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn clear_pending_move(&self, id: i64) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        super::clear_pending_move_in_transaction(&transaction, id)?;
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

    pub fn message_rfc_id(&self, id: i64) -> Result<Option<String>, String> {
        self.conn()?
            .query_row("SELECT message_id FROM messages WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)
            .map(Option::flatten)
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
                 counts_updated_at=CURRENT_TIMESTAMP, local_total_delta=0, local_unread_delta=0,
                 counts_generation=counts_generation+1
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
            [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get::<_, i64>(4)?.max(0) as u64)),
        ).optional().map_err(db_error)?.ok_or_else(|| "Message not found.".into())
    }

    pub fn latest_message_rowid(&self) -> Result<i64, String> {
        self.conn()?
            .query_row("SELECT COALESCE(MAX(id), 0) FROM messages", [], |row| {
                row.get(0)
            })
            .map_err(db_error)
    }

    pub fn search(&self, query: &SearchQuery) -> Result<Vec<MessageSummary>, String> {
        use rusqlite::types::Value;
        let parsed = crate::search_query::parse(&query.text);
        if parsed.is_empty() {
            return Ok(Vec::new());
        }
        let folder_ids = if parsed.folders.is_empty() {
            None
        } else {
            let ids = self
                .list_mailboxes(&query.account_id)?
                .into_iter()
                .filter(|mailbox| {
                    parsed.folders.iter().any(|needle| {
                        crate::search_query::folder_needle_matches(
                            needle,
                            mailbox.role.as_str(),
                            &mailbox.name,
                            &mailbox.display_name,
                            mailbox.delimiter.as_deref(),
                        )
                    })
                })
                .map(|mailbox| mailbox.id)
                .collect::<Vec<_>>();
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            Some(ids)
        };
        let identities = if parsed.from_self || parsed.to_self || parsed.cc_self {
            let account = self.account(&query.account_id)?;
            crate::search_query::search_identities(&account.summary.email, &account.summary.aliases)
        } else {
            Vec::new()
        };
        let conn = self.conn()?;
        let expression = parsed.fts_match();
        let mut values = vec![Value::from(query.account_id.clone())];
        let mut sql = MESSAGE_SUMMARY_SELECT.to_string();
        if expression.is_some() {
            sql.push_str(" JOIN message_fts fts ON fts.rowid=m.id");
        }
        sql.push_str(" WHERE m.account_id=?1 AND m.pending_move_to IS NULL");
        if let Some(expression) = expression.clone() {
            values.push(Value::from(expression));
            sql.push_str(&format!(" AND message_fts MATCH ?{}", values.len()));
        }
        if let (false, Some(mailbox_id)) = (query.all_folders, query.mailbox_id) {
            values.push(Value::from(mailbox_id));
            sql.push_str(&format!(" AND m.mailbox_id = ?{}", values.len()));
        }
        if let Some(ids) = &folder_ids {
            let mut marks = Vec::with_capacity(ids.len());
            for id in ids {
                values.push(Value::from(*id));
                marks.push(format!("?{}", values.len()));
            }
            sql.push_str(&format!(" AND m.mailbox_id IN ({})", marks.join(",")));
        }
        if parsed.has_attachment {
            sql.push_str(" AND m.has_attachments=1");
        }
        match parsed.read {
            Some(true) => sql.push_str(" AND m.is_read=1"),
            Some(false) => sql.push_str(" AND m.is_read=0"),
            None => {}
        }
        if parsed.flagged {
            sql.push_str(" AND m.is_starred=1");
        }
        let identity_json = if parsed.from_self || parsed.to_self || parsed.cc_self {
            let json = serde_json::to_string(&identities).unwrap_or_else(|_| "[]".into());
            values.push(Value::from(json));
            Some(values.len())
        } else {
            None
        };
        if let Some(index) = identity_json.filter(|_| parsed.from_self) {
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM json_each(?{index}) AS me WHERE lower(m.sender_address)=me.value)"
            ));
        }
        if let Some(index) = identity_json.filter(|_| parsed.to_self) {
            sql.push_str(&format!(
                " AND EXISTS (
                    SELECT 1 FROM json_each(?{index}) AS me
                    WHERE EXISTS (
                        SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) AS addr
                        WHERE lower(addr.value)=me.value
                    )
                    OR EXISTS (
                        SELECT 1 FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) AS addr
                        WHERE lower(addr.value)=me.value
                    )
                    OR instr(',' || replace(lower(m.recipients), ' ', '') || ',', ',' || me.value || ',') > 0
                )"
            ));
        }
        if let Some(index) = identity_json.filter(|_| parsed.cc_self) {
            sql.push_str(&format!(
                " AND EXISTS (
                    SELECT 1 FROM json_each(?{index}) AS me
                    WHERE EXISTS (
                        SELECT 1 FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) AS addr
                        WHERE lower(addr.value)=me.value
                    )
                )"
            ));
        }
        for needle in &parsed.cc {
            let lowered = needle.to_ascii_lowercase();
            values.push(Value::from(lowered.clone()));
            let index = values.len();
            if lowered.contains('@') {
                sql.push_str(&format!(
                    " AND EXISTS (
                        SELECT 1 FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) AS addr
                        WHERE lower(addr.value)=?{index}
                    )"
                ));
            } else {
                values.push(Value::from(crate::search_query::cc_local_like(&lowered)));
                let like_index = values.len();
                sql.push_str(&format!(
                    " AND EXISTS (
                        SELECT 1 FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) AS addr
                        WHERE lower(addr.value)=?{index}
                           OR lower(addr.value) LIKE ?{like_index} ESCAPE '\\'
                    )"
                ));
            }
        }
        if parsed.answered {
            sql.push_str(" AND m.is_answered=1");
        }
        if parsed.forwarded {
            sql.push_str(" AND m.is_forwarded=1");
        }
        if parsed.muted {
            sql.push_str(
                " AND EXISTS (SELECT 1 FROM muted_ids mu WHERE mu.account_id=m.account_id AND (mu.message_id=m.message_id OR mu.message_id=m.thread_parent))",
            );
        }
        if parsed.pinned {
            sql.push_str(" AND m.pinned=1");
        }
        if let Some(importance) = parsed.importance {
            values.push(Value::from(importance.to_string()));
            sql.push_str(&format!(" AND m.importance=?{}", values.len()));
        }
        for needle in &parsed.filenames {
            values.push(Value::from(crate::search_query::filename_like_pattern(
                needle,
            )));
            sql.push_str(&format!(
                " AND EXISTS (
                    SELECT 1 FROM json_each(
                        CASE WHEN json_valid(m.attachments_json) THEN m.attachments_json ELSE '[]' END
                    ) AS attachment
                    WHERE lower(COALESCE(json_extract(attachment.value, '$.filename'), ''))
                          LIKE ?{} ESCAPE '\\'
                 )",
                values.len()
            ));
        }
        if let Some(min) = parsed.larger_than {
            values.push(Value::from(min));
            sql.push_str(&format!(" AND m.size > ?{}", values.len()));
        }
        if let Some(max) = parsed.smaller_than {
            values.push(Value::from(max));
            sql.push_str(&format!(" AND m.size < ?{}", values.len()));
        }
        // Dates are UTC days; received_at is RFC 3339, so text compares.
        if let Some(date) = parsed.after {
            values.push(Value::from(date.format("%Y-%m-%d").to_string()));
            sql.push_str(&format!(" AND m.received_at >= ?{}", values.len()));
        }
        if let Some(date) = parsed.before {
            values.push(Value::from(date.format("%Y-%m-%d").to_string()));
            sql.push_str(&format!(" AND m.received_at < ?{}", values.len()));
        }
        if let Some(date) = parsed.on {
            values.push(Value::from(date.format("%Y-%m-%d").to_string()));
            sql.push_str(&format!(" AND m.received_at >= ?{}", values.len()));
            if let Some(next) = date.checked_add_signed(chrono::Duration::days(1)) {
                values.push(Value::from(next.format("%Y-%m-%d").to_string()));
                sql.push_str(&format!(" AND m.received_at < ?{}", values.len()));
            }
        }
        // Weights: subject, sender, recipients, body.
        sql.push_str(if expression.is_some() {
            " ORDER BY bm25(message_fts, 10.0, 6.0, 3.0, 1.0), m.received_at DESC"
        } else {
            " ORDER BY m.received_at DESC, m.uid DESC"
        });
        values.push(Value::from(i64::from(query.limit.min(500))));
        sql.push_str(&format!(" LIMIT ?{}", values.len()));
        let mut statement = conn.prepare(&sql).map_err(db_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), map_message_summary)
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    /// Attachment names stored with a downloaded message. Empty when only the
    /// envelope is cached.
    pub fn attachment_filenames(&self, mailbox_id: i64, uid: u32) -> Result<Vec<String>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT json_extract(attachment.value, '$.filename')
                 FROM messages m, json_each(
                    CASE WHEN json_valid(m.attachments_json) THEN m.attachments_json ELSE '[]' END
                 ) AS attachment
                 WHERE m.mailbox_id=?1 AND m.uid=?2
                   AND json_extract(attachment.value, '$.filename') IS NOT NULL",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![mailbox_id, uid], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    /// Parked for the planned unified-inbox search; no command or mailbox UI
    /// calls this yet (see `docs/partially_implemented.md`).
    #[allow(dead_code)]
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
            "{} JOIN message_fts fts ON fts.rowid=m.id WHERE m.pending_move_to IS NULL AND message_fts MATCH ?1 ORDER BY bm25(message_fts, 10.0, 6.0, 3.0, 1.0), m.received_at DESC LIMIT ?2",
            MESSAGE_SUMMARY_SELECT,
        );
        let mut statement = conn.prepare(&sql).map_err(db_error)?;
        let rows = statement
            .query_map(params![terms, limit.min(500)], map_message_summary)
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    /// Messages already in Trash that can be removed by UID EXPUNGE.
    pub fn trash_expunge_plan(
        &self,
        account_id: &str,
        message_ids: &[i64],
    ) -> Result<TrashExpungePlan, String> {
        if message_ids.is_empty() {
            return Err("Choose a message to delete.".into());
        }
        let mut ids = message_ids.to_vec();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() > 200 {
            return Err("Choose up to 200 messages.".into());
        }
        let conn = self.conn()?;
        let mut mailbox_id: Option<i64> = None;
        let mut mailbox_name = String::new();
        let mut uid_validity = 0u32;
        let mut uids = Vec::with_capacity(ids.len());
        for id in ids {
            let row = trash_row(&conn, id)?;
            let Some(row) = row else {
                return Err("Message not found.".into());
            };
            if row.account_id != account_id {
                return Err("Message does not belong to this account.".into());
            }
            if row.role != "trash" {
                return Err("Move the message to Trash before deleting it.".into());
            }
            if row.pending_move_to.is_some() {
                return Err("A message is still moving. Try again after it finishes.".into());
            }
            if row.uid == 0 {
                return Err("This mailbox changed; refresh mail and try again.".into());
            }
            let validity = row.uid_validity.ok_or_else(|| {
                "Mailbox identity is unavailable; refresh mail and try again.".to_string()
            })?;
            match mailbox_id {
                Some(existing) if existing != row.mailbox_id => {
                    return Err("Delete messages from one folder at a time.".into());
                }
                Some(_) => {}
                None => {
                    mailbox_id = Some(row.mailbox_id);
                    mailbox_name = row.name;
                    uid_validity = validity;
                }
            }
            uids.push(row.uid);
        }
        uids.sort_unstable();
        uids.dedup();
        Ok(TrashExpungePlan {
            mailbox_name,
            uid_validity,
            uids,
        })
    }

    /// Remember this conversation so later Inbox copies are filed to Archive.
    pub fn remember_muted_conversation(
        &self,
        account_id: &str,
        message_id: i64,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let ids = conversation_mute_ids(&transaction, account_id, message_id)?;
        let mut group_id: Option<String> = None;
        for id in &ids {
            let found: Option<String> = transaction
                .query_row(
                    "SELECT group_id FROM muted_ids WHERE account_id=?1 AND message_id=?2",
                    params![account_id, id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if found.is_some() {
                group_id = found;
                break;
            }
        }
        let group_id = group_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        for id in ids {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO muted_ids(account_id,message_id,group_id) VALUES(?1,?2,?3)",
                    params![account_id, id, group_id],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    /// Stop filing later mail in this conversation. Mail already moved stays put.
    pub fn forget_muted_conversation(
        &self,
        account_id: &str,
        message_id: i64,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let ids = conversation_mute_ids(&transaction, account_id, message_id)?;
        let mut groups = Vec::new();
        for id in &ids {
            let found: Option<String> = transaction
                .query_row(
                    "SELECT group_id FROM muted_ids WHERE account_id=?1 AND message_id=?2",
                    params![account_id, id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if let Some(group_id) = found {
                if !groups.contains(&group_id) {
                    groups.push(group_id);
                }
            }
        }
        for group_id in groups {
            transaction
                .execute(
                    "DELETE FROM muted_ids WHERE account_id=?1 AND group_id=?2",
                    params![account_id, group_id],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    /// Mark matching Inbox mail read and queue a move to Archive.
    /// Runs again after sync so a reply that arrives later is filed too.
    pub fn file_muted_inbox(&self, account_id: &str) -> Result<Vec<i64>, String> {
        let Some((destination_id, destination)) = self.mailbox_for_role(account_id, "archive")?
        else {
            return Ok(Vec::new());
        };
        let mut filed = Vec::new();
        for _ in 0..5 {
            let hits = muted_inbox_hits(self, account_id)?;
            if hits.is_empty() {
                break;
            }
            let mut progressed = false;
            for hit in hits {
                if hit.mailbox == destination {
                    continue;
                }
                let Some(validity) = self.mailbox_uid_validity(account_id, &hit.mailbox)? else {
                    continue;
                };
                self.set_flags(hit.id, Some(true), None)?;
                let flag = serde_json::json!({
                    "messageId": hit.id,
                    "uid": hit.uid,
                    "mailbox": hit.mailbox,
                    "uidValidity": validity,
                    "isRead": true,
                    "isStarred": null,
                });
                self.queue_operation(
                    account_id,
                    "flags",
                    &flag,
                    Some(&format!("flags:{}:true:false", hit.id)),
                )?;
                if let Some(rfc_id) = hit.message_id.as_deref() {
                    remember_reply_id(self, account_id, rfc_id, hit.thread_parent.as_deref())?;
                }
                let operation = serde_json::json!({
                    "messageId": hit.id,
                    "uid": hit.uid,
                    "source": hit.mailbox,
                    "destination": destination,
                    "uidValidity": validity,
                });
                self.queue_operation(
                    account_id,
                    "move",
                    &operation,
                    Some(&format!("move:{}", hit.id)),
                )?;
                self.mark_pending_move(hit.id, destination_id)?;
                filed.push(hit.id);
                progressed = true;
            }
            if !progressed {
                break;
            }
        }
        Ok(filed)
    }
}

struct TrashRow {
    account_id: String,
    mailbox_id: i64,
    name: String,
    role: String,
    uid: u32,
    pending_move_to: Option<i64>,
    uid_validity: Option<u32>,
}

fn trash_row(conn: &rusqlite::Connection, id: i64) -> Result<Option<TrashRow>, String> {
    conn.query_row(
        "SELECT m.account_id, m.mailbox_id, f.name, f.role, m.uid, m.pending_move_to, f.uid_validity
         FROM messages m JOIN mailboxes f ON f.id = m.mailbox_id WHERE m.id=?1",
        [id],
        |row| {
            Ok(TrashRow {
                account_id: row.get(0)?,
                mailbox_id: row.get(1)?,
                name: row.get(2)?,
                role: row.get(3)?,
                uid: row.get(4)?,
                pending_move_to: row.get(5)?,
                uid_validity: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(db_error)
}

#[derive(Debug)]
pub struct TrashExpungePlan {
    pub mailbox_name: String,
    pub uid_validity: u32,
    pub uids: Vec<u32>,
}

// IDs may outlive cache rows in an open reader or composer.
fn stable_message_id(
    transaction: &rusqlite::Transaction<'_>,
    mailbox_id: i64,
    uid: u32,
) -> Result<i64, String> {
    let existing = transaction
        .query_row(
            "SELECT id FROM messages WHERE mailbox_id=?1 AND uid=?2",
            params![mailbox_id, uid],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(id) = existing {
        return Ok(id);
    }
    transaction.query_row("UPDATE message_id_sequence SET last_id=MAX(last_id,(SELECT COALESCE(MAX(id),0) FROM messages))+1 WHERE singleton=1 RETURNING last_id", [], |row| row.get(0)).map_err(db_error)
}

fn write_full_message(
    transaction: &rusqlite::Transaction,
    account_id: &str,
    mailbox_id: i64,
    message: &CachedMessage,
) -> Result<i64, String> {
    let attachments = serde_json::to_string(&message.attachments)
        .map_err(|_| "Could not index attachments.".to_string())?;
    let to_json = serde_json::to_string(&message.to)
        .map_err(|_| "Could not index recipients.".to_string())?;
    let cc_json = serde_json::to_string(&message.cc)
        .map_err(|_| "Could not index recipients.".to_string())?;
    let bcc_json = serde_json::to_string(&message.bcc)
        .map_err(|_| "Could not index recipients.".to_string())?;
    // Bodies are cached as a unit with the raw MIME; without it nothing counts
    // toward the cache and the row stays a prefetch candidate.
    let body_bytes = if message.raw_message.is_empty() {
        0
    } else {
        message.raw_message.len()
            + message.text_body.len()
            + message.html_body.as_deref().map_or(0, str::len)
    };
    let (thread_parent, thread_root) =
        provisional_thread_root(transaction, account_id, mailbox_id, message)?;
    let stable_id = stable_message_id(transaction, mailbox_id, message.uid)?;
    transaction.execute(
        "INSERT INTO messages (
            id, account_id, mailbox_id, uid, message_id, subject, sender_name, sender_address, recipients,
            received_at, preview, is_read, is_starred, has_attachments, size, to_json, cc_json, bcc_json,
            reply_to, thread_parent, thread_root, text_body, html_body, attachments_json, raw_message, accessed_at,
            internal_at, body_bytes, prefetch_failures, prefetch_retry_at,
            has_calendar, calendar_json, list_unsubscribe, list_unsubscribe_post, importance,
            disposition_to
         ) VALUES (?30,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?33,?17,?18,?19,?20,?21,?22,?23,'1970-01-01 00:00:00',
            COALESCE(?24,?9),?25,0,NULL,?26,?27,?28,?29,?31,?32)
         ON CONFLICT(mailbox_id, uid) DO UPDATE SET
            message_id=excluded.message_id, subject=excluded.subject, sender_name=excluded.sender_name,
            sender_address=excluded.sender_address, recipients=excluded.recipients, received_at=excluded.received_at,
            preview=excluded.preview, is_read=excluded.is_read, is_starred=excluded.is_starred,
            has_attachments=excluded.has_attachments, size=excluded.size, to_json=excluded.to_json,
            cc_json=excluded.cc_json,
            bcc_json=CASE WHEN excluded.bcc_json != '[]' THEN excluded.bcc_json ELSE messages.bcc_json END,
            reply_to=excluded.reply_to, thread_parent=excluded.thread_parent,
            thread_root=excluded.thread_root, text_body=excluded.text_body,
            html_body=excluded.html_body, attachments_json=excluded.attachments_json, raw_message=excluded.raw_message,
            internal_at=COALESCE(?24, messages.internal_at, excluded.received_at),
            body_bytes=excluded.body_bytes, prefetch_failures=0, prefetch_retry_at=NULL,
            has_calendar=excluded.has_calendar, calendar_json=excluded.calendar_json,
            list_unsubscribe=excluded.list_unsubscribe, list_unsubscribe_post=excluded.list_unsubscribe_post,
            importance=excluded.importance, disposition_to=excluded.disposition_to",
        params![
            account_id, mailbox_id, message.uid, message.message_id, message.subject, message.sender_name,
            message.sender_address, message.recipients, message.received_at, message.preview,
            message.is_read as i32, message.is_starred as i32, (!message.attachments.is_empty()) as i32,
            message.size.min(i64::MAX as u64) as i64, to_json, cc_json, message.reply_to, thread_parent, thread_root,
            message.text_body, message.html_body,
            attachments, message.raw_message, message.internal_at,
            body_bytes.min(i64::MAX as usize) as i64,
            message.has_calendar as i32, message.calendar_json, message.list_unsubscribe,
            message.list_unsubscribe_post, stable_id,
            crate::models::canonical_importance(&message.importance),
            crate::models::receipt_mailbox(&message.disposition_to).unwrap_or_default(),
            bcc_json,
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
        .execute("DELETE FROM message_fts WHERE rowid = ?1", [id])
        .map_err(db_error)?;
    transaction.execute(
        "INSERT INTO message_fts(rowid, subject, sender, recipients, body)
         SELECT id, subject, sender_name || ' ' || sender_address,
            recipients || ' ' || IFNULL((SELECT group_concat(j.value, ' ') FROM json_each(messages.bcc_json) AS j), ''),
            text_body
         FROM messages WHERE id=?1",
        [id],
    ).map_err(db_error)?;
    Ok(id)
}

fn write_envelope(
    transaction: &rusqlite::Transaction,
    account_id: &str,
    mailbox_id: i64,
    message: &CachedMessage,
) -> Result<i64, String> {
    let to_json = serde_json::to_string(&message.to)
        .map_err(|_| "Could not index recipients.".to_string())?;
    let cc_json = serde_json::to_string(&message.cc)
        .map_err(|_| "Could not index recipients.".to_string())?;
    let bcc_json = serde_json::to_string(&message.bcc)
        .map_err(|_| "Could not index recipients.".to_string())?;
    let (thread_parent, thread_root) =
        provisional_thread_root(transaction, account_id, mailbox_id, message)?;
    let stable_id = stable_message_id(transaction, mailbox_id, message.uid)?;
    transaction.execute(
        "INSERT INTO messages (
            id, account_id, mailbox_id, uid, message_id, subject, sender_name, sender_address, recipients,
            received_at, preview, is_read, is_starred, has_attachments, size, to_json, cc_json, bcc_json,
            reply_to, thread_parent, thread_root, text_body, html_body, attachments_json, raw_message, accessed_at,
            internal_at, is_answered, is_forwarded, importance
         ) VALUES (?22,?1,?2,?3,?4,?5,?6,?7,?8,?9,'',?10,?11,?12,?13,?14,?15,?24,?16,?17,?18,'',NULL,'[]',X'','1970-01-01 00:00:00',
            COALESCE(?19,?9),?20,?21,?23)
         ON CONFLICT(mailbox_id, uid) DO UPDATE SET
            message_id=excluded.message_id, subject=excluded.subject, sender_name=excluded.sender_name,
            sender_address=excluded.sender_address, recipients=excluded.recipients, received_at=excluded.received_at,
            is_read=excluded.is_read, is_starred=excluded.is_starred, size=excluded.size,
            is_answered=excluded.is_answered, is_forwarded=excluded.is_forwarded,
            to_json=excluded.to_json, cc_json=excluded.cc_json,
            bcc_json=CASE WHEN excluded.bcc_json != '[]' THEN excluded.bcc_json ELSE messages.bcc_json END,
            reply_to=excluded.reply_to,
            thread_parent=excluded.thread_parent, thread_root=excluded.thread_root,
            internal_at=COALESCE(?19, messages.internal_at, excluded.received_at),
            importance=CASE WHEN excluded.importance != '' THEN excluded.importance ELSE messages.importance END,
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
            message.size.min(i64::MAX as u64) as i64,
            to_json,
            cc_json,
            message.reply_to,
            thread_parent,
            thread_root,
            message.internal_at,
            message.is_answered as i32,
            message.is_forwarded as i32,
            stable_id,
            crate::models::canonical_importance(&message.importance),
            bcc_json,
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
        .execute("DELETE FROM message_fts WHERE rowid=?1", [id])
        .map_err(db_error)?;
    transaction.execute(
        "INSERT INTO message_fts(rowid,subject,sender,recipients,body)
         SELECT id,subject,sender_name || ' ' || sender_address,
            recipients || ' ' || IFNULL((SELECT group_concat(j.value, ' ') FROM json_each(messages.bcc_json) AS j), ''),
            text_body
         FROM messages WHERE id=?1",
        [id],
    ).map_err(db_error)?;
    Ok(id)
}

fn acceptable_mute_id(value: &str) -> Option<&str> {
    let id = value.trim();
    if id.is_empty() || id.len() > 998 || id.chars().any(char::is_control) {
        None
    } else {
        Some(id)
    }
}

fn push_mute_id(ids: &mut Vec<String>, value: Option<&str>) {
    let Some(value) = value.and_then(acceptable_mute_id) else {
        return;
    };
    if !ids.iter().any(|id| id == value) {
        ids.push(value.to_string());
    }
}

struct MuteSeed {
    owner: String,
    message_id: Option<String>,
    thread_parent: Option<String>,
    thread_root: Option<String>,
}

fn conversation_mute_ids(
    transaction: &rusqlite::Transaction,
    account_id: &str,
    message_id: i64,
) -> Result<Vec<String>, String> {
    let row = transaction
        .query_row(
            "SELECT account_id, message_id, thread_parent, thread_root FROM messages WHERE id=?1",
            [message_id],
            |row| {
                Ok(MuteSeed {
                    owner: row.get(0)?,
                    message_id: row.get(1)?,
                    thread_parent: row.get(2)?,
                    thread_root: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(db_error)?;
    let Some(MuteSeed {
        owner,
        message_id: rfc_id,
        thread_parent: parent,
        thread_root: root,
    }) = row
    else {
        return Err("Message not found.".into());
    };
    if owner != account_id {
        return Err("Message does not belong to this account.".into());
    }
    let mut ids = Vec::new();
    push_mute_id(&mut ids, rfc_id.as_deref());
    push_mute_id(&mut ids, parent.as_deref());
    if let Some(root) = root.as_deref().and_then(acceptable_mute_id) {
        let mut statement = transaction
            .prepare(
                "SELECT message_id, thread_parent FROM messages WHERE account_id=?1 AND thread_root=?2",
            )
            .map_err(db_error)?;
        let pairs = statement
            .query_map(params![account_id, root], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        drop(statement);
        for (id, parent) in pairs {
            push_mute_id(&mut ids, id.as_deref());
            push_mute_id(&mut ids, parent.as_deref());
        }
    }
    if ids.is_empty() {
        return Err("This message cannot be muted.".into());
    }
    Ok(ids)
}

struct MuteHit {
    id: i64,
    uid: u32,
    message_id: Option<String>,
    thread_parent: Option<String>,
    mailbox: String,
}

fn muted_inbox_hits(db: &Database, account_id: &str) -> Result<Vec<MuteHit>, String> {
    let conn = db.conn()?;
    let mut statement = conn
        .prepare(
            "SELECT m.id, m.uid, m.message_id, m.thread_parent, box.name
             FROM messages m
             JOIN mailboxes box ON box.id = m.mailbox_id
             WHERE m.account_id=?1 AND box.role='inbox' AND box.server_available=1
               AND m.pending_move_to IS NULL
               AND (
                 m.message_id IN (SELECT message_id FROM muted_ids WHERE account_id=?1)
                 OR m.thread_parent IN (SELECT message_id FROM muted_ids WHERE account_id=?1)
               )
             LIMIT 100",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![account_id], |row| {
            Ok(MuteHit {
                id: row.get(0)?,
                uid: row.get(1)?,
                message_id: row.get(2)?,
                thread_parent: row.get(3)?,
                mailbox: row.get(4)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn remember_reply_id(
    db: &Database,
    account_id: &str,
    message_id: &str,
    parent: Option<&str>,
) -> Result<(), String> {
    let Some(id) = acceptable_mute_id(message_id) else {
        return Ok(());
    };
    let conn = db.conn()?;
    let mut group: Option<String> = conn
        .query_row(
            "SELECT group_id FROM muted_ids WHERE account_id=?1 AND message_id=?2",
            params![account_id, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if group.is_none() {
        if let Some(parent) = parent.and_then(acceptable_mute_id) {
            group = conn
                .query_row(
                    "SELECT group_id FROM muted_ids WHERE account_id=?1 AND message_id=?2",
                    params![account_id, parent],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
        }
    }
    let Some(group) = group else {
        return Ok(());
    };
    conn.execute(
        "INSERT OR IGNORE INTO muted_ids(account_id,message_id,group_id) VALUES(?1,?2,?3)",
        params![account_id, id, group],
    )
    .map_err(db_error)?;
    Ok(())
}

fn list_cursor(sort: MessageListSort, last: &MessageSummary) -> MessageCursor {
    let key = match sort {
        MessageListSort::Date | MessageListSort::DateOldest => String::new(),
        MessageListSort::Sender | MessageListSort::SenderDesc => {
            if last.sender_name.is_empty() {
                last.sender_address.clone()
            } else {
                last.sender_name.clone()
            }
        }
        MessageListSort::Subject | MessageListSort::SubjectDesc => last.subject.clone(),
        MessageListSort::Size | MessageListSort::SizeAsc => last.size.to_string(),
    };
    MessageCursor {
        received_at: last.received_at.clone(),
        uid: last.uid,
        sort,
        key,
        pinned: last.pinned,
    }
}
