// Keep whole database operations off Tokio's cooperative workers.
macro_rules! database_operations {
    (impl Database {
        $(
            $(#[$attribute:meta])*
            $visibility:vis fn $name:ident $(<$generic:ident: $bound:path>)?
            ($($parameters:tt)*) $(-> $result:ty)? {$($body:tt)*}
        )*
    }) => {
        impl Database {
            $(
                $(#[$attribute])*
                $visibility fn $name $(<$generic: $bound>)?
                ($($parameters)*) $(-> $result)? {
                    crate::db::blocking_work(|| {$($body)*})
                }
            )*
        }
    };
}

pub mod accounts;
pub mod compatibility;
pub mod drafts;
pub mod files_cache;
pub mod mailboxes;
pub mod messages;
mod migrations;
pub mod offline_ops;
pub mod outbox;
pub mod recent_searches;
mod rules;
mod snooze;
mod snooze_transfers;

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, SecondsFormat, Utc};
use migrations::migrate_schema;
use rusqlite::{params, Connection, OptionalExtension, Row};

#[cfg(test)]
use crate::models::{
    AccountRecord, AccountSummary, CachePolicy, FilterRule, SearchQuery, ServerConfig,
};
use crate::models::{Attachment, ComposeDraft, MailboxRole, MessageSummary, ProviderKind, TlsMode};

pub(crate) const CURRENT_SCHEMA_VERSION: u32 = 43;

/// Hot write and read paths reuse prepared statements; rusqlite's default of 16 evicts them.
const STATEMENT_CACHE_CAPACITY: usize = 64;

pub(crate) const NEWER_DATABASE: &str =
    "This mail database was created by a newer Postal Snap version.";

pub type MailboxSyncState = (Option<u32>, Option<u32>, u32, Option<u32>);

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
    /// Read-only WAL reader so list and detail queries do not wait behind
    /// sync writes. `None` for in-memory databases, which use the writer.
    reader: Option<Arc<Mutex<Connection>>>,
    /// Shared copy of `keepAttachmentsOffline`, mirrored by the settings store.
    attachments_offline: Arc<std::sync::atomic::AtomicBool>,
    /// Frontend instance that owns live deferred-move holds. Empty before boot.
    undo_session: Arc<Mutex<String>>,
}

/// What a cached row holds, read before deciding whether to download.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BodyState {
    pub has_raw: bool,
    pub body_partial: bool,
    pub html_has_cid: bool,
}

#[derive(Debug)]
pub struct CachedMessage {
    pub uid: u32,
    /// Server INTERNALDATE, canonical RFC 3339. `None` keeps the stored value.
    pub internal_at: Option<String>,
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
    pub bcc: Vec<String>,
    pub reply_to: Option<String>,
    pub thread_parent: Option<String>,
    pub text_body: String,
    pub html_body: Option<String>,
    pub attachments: Vec<Attachment>,
    pub raw_message: Vec<u8>,
    pub has_attachments: bool,
    pub is_answered: bool,
    pub is_forwarded: bool,
    pub has_calendar: bool,
    pub calendar_json: Option<String>,
    pub list_unsubscribe: Option<String>,
    pub list_unsubscribe_post: Option<String>,
    /// `high`, `low`, or empty. Envelope fetches leave this empty when the
    /// header block does not name importance.
    pub importance: String,
    /// Address that asked for a read receipt. Empty when the header is absent
    /// or not a single usable mailbox.
    pub disposition_to: String,
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

database_operations! {
impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut connection = Connection::open(path).map_err(db_error)?;
        // Check before any pragma writes so a newer file stays untouched.
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db_error)?;
        if version > CURRENT_SCHEMA_VERSION {
            return Err(NEWER_DATABASE.into());
        }
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(db_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(db_error)?;
        // WAL + NORMAL keeps the database consistent after a crash while
        // avoiding an fsync per envelope batch; the outbox claim opts back
        // into FULL for its single must-not-roll-back commit.
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(db_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        connection.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        // Zero freed pages so removed mail is not recoverable from the file.
        connection
            .pragma_update(None, "secure_delete", "ON")
            .map_err(db_error)?;
        migrate_schema(&mut connection)?;
        // A database that still held duplicate emails when v14 or v15 ran keeps
        // working; retrying here restores the unique index once the user has
        // removed the duplicate rows. Best effort: the index build fails while
        // duplicates remain.
        let _ = ensure_account_email_unique_index(&connection);
        connection
            .execute(
                "UPDATE outbox SET state='needs_attention', detail=NULL, reason_code='interruptedSend' WHERE state='sending'",
                [],
            )
            .map_err(db_error)?;
        let reader = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(db_error)?;
        reader
            .busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        reader.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            reader: Some(Arc::new(Mutex::new(reader))),
            attachments_offline: Arc::default(),
            undo_session: Arc::new(Mutex::new(String::new())),
        })
    }

    /// Empty stand-in used when the mail database cannot open, so the window
    /// can explain the problem instead of the app exiting silently.
    pub fn unavailable() -> Result<Self, String> {
        let mut connection = Connection::open_in_memory().map_err(db_error)?;
        migrate_schema(&mut connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            reader: None,
            attachments_offline: Arc::default(),
            undo_session: Arc::new(Mutex::new(String::new())),
        })
    }

    /// Whether whole messages are fetched instead of the first 256 KiB of large ones.
    pub fn keep_attachments_offline(&self) -> bool {
        self.attachments_offline
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn set_keep_attachments_offline(&self, keep: bool) {
        self.attachments_offline
            .store(keep, std::sync::atomic::Ordering::Relaxed);
    }

    /// Repair or verify the search index. Runs after the window opens; a full
    /// rebuild on a large cache can take a while.
    pub fn maintain_search_index(&self) -> Result<(), String> {
        recover_fts_index(&*self.conn()?)
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        migrate_schema(&mut connection).unwrap();
        Self {
            connection: Arc::new(Mutex::new(connection)),
            reader: None,
            attachments_offline: Arc::default(),
            undo_session: Arc::new(Mutex::new(String::new())),
        }
    }

    #[cfg(test)]
    fn slow_query_for_test(&self, started: &tokio::sync::Notify) -> Result<std::time::Instant, String> {
        let conn = self.conn()?;
        started.notify_one();
        conn.query_row(
            "WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM count WHERE x<2000000) SELECT SUM(x) FROM count",
            [], |row| row.get::<_, i64>(0),
        ).map_err(db_error)?;
        Ok(std::time::Instant::now())
    }

    /// The writer only if it is free right now, for housekeeping that can wait
    /// for a later call instead of blocking a read.
    pub(crate) fn try_conn(&self) -> Option<std::sync::MutexGuard<'_, Connection>> {
        match self.connection.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }

    /// Connection for queries that never write. Falls back to the writer.
    pub(crate) fn read_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        Ok(lock_connection(
            self.reader.as_ref().unwrap_or(&self.connection),
        ))
    }

    pub(crate) fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        Ok(lock_connection(&self.connection))
    }

    /// Copy the live frontend session before taking a database read lock.
    pub(crate) fn current_undo_session(&self) -> Result<String, String> {
        Ok(self
            .undo_session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
}
}

/// Mark synchronous work as blocking for Tauri's multithread runtime.
/// Plain threads and synchronous current-thread callers run inline.
fn blocking_work<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

/// A poisoned connection remains usable after transaction rollback on unwind.
fn lock_connection(shared: &Mutex<Connection>) -> std::sync::MutexGuard<'_, Connection> {
    blocking_work(|| {
        shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    })
}

pub(crate) const MESSAGE_SUMMARY_SELECT: &str = "SELECT m.id,m.account_id,m.mailbox_id,m.uid,m.message_id,m.subject,m.sender_name,m.sender_address,m.recipients,m.received_at,m.preview,m.is_read,m.is_starred,m.has_attachments,m.size,m.thread_root,m.has_calendar,m.is_answered,m.is_forwarded,m.importance,m.pinned,EXISTS(SELECT 1 FROM muted_ids mu WHERE mu.account_id=m.account_id AND (mu.message_id=m.message_id OR mu.message_id=m.thread_parent)) AS conversation_muted,m.to_me,m.internal_at AS arrived_at,m.attachment_count,m.flag_color FROM messages m";
pub(crate) const MESSAGE_DETAIL_SELECT: &str = "SELECT m.id,m.account_id,m.mailbox_id,m.uid,m.message_id,m.subject,m.sender_name,m.sender_address,m.recipients,m.received_at,m.preview,m.is_read,m.is_starred,m.has_attachments,m.size,m.to_json,m.cc_json,m.reply_to,m.text_body,m.html_body,m.attachments_json,m.list_unsubscribe,m.list_unsubscribe_post,m.has_calendar,m.is_answered,m.is_forwarded,m.calendar_json,m.thread_root,m.importance,m.disposition_to,m.receipt_choice,m.pinned,m.bcc_json,EXISTS(SELECT 1 FROM muted_ids mu WHERE mu.account_id=m.account_id AND (mu.message_id=m.message_id OR mu.message_id=m.thread_parent)) AS conversation_muted,m.to_me,m.internal_at AS arrived_at,m.attachment_count,m.body_partial AS body_partial,m.flag_color FROM messages m";

/// Stored per row so lists and the "To me" filter never parse JSON per row.
const TO_ME_EXPR: &str = "EXISTS (SELECT 1 FROM accounts a WHERE a.id=messages.account_id AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(messages.to_json) THEN messages.to_json ELSE '[]' END) AS addr WHERE lower(addr.value)=lower(a.email) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(a.aliases_json) THEN a.aliases_json ELSE '[]' END) AS alias WHERE lower(alias.value)=lower(addr.value))))";
const FILE_COUNT_EXPR: &str = "(SELECT COUNT(*) FROM json_each(CASE WHEN json_valid(messages.attachments_json) THEN messages.attachments_json ELSE '[]' END) AS file WHERE COALESCE(json_extract(file.value, '$.inline'), 0) NOT IN (1, 'true'))";

/// Recompute `to_me` and `attachment_count` for the rows `filter` selects.
pub(crate) fn refresh_list_columns(
    connection: &Connection,
    filter: &str,
    values: impl rusqlite::Params,
) -> Result<(), String> {
    connection
        .prepare_cached(&format!(
            "UPDATE messages SET to_me={TO_ME_EXPR}, attachment_count={FILE_COUNT_EXPR} WHERE {filter}"
        ))
        .map_err(db_error)?
        .execute(values)
        .map_err(db_error)?;
    Ok(())
}

pub(crate) fn map_message_summary(row: &Row<'_>) -> rusqlite::Result<MessageSummary> {
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
        size: row.get::<_, i64>(14)?.max(0) as u64,
        thread_root: row.get("thread_root")?,
        // By name: detail rows lay out columns differently.
        has_calendar: row.get::<_, i64>("has_calendar")? != 0,
        is_answered: row.get::<_, i64>("is_answered")? != 0,
        is_forwarded: row.get::<_, i64>("is_forwarded")? != 0,
        conversation_muted: row.get::<_, i64>("conversation_muted")? != 0,
        importance: crate::models::canonical_importance(&row.get::<_, String>("importance")?)
            .to_string(),
        pinned: row.get::<_, i64>("pinned")? != 0,
        to_me: row.get::<_, i64>("to_me")? != 0,
        arrived_at: row
            .get::<_, Option<String>>("arrived_at")?
            .unwrap_or_default(),
        attachment_count: row.get::<_, i64>("attachment_count")?.max(0) as usize,
        // Only the seven colors are stored; anything else reads as unflagged.
        flag_color: u8::try_from(row.get::<_, i64>("flag_color")?)
            .ok()
            .filter(|color| *color <= 6)
            .unwrap_or(0),
    })
}

pub(crate) fn parse_provider(value: &str) -> ProviderKind {
    match value {
        "icloud" => ProviderKind::Icloud,
        "protonBridge" => ProviderKind::ProtonBridge,
        "gmail" => ProviderKind::Gmail,
        "outlook" => ProviderKind::Outlook,
        _ => ProviderKind::Manual,
    }
}
pub(crate) fn parse_tls(value: &str) -> TlsMode {
    if value == "startTls" {
        TlsMode::StartTls
    } else {
        TlsMode::Tls
    }
}
pub(crate) fn parse_role(value: &str) -> MailboxRole {
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
pub(crate) fn json_or_default<T: serde::de::DeserializeOwned + Default>(value: String) -> T {
    serde_json::from_str(&value).unwrap_or_default()
}
pub(crate) fn has_remote_images(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    lower.contains("data-remote-src")
        || lower.contains("src=\"http:")
        || lower.contains("src='http:")
        || lower.contains("src=\"https:")
        || lower.contains("src='https:")
}
pub(crate) fn fts_query(value: &str) -> String {
    value
        .chars()
        .take(200)
        .collect::<String>()
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
pub(crate) fn db_error(error: rusqlite::Error) -> String {
    #[cfg(test)]
    return format!("Postal Snap could not access its local mail database: {error}");
    #[cfg(not(test))]
    {
        let _ = error;
        "Postal Snap could not access its local mail database.".into()
    }
}

pub(crate) fn references_from_raw(raw: &[u8]) -> Vec<String> {
    let text = match std::str::from_utf8(raw) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let header_end = text
        .find("\r\n\r\n")
        .or_else(|| text.find("\n\n"))
        .unwrap_or(text.len());
    let headers = &text[..header_end];
    let mut unfolded = String::with_capacity(headers.len());
    for line in headers.lines() {
        if line.starts_with([' ', '\t']) {
            unfolded.push(' ');
            unfolded.push_str(line.trim());
        } else {
            unfolded.push('\n');
            unfolded.push_str(line);
        }
    }
    let mut references = header_message_ids(&unfolded, "references");
    if references.is_empty() {
        references = header_message_ids(&unfolded, "in-reply-to");
    }
    references
}

fn header_message_ids(headers: &str, field: &str) -> Vec<String> {
    let mut references = Vec::new();
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case(field) {
            continue;
        }
        for token in value.split_whitespace() {
            let trimmed = token.trim().trim_start_matches('<').trim_end_matches('>');
            if trimmed.is_empty() || !trimmed.contains('@') {
                continue;
            }
            let id = format!("<{trimmed}>");
            if !references.contains(&id) {
                references.push(id);
            }
        }
    }
    references
}

pub(crate) fn clear_pending_move_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    message_id: i64,
) -> Result<(), String> {
    type PendingMoveCounts = (i64, bool, Option<i64>, Option<i64>, Option<i64>);
    let row: Option<PendingMoveCounts> = transaction
        .query_row(
            "SELECT mailbox_id,is_read != 0,pending_move_to,pending_source_generation,pending_destination_generation FROM messages WHERE id=?1",
            [message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(db_error)?;
    if let Some((source_id, is_read, Some(destination_id), source_overlay, destination_overlay)) =
        row
    {
        let source_generation: Option<i64> = transaction
            .query_row(
                "SELECT counts_generation FROM mailboxes WHERE id=?1",
                [source_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let destination_generation: Option<i64> = transaction
            .query_row(
                "SELECT counts_generation FROM mailboxes WHERE id=?1",
                [destination_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if source_overlay.is_some() && source_overlay == source_generation {
            adjust_mailbox_counts(transaction, source_id, 1, (!is_read).then_some(1))?;
        }
        if destination_overlay.is_some() && destination_overlay == destination_generation {
            adjust_mailbox_counts(transaction, destination_id, -1, (!is_read).then_some(-1))?;
        }
    }
    transaction.execute(
        "UPDATE messages SET pending_move_to=NULL,pending_source_generation=NULL,pending_destination_generation=NULL WHERE id=?1",
        [message_id],
    ).map_err(db_error)?;
    Ok(())
}

/// Cancel only a queued archive of the source while restoring a legacy held send.
pub(crate) fn cancel_pending_move_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    account_id: &str,
    message_id: i64,
    source_mailbox_id: i64,
) -> Result<bool, String> {
    let row: Option<(String, i64, u32, Option<i64>, String)> = transaction
        .query_row(
            "SELECT m.account_id,m.mailbox_id,m.uid,m.pending_move_to,f.name FROM messages m JOIN mailboxes f ON f.id=m.mailbox_id WHERE m.id=?1",
            [message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(db_error)?;
    let Some((owner, mailbox_id, uid, Some(destination_id), source_name)) = row else {
        return Ok(false);
    };
    if owner != account_id {
        return Err("Message does not belong to this account.".into());
    }
    if mailbox_id != source_mailbox_id {
        return Ok(false);
    }
    let destination: Option<(String, bool)> = transaction.query_row(
        "SELECT m.name, (m.role='archive' OR EXISTS(SELECT 1 FROM folder_assignments a WHERE a.account_id=?2 AND a.mailbox_id=m.id AND a.role='archive')) FROM mailboxes m WHERE m.id=?1 AND m.account_id=?2",
        params![destination_id, account_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(db_error)?;
    let Some((destination_name, true)) = destination else {
        return Ok(false);
    };
    let queued: Option<(i64, String)> = transaction.query_row(
        "SELECT id,payload FROM offline_ops WHERE account_id=?1 AND kind='move' AND dedupe_key=?2",
        params![account_id, format!("move:{message_id}")],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(db_error)?;
    let Some((operation_id, payload)) = queued else {
        return Ok(false);
    };
    let operation: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|_| "Queued archive could not be read.".to_string())?;
    if operation["messageId"] != message_id
        || operation["uid"] != uid
        || operation["source"] != source_name
        || operation["destination"] != destination_name
    {
        return Ok(false);
    }
    clear_pending_move_in_transaction(transaction, message_id)?;
    transaction
        .execute(
            "DELETE FROM offline_ops WHERE id=?1 AND account_id=?2",
            params![operation_id, account_id],
        )
        .map_err(db_error)?;
    Ok(true)
}

/// Restore the database-level unique email guarantee. This is a no-op when the
/// index already exists and an error while duplicate rows remain; callers that
/// want self-healing ignore that error and retry after cleanup.
fn ensure_account_email_unique_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts(email);",
        )
        .map_err(db_error)
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

/// Canonical stored timestamp format: whole seconds, explicit UTC offset.
/// Fractional seconds would otherwise sort on the wrong side of the
/// text-compared `received_at` cursor used by message pagination.
pub(crate) fn normalize_received_at(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| {
            parsed
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, false)
        })
        .unwrap_or_else(|_| value.to_string())
}

/// FTS rows are maintained alongside `messages`; repair the index when the
/// row counts drift or a periodic integrity check fails. The check is guarded
/// by a day-long marker so opening a large mailbox does not pay for it every
/// launch.
fn recover_fts_index(connection: &Connection) -> Result<(), String> {
    let counts_match: bool = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM messages) = (SELECT COUNT(*) FROM message_fts)",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !counts_match {
        return rebuild_fts_index(connection);
    }
    let last_checked: Option<i64> = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key='fts_checked_at'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let due = last_checked
        .map(|seconds| Utc::now().timestamp().saturating_sub(seconds) >= 86_400)
        .unwrap_or(true);
    if !due {
        return Ok(());
    }
    if connection
        .execute_batch("INSERT INTO message_fts(message_fts) VALUES('integrity-check');")
        .is_err()
    {
        return rebuild_fts_index(connection);
    }
    mark_fts_checked(connection)
}

fn rebuild_fts_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "DELETE FROM message_fts;
             INSERT INTO message_fts(rowid, subject, sender, recipients, body)
               SELECT id, subject, sender_name || ' ' || sender_address, recipients, text_body
               FROM messages;",
        )
        .map_err(db_error)?;
    mark_fts_checked(connection)
}

fn mark_fts_checked(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('fts_checked_at',?1)",
            [Utc::now().timestamp().to_string()],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(crate) fn synthetic_thread_id(mailbox_id: i64, uid: u32) -> String {
    format!("<uid-{mailbox_id}-{uid}@local>")
}

/// Best-effort thread root at insert time from currently cached rows.
/// [`Database::repair_thread_roots`] corrects it once more of the thread
/// has synced.
pub(crate) fn provisional_thread_root(
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
            .prepare_cached("SELECT COALESCE(thread_root, message_id, ?3) FROM messages WHERE account_id=?1 AND message_id=?2 LIMIT 1")
            .map_err(db_error)?
            .query_row(
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

pub(crate) fn replace_attachment_refs(
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

pub(crate) fn adjust_mailbox_counts(
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

// This batch also runs against unversioned legacy databases. Indexes that use
// columns added by later migrations must stay in those migrations, after the
// corresponding `ensure_column` calls.
const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'idle', error TEXT,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_tls TEXT NOT NULL, imap_username TEXT NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_tls TEXT NOT NULL, smtp_username TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  notify_new_mail INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'other',
  uid_validity INTEGER, uid_next INTEGER, backfill_uid INTEGER, allows_keywords INTEGER NOT NULL DEFAULT 1, UNIQUE(account_id,name)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, uid INTEGER NOT NULL,
  message_id TEXT, subject TEXT NOT NULL DEFAULT '', sender_name TEXT NOT NULL DEFAULT '', sender_address TEXT NOT NULL DEFAULT '',
  recipients TEXT NOT NULL DEFAULT '', received_at TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0, to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]', reply_to TEXT,
  text_body TEXT NOT NULL DEFAULT '', html_body TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', raw_message BLOB NOT NULL DEFAULT X'',
  accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, pending_move_to INTEGER, thread_parent TEXT, thread_root TEXT, flag_color INTEGER NOT NULL DEFAULT 0, UNIQUE(mailbox_id,uid)
);
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(subject, sender, recipients, body, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, draft_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recipient_history (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, address TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', use_count INTEGER NOT NULL DEFAULT 0, last_used TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(account_id, address));
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, draft_json TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, send_at TEXT);
CREATE TABLE IF NOT EXISTS offline_ops (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS snoozed_messages (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, snoozed_until TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(account_id, message_id));
CREATE INDEX IF NOT EXISTS snoozed_messages_due ON snoozed_messages(account_id,snoozed_until);
CREATE TABLE IF NOT EXISTS filter_rules (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', field TEXT NOT NULL DEFAULT 'from', contains TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT 'mark_read', target_mailbox TEXT, enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, match_mode TEXT NOT NULL DEFAULT 'all', conditions_json TEXT NOT NULL DEFAULT '[]', actions_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS filter_rules_account ON filter_rules(account_id,position);
CREATE TABLE IF NOT EXISTS recent_searches (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, query TEXT NOT NULL, used_at TEXT NOT NULL, PRIMARY KEY(account_id, query));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS file_grants (token TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS messages_mailbox_date ON messages(mailbox_id,received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts(email);
CREATE INDEX IF NOT EXISTS messages_mailbox_date_uid ON messages(mailbox_id,received_at DESC,uid DESC);
CREATE INDEX IF NOT EXISTS messages_account ON messages(account_id);
CREATE TRIGGER IF NOT EXISTS messages_after_delete AFTER DELETE ON messages BEGIN DELETE FROM message_fts WHERE rowid=OLD.id; END;
"#;

#[cfg(test)]
mod read_conn_guard;
#[cfg(test)]
mod tests;
