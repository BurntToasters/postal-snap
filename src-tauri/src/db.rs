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

pub(crate) const CURRENT_SCHEMA_VERSION: u32 = 41;

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

pub(crate) const MESSAGE_SUMMARY_SELECT: &str = "SELECT m.id,m.account_id,m.mailbox_id,m.uid,m.message_id,m.subject,m.sender_name,m.sender_address,m.recipients,m.received_at,m.preview,m.is_read,m.is_starred,m.has_attachments,m.size,m.thread_root,m.has_calendar,m.is_answered,m.is_forwarded,m.importance,m.pinned,EXISTS(SELECT 1 FROM muted_ids mu WHERE mu.account_id=m.account_id AND (mu.message_id=m.message_id OR mu.message_id=m.thread_parent)) AS conversation_muted,m.to_me,m.internal_at AS arrived_at,m.attachment_count FROM messages m";
pub(crate) const MESSAGE_DETAIL_SELECT: &str = "SELECT m.id,m.account_id,m.mailbox_id,m.uid,m.message_id,m.subject,m.sender_name,m.sender_address,m.recipients,m.received_at,m.preview,m.is_read,m.is_starred,m.has_attachments,m.size,m.to_json,m.cc_json,m.reply_to,m.text_body,m.html_body,m.attachments_json,m.list_unsubscribe,m.list_unsubscribe_post,m.has_calendar,m.is_answered,m.is_forwarded,m.calendar_json,m.thread_root,m.importance,m.disposition_to,m.receipt_choice,m.pinned,m.bcc_json,EXISTS(SELECT 1 FROM muted_ids mu WHERE mu.account_id=m.account_id AND (mu.message_id=m.message_id OR mu.message_id=m.thread_parent)) AS conversation_muted,m.to_me,m.internal_at AS arrived_at,m.attachment_count,m.body_partial AS body_partial FROM messages m";

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
  size INTEGER NOT NULL DEFAULT 0, to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]', reply_to TEXT,
  text_body TEXT NOT NULL DEFAULT '', html_body TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', raw_message BLOB NOT NULL DEFAULT X'',
  accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, pending_move_to INTEGER, thread_parent TEXT, thread_root TEXT, UNIQUE(mailbox_id,uid)
);
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(subject, sender, recipients, body, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, draft_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recipient_history (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, address TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', use_count INTEGER NOT NULL DEFAULT 0, last_used TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(account_id, address));
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, draft_json TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, send_at TEXT);
CREATE TABLE IF NOT EXISTS offline_ops (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS snoozed_messages (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, snoozed_until TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(account_id, message_id));
CREATE INDEX IF NOT EXISTS snoozed_messages_due ON snoozed_messages(account_id,snoozed_until);
CREATE TABLE IF NOT EXISTS filter_rules (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', field TEXT NOT NULL DEFAULT 'from', contains TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT 'mark_read', target_mailbox TEXT, enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
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
mod tests {
    use super::migrations::migrate_v19;
    use super::*;
    use crate::mail::failure::MailError;

    // Undo must not remove a separate move made after the send became uncertain.
    #[test]
    fn restoring_uncertain_send_preserves_later_move() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let trash = mailbox(&db, &account.summary.id, "Trash", &MailboxRole::Trash);
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        let outbox_id = db
            .queue_outbox_with_archive(
                &draft(&account.summary.id),
                "needs_attention",
                None,
                "<send@example.test>",
                b"mime",
                None,
                Some((message_id, inbox)),
            )
            .unwrap();
        let move_payload = serde_json::json!({"messageId":message_id,"uid":1,"source":"INBOX","destination":"Trash","uidValidity":1});
        db.queue_operation(
            &account.summary.id,
            "move",
            &move_payload,
            Some(&format!("move:{message_id}")),
        )
        .unwrap();
        db.mark_pending_move(message_id, trash).unwrap();
        db.restore_outbox_as_draft(&outbox_id, &account.summary.id)
            .unwrap();
        assert_eq!(db.queued_operations(&account.summary.id).unwrap().len(), 1);
        assert!(db.list_messages(inbox, None, 10).unwrap().items.is_empty());
    }

    #[test]
    fn clearing_pending_move_after_status_does_not_inflate_counts() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(1),
                1,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account.summary.id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(2),
                Some(0),
                0,
            )
            .unwrap();
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.mark_pending_move(message_id, archive).unwrap();
        db.upsert_mailbox(
            &account.summary.id,
            "INBOX",
            &MailboxRole::Inbox,
            Some(1),
            Some(2),
            Some(1),
            1,
        )
        .unwrap();
        db.upsert_mailbox(
            &account.summary.id,
            "Archive",
            &MailboxRole::Archive,
            Some(1),
            Some(2),
            Some(0),
            0,
        )
        .unwrap();
        db.clear_pending_move(message_id).unwrap();
        let boxes = db.list_mailboxes(&account.summary.id).unwrap();
        let inbox_counts = boxes.iter().find(|item| item.id == inbox).unwrap();
        assert_eq!(
            (inbox_counts.total_count, inbox_counts.unread_count),
            (1, 1)
        );
    }

    #[test]
    fn record_flag_change_during_pending_move_updates_destination_counts() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(5),
                10,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account.summary.id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(2),
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
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;

        db.mark_pending_move(message_id, archive).unwrap();
        db.record_flag_change(&account.summary.id, message_id, Some(true), None, None)
            .unwrap();

        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (9, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (4, 1));

        db.clear_pending_move(message_id).unwrap();

        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (10, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));
    }

    fn deferred_fixture() -> (Database, String, i64, i64, i64) {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let account_id = account.summary.id.clone();
        let inbox = db
            .upsert_mailbox(
                &account_id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(5),
                10,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account_id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(2),
                Some(1),
                3,
            )
            .unwrap();
        db.upsert_message(&account_id, inbox, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap();
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        (db, account_id, inbox, archive, message_id)
    }

    fn deferred_move_payload(
        message_id: i64,
        source: &str,
        destination: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "messageId": message_id,
            "uid": 1,
            "source": source,
            "destination": destination,
            "uidValidity": 2,
        })
    }

    fn future(seconds: i64) -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now() + chrono::TimeDelta::seconds(seconds)
    }

    #[test]
    fn deferred_move_stays_hidden_until_committed() {
        let (db, account_id, inbox, archive, message_id) = deferred_fixture();
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            "undo-1",
            future(3600),
        )
        .unwrap();

        assert!(db.queued_operations(&account_id).unwrap().is_empty());
        assert_eq!(mailbox_counts(&db, &account_id, inbox), (9, 4));
        assert_eq!(mailbox_counts(&db, &account_id, archive), (4, 2));
        let due = db.next_deferred_due(&account_id).unwrap().unwrap();
        assert!(due > std::time::Duration::from_secs(3000));

        db.commit_deferred(&account_id, "undo-1").unwrap();

        let queued = db.queued_operations(&account_id).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].1, "move");
        assert!(db.next_deferred_due(&account_id).unwrap().is_none());
    }

    #[test]
    fn deferred_move_past_its_due_time_replays_without_commit() {
        let (db, account_id, _, archive, message_id) = deferred_fixture();
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            "undo-1",
            future(-1),
        )
        .unwrap();

        assert_eq!(db.queued_operations(&account_id).unwrap().len(), 1);
        assert!(db.next_deferred_due(&account_id).unwrap().is_none());
    }

    #[test]
    fn live_undo_session_keeps_expired_moves_and_their_dependencies_held() {
        let (db, account_id, _inbox, archive, message_id) = deferred_fixture();
        let session = db.begin_undo_session().unwrap();
        let token = format!("{session}{}", "a".repeat(32));
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            &token,
            future(-1),
        )
        .unwrap();
        db.queue_operation(
            &account_id,
            "flags",
            &serde_json::json!({"messageId":message_id,"uid":1,"mailbox":"INBOX","uidValidity":2,"isRead":true}),
            Some(&format!("flags:{message_id}:true:false")),
        )
        .unwrap();

        assert!(db.queued_operations(&account_id).unwrap().is_empty());
        assert!(db.next_deferred_due(&account_id).unwrap().is_none());
        assert_eq!(db.undo_deferred(&account_id, &token).unwrap(), (1, false));
        let queued = db.queued_operations(&account_id).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].1, "flags");

        let commit_token = format!("{session}{}", "e".repeat(32));
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            &commit_token,
            future(3600),
        )
        .unwrap();
        assert_eq!(db.queued_operations(&account_id).unwrap().len(), 1);
        db.commit_deferred(&account_id, &commit_token).unwrap();
        assert_eq!(db.queued_operations(&account_id).unwrap().len(), 2);
        assert!(db.next_deferred_due(&account_id).unwrap().is_none());
    }

    #[test]
    fn restarting_undo_session_releases_old_moves_and_rejects_stale_enqueue() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        let account = account();
        let account_id = account.summary.id.clone();
        let db = Database::open(&path).unwrap();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account_id, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, &account_id, "Archive", &MailboxRole::Archive);
        db.upsert_message(&account_id, inbox, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap();
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        let old_session = db.begin_undo_session().unwrap();
        let old_token = format!("{old_session}{}", "b".repeat(32));
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            &old_token,
            future(3600),
        )
        .unwrap();
        drop(db);

        let db = Database::open(&path).unwrap();
        let new_session = db.begin_undo_session().unwrap();
        assert_ne!(old_session, new_session);
        assert_eq!(db.queued_operations(&account_id).unwrap().len(), 1);
        assert!(db.next_deferred_due(&account_id).unwrap().is_none());
        assert!(db
            .defer_moves::<serde_json::Value>(&account_id, &[], &old_token, future(3600))
            .is_err());
    }

    #[test]
    fn undo_deferred_restores_source_row_and_counts() {
        let (db, account_id, inbox, archive, message_id) = deferred_fixture();
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            "undo-1",
            future(3600),
        )
        .unwrap();

        assert_eq!(db.undo_deferred(&account_id, "undo-1").unwrap(), (1, false));

        assert_eq!(db.list_messages(inbox, None, 10).unwrap().items.len(), 1);
        assert!(db
            .list_messages(archive, None, 10)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(mailbox_counts(&db, &account_id, inbox), (10, 5));
        assert_eq!(mailbox_counts(&db, &account_id, archive), (3, 1));
        assert!(db.queued_operations(&account_id).unwrap().is_empty());
        assert_eq!(db.undo_deferred(&account_id, "undo-1").unwrap(), (0, true));
    }

    #[test]
    fn undo_after_replay_reports_already_committed() {
        let (db, account_id, inbox, archive, message_id) = deferred_fixture();
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            "undo-1",
            future(-1),
        )
        .unwrap();
        let operation_id = db.queued_operations(&account_id).unwrap()[0].0;
        // Replay removes the operation and the moved row.
        db.remove_operation(&account_id, operation_id).unwrap();
        db.remove_moved_messages(&account_id, &[message_id], "Archive")
            .unwrap();

        assert_eq!(db.undo_deferred(&account_id, "undo-1").unwrap(), (0, true));
        assert!(db.list_messages(inbox, None, 10).unwrap().items.is_empty());
    }

    #[test]
    fn bulk_defer_is_atomic_when_one_entry_fails() {
        let (db, account_id, inbox, archive, message_id) = deferred_fixture();
        let missing_id = message_id + 1000;

        let result = db.defer_moves(
            &account_id,
            &[
                (
                    message_id,
                    deferred_move_payload(message_id, "INBOX", "Archive"),
                    archive,
                ),
                (
                    missing_id,
                    deferred_move_payload(missing_id, "INBOX", "Archive"),
                    archive,
                ),
            ],
            "undo-1",
            future(3600),
        );

        assert!(result.is_err());
        assert_eq!(offline_op_count(&db), 0);
        assert_eq!(mailbox_counts(&db, &account_id, inbox), (10, 5));
        assert_eq!(mailbox_counts(&db, &account_id, archive), (3, 1));
        assert_eq!(db.undo_deferred(&account_id, "undo-1").unwrap(), (0, true));
    }

    #[test]
    fn flag_change_during_window_survives_undo_and_commit() {
        let (db, account_id, inbox, archive, message_id) = deferred_fixture();
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            "undo-1",
            future(3600),
        )
        .unwrap();
        let flag = serde_json::json!({
            "messageId": message_id,
            "uid": 1,
            "mailbox": "INBOX",
            "uidValidity": 2,
        });
        db.record_flag_change(&account_id, message_id, Some(true), None, Some(&flag))
            .unwrap();

        assert_eq!(db.undo_deferred(&account_id, "undo-1").unwrap(), (1, false));
        let queued = db.queued_operations(&account_id).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].1, "flags");
        assert_eq!(mailbox_counts(&db, &account_id, inbox), (10, 4));

        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            "undo-2",
            future(3600),
        )
        .unwrap();
        db.record_flag_change(&account_id, message_id, Some(true), None, Some(&flag))
            .unwrap();
        db.commit_deferred(&account_id, "undo-2").unwrap();

        // The flag row is re-queued after the move, so it replays with the move.
        let mut kinds: Vec<String> = db
            .queued_operations(&account_id)
            .unwrap()
            .into_iter()
            .map(|(_, kind, _)| kind)
            .collect();
        kinds.sort();
        assert_eq!(kinds, vec!["flags".to_string(), "move".to_string()]);
    }

    #[test]
    fn later_op_for_same_message_waits_for_deferred_move() {
        let (db, account_id, inbox, archive, message_id) = deferred_fixture();
        db.upsert_message(&account_id, inbox, &message(2, "2026-08-18T13:00:00Z"))
            .unwrap();
        let other_id = db
            .list_messages(inbox, None, 10)
            .unwrap()
            .items
            .iter()
            .map(|item| item.id)
            .find(|id| *id != message_id)
            .unwrap();
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            "undo-1",
            future(3600),
        )
        .unwrap();
        let flag_for = |id: i64| {
            serde_json::json!({
                "messageId": id,
                "uid": 1,
                "mailbox": "INBOX",
                "uidValidity": 2,
                "isRead": true,
            })
        };
        db.queue_operation(
            &account_id,
            "flags",
            &flag_for(message_id),
            Some(&format!("flags:{message_id}:true:false")),
        )
        .unwrap();
        db.queue_operation(
            &account_id,
            "flags",
            &flag_for(other_id),
            Some(&format!("flags:{other_id}:true:false")),
        )
        .unwrap();

        let before: Vec<String> = db
            .queued_operations(&account_id)
            .unwrap()
            .into_iter()
            .map(|(_, _, payload)| payload)
            .collect();
        assert_eq!(before.len(), 1);
        assert!(before[0].contains(&format!("\"messageId\":{other_id}")));

        db.commit_deferred(&account_id, "undo-1").unwrap();
        let kinds: Vec<String> = db
            .queued_operations(&account_id)
            .unwrap()
            .into_iter()
            .map(|(_, kind, _)| kind)
            .collect();
        assert_eq!(kinds, vec!["move", "flags", "flags"]);
    }

    #[test]
    fn migration_37_upgrades_v36_database_preserving_offline_ops() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            let account = account();
            db.insert_account(&account).unwrap();
            db.queue_operation(
                &account.summary.id,
                "flags",
                &serde_json::json!({ "messageId": 7 }),
                Some("flags:7:true:false"),
            )
            .unwrap();
        }
        {
            // Rebuild the v36 shape by dropping only the columns from v37.
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "DROP INDEX offline_ops_not_before;
                     ALTER TABLE offline_ops DROP COLUMN attempts;
                     ALTER TABLE offline_ops DROP COLUMN undo_token;
                     ALTER TABLE offline_ops DROP COLUMN not_before;
                     PRAGMA user_version=36;",
                )
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        let conn = migrated.conn().unwrap();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        let (count, attempts, not_before_is_null): (i64, i64, bool) = conn
            .query_row(
                "SELECT COUNT(*),MIN(attempts),MIN(not_before IS NULL) FROM offline_ops",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((count, attempts, not_before_is_null), (1, 0, true));
    }

    #[test]
    fn removing_an_account_deletes_its_deferred_moves() {
        let (db, account_id, _, archive, message_id) = deferred_fixture();
        db.defer_moves(
            &account_id,
            &[(
                message_id,
                deferred_move_payload(message_id, "INBOX", "Archive"),
                archive,
            )],
            "undo-1",
            future(3600),
        )
        .unwrap();

        db.remove_account(&account_id).unwrap();

        assert_eq!(offline_op_count(&db), 0);
    }

    #[test]
    fn transient_replay_failures_count_attempts() {
        let (db, account_id, _, _, message_id) = deferred_fixture();
        db.queue_operation(
            &account_id,
            "flags",
            &serde_json::json!({ "messageId": message_id }),
            Some("flags:1:true:false"),
        )
        .unwrap();
        let operation_id = db.queued_operations(&account_id).unwrap()[0].0;

        db.record_operation_attempt(&account_id, operation_id)
            .unwrap();
        db.record_operation_attempt(&account_id, operation_id)
            .unwrap();

        let attempts: i64 = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT attempts FROM offline_ops WHERE id=?1",
                [operation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 2);
    }

    fn offline_op_count(db: &Database) -> i64 {
        db.conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM offline_ops", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn set_flags_during_pending_move_survives_destination_replacement() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(5),
                10,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account.summary.id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(2),
                Some(1),
                3,
            )
            .unwrap();
        let trash = db
            .upsert_mailbox(
                &account.summary.id,
                "Trash",
                &MailboxRole::Trash,
                Some(1),
                Some(2),
                Some(2),
                7,
            )
            .unwrap();
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;

        db.mark_pending_move(message_id, archive).unwrap();
        db.set_flags(message_id, Some(true), None).unwrap();
        db.mark_pending_move(message_id, trash).unwrap();

        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (9, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));
        assert_eq!(mailbox_counts(&db, &account.summary.id, trash), (8, 2));

        db.clear_pending_move(message_id).unwrap();

        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (10, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));
        assert_eq!(mailbox_counts(&db, &account.summary.id, trash), (7, 2));
    }

    #[test]
    fn status_refresh_invalidates_pending_move_count_overlays() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(5),
                10,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account.summary.id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(2),
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
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.mark_pending_move(message_id, archive).unwrap();

        db.update_mailbox_status(inbox, Some(1), Some(2), Some(4), 9)
            .unwrap();
        db.update_mailbox_status(archive, Some(1), Some(2), Some(2), 3)
            .unwrap();
        db.clear_pending_move(message_id).unwrap();

        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (9, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 2));
    }

    #[test]
    fn destination_status_reset_routes_flag_deltas_only_to_stale_source() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(5),
                5,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account.summary.id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(2),
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
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.mark_pending_move(message_id, archive).unwrap();

        db.update_mailbox_status(archive, Some(1), Some(2), Some(1), 3)
            .unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (4, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));

        db.record_flag_change(&account.summary.id, message_id, Some(true), None, None)
            .unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (4, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));
        db.record_flag_change(&account.summary.id, message_id, Some(false), None, None)
            .unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (4, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));
        db.set_flags(message_id, Some(true), None).unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (4, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));
        db.set_flags(message_id, Some(false), None).unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (4, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));

        db.clear_pending_move(message_id).unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (5, 5));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));
    }

    #[test]
    fn source_status_reset_updates_source_and_active_destination() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(5),
                5,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account.summary.id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(2),
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
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.mark_pending_move(message_id, archive).unwrap();

        db.update_mailbox_status(inbox, Some(1), Some(2), Some(5), 5)
            .unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (5, 5));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (4, 2));

        db.record_flag_change(&account.summary.id, message_id, Some(true), None, None)
            .unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (5, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (4, 1));
        db.record_flag_change(&account.summary.id, message_id, Some(false), None, None)
            .unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (5, 5));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (4, 2));
        db.set_flags(message_id, Some(true), None).unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (5, 4));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (4, 1));
        db.set_flags(message_id, Some(false), None).unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (5, 5));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (4, 2));

        db.clear_pending_move(message_id).unwrap();
        assert_eq!(mailbox_counts(&db, &account.summary.id, inbox), (5, 5));
        assert_eq!(mailbox_counts(&db, &account.summary.id, archive), (3, 1));
    }

    #[test]
    fn successful_read_change_preserves_only_unrelated_queued_star() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let message_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        let combined = serde_json::json!({"messageId":message_id,"uid":1,"mailbox":"INBOX","uidValidity":1,"isRead":true,"isStarred":true});
        db.queue_operation(
            &account.summary.id,
            "flags",
            &combined,
            Some(&format!("flags:{message_id}:true:true")),
        )
        .unwrap();
        db.record_flag_change(&account.summary.id, message_id, Some(false), None, None)
            .unwrap();
        let operations = db.queued_operations(&account.summary.id).unwrap();
        assert_eq!(operations.len(), 1);
        let queued: serde_json::Value = serde_json::from_str(&operations[0].2).unwrap();
        assert!(queued["isRead"].is_null());
        assert_eq!(queued["isStarred"], true);
        assert!(!db.list_messages(inbox, None, 10).unwrap().items[0].is_read);
    }

    fn account() -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
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
            internal_at: None,
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
            bcc: vec![],
            reply_to: None,
            thread_parent: None,
            text_body: "Bring sandwiches".into(),
            html_body: None,
            attachments: vec![],
            raw_message: b"Subject: Family picnic\r\n\r\nBring sandwiches".to_vec(),
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

    fn draft(account_id: &str) -> ComposeDraft {
        ComposeDraft {
            body_format: crate::models::BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            include_signature: true,
            importance: String::new(),
            request_receipt: false,
            reply_to: None,
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
            send_at: None,
        }
    }

    fn mailbox(db: &Database, account_id: &str, name: &str, role: &MailboxRole) -> i64 {
        db.upsert_mailbox(account_id, name, role, Some(1), Some(2), Some(0), 0)
            .unwrap()
    }

    fn mailbox_counts(db: &Database, account_id: &str, mailbox_id: i64) -> (u32, u32) {
        let mailboxes = db.list_mailboxes(account_id).unwrap();
        let mailbox = mailboxes.iter().find(|item| item.id == mailbox_id).unwrap();
        (mailbox.total_count, mailbox.unread_count)
    }

    fn accounts_email_unique_index_exists(db: &Database) -> bool {
        db.conn()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='accounts_email_unique')",
                [],
                |row| row.get(0),
            )
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
        assert_eq!(
            fts_query(&"x".repeat(10_000)),
            format!("\"{}\"*", "x".repeat(200))
        );
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
        db.set_backfill(mailbox, Some(40), "cutoff").unwrap();

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
        assert_eq!(
            db.mailbox_sync_meta(mailbox).unwrap().backfill_state,
            "active"
        );
    }

    #[test]
    fn uidvalidity_becoming_unknown_or_known_resets_cached_uids() {
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

        db.upsert_mailbox(
            &account.summary.id,
            "INBOX",
            &MailboxRole::Inbox,
            None,
            Some(2),
            Some(0),
            0,
        )
        .unwrap();
        assert_eq!(db.max_uid(mailbox).unwrap(), 0);

        db.upsert_message(
            &account.summary.id,
            mailbox,
            &message(2, "2026-08-18T13:00:00Z"),
        )
        .unwrap();
        db.upsert_mailbox(
            &account.summary.id,
            "INBOX",
            &MailboxRole::Inbox,
            Some(2),
            Some(3),
            Some(0),
            0,
        )
        .unwrap();
        assert_eq!(db.max_uid(mailbox).unwrap(), 0);
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
    fn listed_drafts_keep_the_message_they_answer() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let plain = db.save_draft(&draft(&account.summary.id)).unwrap();
        let mut reply = draft(&account.summary.id);
        reply.source_message_id = Some(10);
        reply.source_kind = Some(crate::models::DraftSourceKind::Reply);
        let reply_id = db.save_draft(&reply).unwrap();
        let listed = db.list_drafts(&account.summary.id).unwrap();
        let saved = listed.iter().find(|item| item.id == reply_id).unwrap();
        assert_eq!(saved.source_message_id, Some(10));
        assert_eq!(
            saved.source_kind,
            Some(crate::models::DraftSourceKind::Reply)
        );
        let fresh = listed.iter().find(|item| item.id == plain).unwrap();
        assert_eq!(fresh.source_message_id, None);
        assert_eq!(fresh.source_kind, None);
    }

    #[test]
    fn draft_times_are_utc_rfc3339_even_for_legacy_rows() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let id = db.save_draft(&draft(&account.summary.id)).unwrap();
        db.conn()
            .unwrap()
            .execute(
                "UPDATE drafts SET updated_at='2026-09-26 04:27:52' WHERE id=?1",
                [id.clone()],
            )
            .unwrap();
        let listed = db.list_drafts(&account.summary.id).unwrap();
        let parsed = chrono::DateTime::parse_from_rfc3339(&listed[0].updated_at).unwrap();
        assert_eq!(
            parsed.with_timezone(&chrono::Utc).to_rfc3339(),
            "2026-09-26T04:27:52+00:00"
        );
        let fresh = db.save_draft(&draft(&account.summary.id)).unwrap();
        let listed = db.list_drafts(&account.summary.id).unwrap();
        let saved = listed.iter().find(|item| item.id == fresh).unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(&saved.updated_at).is_ok());
    }

    #[test]
    fn drafts_sort_by_time_across_stored_formats() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let local = db.save_draft(&draft(&account.summary.id)).unwrap();
        let imported = db.save_draft(&draft(&account.summary.id)).unwrap();
        let conn = db.conn().unwrap();
        conn.execute(
            "UPDATE drafts SET updated_at='2026-09-26 05:00:00' WHERE id=?1",
            [local.clone()],
        )
        .unwrap();
        conn.execute(
            "UPDATE drafts SET updated_at='2026-09-26T04:00:00+00:00' WHERE id=?1",
            [imported.clone()],
        )
        .unwrap();
        drop(conn);
        let listed = db.list_drafts(&account.summary.id).unwrap();
        let order: Vec<_> = listed.iter().map(|item| item.id.clone()).collect();
        assert_eq!(order, vec![local, imported]);
    }

    // Stored list-column failure modes:
    // 1. Adding or removing an alias leaves "To me" stale on cached mail.
    // 2. A body download changes the files but not the file count.
    // 3. Inline pictures are counted as files.
    // 4. Rows from before the upgrade keep zero values.
    #[test]
    fn to_me_and_file_count_are_stored_and_kept_current() {
        use crate::models::{MessageListFilter, MessageListSort};
        let db = Database::memory();
        let account = account();
        let id = account.summary.id.clone();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &id, "INBOX", &MailboxRole::Inbox);
        let file = |name: &str, inline: bool| Attachment {
            id: name.into(),
            filename: name.into(),
            content_type: "application/pdf".into(),
            size: 10,
            content_id: None,
            inline,
        };
        let mut to_alias = message(1, "2026-08-18T12:00:00Z");
        to_alias.to = vec!["Sam@Alias.example".into()];
        db.upsert_envelope(&id, inbox, &to_alias).unwrap();
        let mut with_files = message(2, "2026-08-19T12:00:00Z");
        with_files.attachments = vec![
            file("a.pdf", false),
            file("b.pdf", false),
            file("c.png", true),
        ];
        db.upsert_message(&id, inbox, &with_files).unwrap();
        let row = |db: &Database, uid: u32| db.message_summary_by_uid(inbox, uid).unwrap().unwrap();
        assert!(!row(&db, 1).to_me);
        assert!(row(&db, 2).to_me);
        assert_eq!(row(&db, 2).attachment_count, 2);

        db.update_account_aliases(&id, &["sam@alias.example".into()])
            .unwrap();
        assert!(row(&db, 1).to_me);
        let filtered = db
            .list_messages_filtered(
                inbox,
                None,
                10,
                MessageListFilter::ToMe,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(filtered.items.len(), 2);
        db.update_account_aliases(&id, &[]).unwrap();
        assert!(!row(&db, 1).to_me);

        with_files.attachments = vec![file("a.pdf", false)];
        db.upsert_message(&id, inbox, &with_files).unwrap();
        assert_eq!(row(&db, 2).attachment_count, 1);

        {
            let mut conn = db.conn().unwrap();
            conn.execute_batch(
                "UPDATE messages SET to_me=0, attachment_count=0; PRAGMA user_version=33;",
            )
            .unwrap();
            migrate_schema(&mut conn).unwrap();
        }
        assert!(row(&db, 2).to_me);
        assert_eq!(row(&db, 2).attachment_count, 1);
    }

    // A failed list-column refresh must roll back the alias change too.
    #[test]
    fn alias_refresh_failure_rolls_back_aliases() {
        let db = Database::memory();
        let account = account();
        let id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(id, inbox, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap();
        db.conn().unwrap().execute_batch(
            "CREATE TRIGGER fail_list_refresh BEFORE UPDATE OF to_me ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END;"
        ).unwrap();
        assert!(db
            .update_account_aliases(id, &["alias@example.test".into()])
            .is_err());
        assert_eq!(
            db.account(id).unwrap().summary.aliases,
            account.summary.aliases
        );
    }

    // Outbox reason migration failure modes:
    // 1. Known guidance is stored as prose instead of a stable reason code.
    // 2. Migration loses unknown legacy detail or changes delivery state/MIME.
    // 3. Startup recovery queues an uncertain send automatically.
    #[test]
    fn outbox_reason_codes_preserve_legacy_data_and_send_safety() {
        let db = Database::memory();
        let account = account();
        let owner = &account.summary.id;
        db.insert_account(&account).unwrap();
        let id = db
            .queue_outbox(
                &draft(owner),
                "needs_attention",
                Some("Delivery could not be confirmed. Postal Snap will not resend automatically."),
                "<reason@example.test>",
                b"original MIME",
                None,
            )
            .unwrap();
        let stored = || {
            db.conn()
                .unwrap()
                .query_row(
                    "SELECT reason_code,detail,state,mime_bytes FROM outbox WHERE id=?1",
                    [&id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Vec<u8>>(3)?,
                        ))
                    },
                )
                .unwrap()
        };
        assert_eq!(stored().0.as_deref(), Some("deliveryUncertain"));
        assert_eq!(stored().1, None);
        {
            let mut conn = db.conn().unwrap();
            conn.execute(
                "UPDATE outbox SET reason_code=NULL, detail='Unknown legacy guidance' WHERE id=?1",
                [&id],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 34).unwrap();
            migrate_schema(&mut conn).unwrap();
        }
        assert_eq!(
            stored(),
            (
                None,
                Some("Unknown legacy guidance".into()),
                "needs_attention".into(),
                b"original MIME".to_vec()
            )
        );
        db.set_outbox_state(
            &id,
            owner,
            "needs_attention",
            Some("Delivery could not be confirmed. Postal Snap will not resend automatically."),
        )
        .unwrap();
        assert_eq!(stored().0.as_deref(), Some("deliveryUncertain"));
        assert_eq!(stored().2, "needs_attention");
    }

    // Query-execution failure modes:
    // 1. An uncontended long query stalls other tasks on a one-worker runtime.
    // 2. Nested database calls panic or lose transaction ordering.
    // 3. Plain threads and current-thread test runtimes stop working.
    #[test]
    fn running_a_long_query_does_not_stall_other_tasks() {
        let db = Database::memory();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_time()
            .build()
            .unwrap();
        let started = std::sync::Arc::new(tokio::sync::Notify::new());
        let query_started = started.clone();
        let (other_finished, query_finished) = runtime.block_on(async move {
            let query =
                tokio::spawn(async move { db.slow_query_for_test(&query_started).unwrap() });
            started.notified().await;
            let other_finished = tokio::spawn(async { std::time::Instant::now() })
                .await
                .unwrap();
            (other_finished, query.await.unwrap())
        });
        assert!(
            other_finished < query_finished,
            "query execution stalled the runtime"
        );
    }

    // Blocking-lock failure modes:
    // 1. A task waiting for a busy connection holds its runtime worker, so
    //    other tasks (IDLE, timers, IPC) stall until the holder finishes.
    // 2. Waiting from a current-thread runtime or a plain thread panics.
    #[test]
    fn waiting_for_a_busy_connection_does_not_stall_other_tasks() {
        let db = Database::memory();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_time()
            .build()
            .unwrap();
        let holder = db.clone();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let release = std::thread::spawn(move || {
            let _guard = holder.conn().unwrap();
            held_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(600));
            std::time::Instant::now()
        });
        held_rx.recv().unwrap();
        let waiter = db.clone();
        let other_done = runtime.block_on(async move {
            let blocked = tokio::spawn(async move {
                drop(waiter.conn().unwrap());
            });
            tokio::task::yield_now().await;
            let other = tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                std::time::Instant::now()
            });
            let finished = other.await.unwrap();
            blocked.await.unwrap();
            finished
        });
        let released = release.join().unwrap();
        assert!(
            other_done < released,
            "a blocked lock wait stalled the runtime"
        );

        // Plain threads and current-thread runtimes still just wait.
        drop(db.conn().unwrap());
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(async { drop(db.read_conn().unwrap()) });
    }

    // New-mail alert failure modes:
    // - an older row with a future Date header hides a later arrival
    // - an arrival with an earlier Date than the newest row is skipped
    // - a read arrival, or one filed out of the Inbox, still alerts
    // - mail cached before the pass alerts again
    fn arrival_alert(existing: CachedMessage, arrival: CachedMessage) -> Option<u32> {
        let db = Database::memory();
        let account = account();
        let id = account.summary.id.clone();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(&id, inbox, &existing).unwrap();
        let before = db.inbox_high_water(&id).unwrap();
        db.upsert_message(&id, inbox, &arrival).unwrap();
        db.newest_unread_inbox_after(&id, before)
            .unwrap()
            .map(|item| item.uid)
    }

    #[test]
    fn new_mail_alert_follows_arrival_not_date_header() {
        let read = |uid, date| CachedMessage {
            is_read: true,
            ..message(uid, date)
        };
        assert_eq!(
            arrival_alert(
                read(1, "2026-10-13T09:00:00Z"),
                message(2, "2026-10-13T10:00:00Z")
            ),
            Some(2)
        );
        assert_eq!(
            arrival_alert(
                read(1, "2099-01-01T00:00:00Z"),
                message(2, "2026-10-13T10:00:00Z")
            ),
            Some(2)
        );
        assert_eq!(
            arrival_alert(
                read(1, "2026-10-13T10:00:00Z"),
                message(2, "2026-10-13T09:50:00Z")
            ),
            Some(2)
        );
        assert_eq!(
            arrival_alert(
                message(1, "2026-10-13T09:00:00Z"),
                read(2, "2026-10-13T10:00:00Z")
            ),
            None
        );
    }

    #[test]
    fn new_mail_alert_skips_mail_leaving_the_inbox() {
        let db = Database::memory();
        let account = account();
        let id = account.summary.id.clone();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &id, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, &id, "Archive", &MailboxRole::Archive);
        db.upsert_message(&id, inbox, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap();
        let before = db.inbox_high_water(&id).unwrap();
        db.upsert_message(&id, inbox, &message(2, "2026-08-19T12:00:00Z"))
            .unwrap();
        db.upsert_message(&id, inbox, &message(3, "2026-08-20T12:00:00Z"))
            .unwrap();
        let newest = db.newest_unread_inbox_after(&id, before).unwrap().unwrap();
        assert_eq!(newest.uid, 3);
        db.mark_pending_move(newest.id, archive).unwrap();
        let next = db.newest_unread_inbox_after(&id, before).unwrap().unwrap();
        assert_eq!(next.uid, 2);
        let after = db.inbox_high_water(&id).unwrap();
        assert!(db.newest_unread_inbox_after(&id, after).unwrap().is_none());
    }

    #[test]
    fn trash_expunge_plan_is_limited_to_one_trash_folder() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let trash = mailbox(&db, &account.summary.id, "Trash", &MailboxRole::Trash);
        let other_trash = mailbox(
            &db,
            &account.summary.id,
            "Deleted Messages",
            &MailboxRole::Trash,
        );
        db.upsert_message(
            &account.summary.id,
            trash,
            &message(9, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        db.upsert_message(
            &account.summary.id,
            trash,
            &message(4, "2026-08-18T11:00:00Z"),
        )
        .unwrap();
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T10:00:00Z"),
        )
        .unwrap();
        db.upsert_message(
            &account.summary.id,
            other_trash,
            &message(2, "2026-08-18T09:00:00Z"),
        )
        .unwrap();
        let id_for = |mailbox_id: i64, uid: u32| -> i64 {
            db.conn()
                .unwrap()
                .query_row(
                    "SELECT id FROM messages WHERE mailbox_id=?1 AND uid=?2",
                    rusqlite::params![mailbox_id, uid],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let first = id_for(trash, 9);
        let second = id_for(trash, 4);
        let inbox_id = id_for(inbox, 1);
        let other_id = id_for(other_trash, 2);
        let plan = db
            .trash_expunge_plan(&account.summary.id, &[second, first, second])
            .unwrap();
        assert_eq!(plan.mailbox_name, "Trash");
        assert_eq!(plan.uid_validity, 1);
        assert_eq!(plan.uids, vec![4, 9]);
        assert!(db
            .trash_expunge_plan(&account.summary.id, &[])
            .unwrap_err()
            .contains("Choose a message"));
        let too_many: Vec<i64> = (1..=201).collect();
        assert!(db
            .trash_expunge_plan(&account.summary.id, &too_many)
            .unwrap_err()
            .contains("200"));
        assert!(db
            .trash_expunge_plan(&account.summary.id, &[99])
            .unwrap_err()
            .contains("not found"));
        assert!(db
            .trash_expunge_plan("someone-else", &[first])
            .unwrap_err()
            .contains("does not belong"));
        assert!(db
            .trash_expunge_plan(&account.summary.id, &[inbox_id])
            .unwrap_err()
            .contains("Move the message"));
        assert!(db
            .trash_expunge_plan(&account.summary.id, &[first, other_id])
            .unwrap_err()
            .contains("one folder"));
        db.mark_pending_move(first, inbox).unwrap();
        assert!(db
            .trash_expunge_plan(&account.summary.id, &[first])
            .unwrap_err()
            .contains("still moving"));
        let unnamed = db
            .upsert_mailbox(
                &account.summary.id,
                "Trash Copy",
                &MailboxRole::Trash,
                None,
                Some(2),
                Some(0),
                0,
            )
            .unwrap();
        db.upsert_message(
            &account.summary.id,
            unnamed,
            &message(3, "2026-08-18T08:00:00Z"),
        )
        .unwrap();
        let unnamed_id = id_for(unnamed, 3);
        assert!(db
            .trash_expunge_plan(&account.summary.id, &[unnamed_id])
            .unwrap_err()
            .contains("identity is unavailable"));
        db.upsert_message(
            &account.summary.id,
            trash,
            &message(0, "2026-08-18T07:00:00Z"),
        )
        .unwrap();
        let zero = id_for(trash, 0);
        assert!(db
            .trash_expunge_plan(&account.summary.id, &[zero])
            .unwrap_err()
            .contains("refresh mail"));
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
    fn message_list_filter_pages_only_matching_rows() {
        use crate::models::{Attachment, MessageListFilter, MessageListSort};
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut newest = message(3, "2026-08-18T12:00:00Z");
        newest.is_starred = true;
        let middle = message(2, "2026-08-18T11:00:00Z");
        let mut oldest = message(1, "2026-08-18T10:00:00Z");
        oldest.is_read = true;
        oldest.attachments.push(Attachment {
            id: "notes".into(),
            filename: "notes.txt".into(),
            content_type: "text/plain".into(),
            size: 4,
            content_id: None,
            inline: false,
        });
        oldest.attachments.push(Attachment {
            id: "photo".into(),
            filename: "photo.png".into(),
            content_type: "image/png".into(),
            size: 8,
            content_id: Some("photo@example.com".into()),
            inline: true,
        });
        db.upsert_message(&account.summary.id, mailbox, &newest)
            .unwrap();
        db.upsert_message(&account.summary.id, mailbox, &middle)
            .unwrap();
        db.upsert_message(&account.summary.id, mailbox, &oldest)
            .unwrap();

        let listed = db.list_messages(mailbox, None, 10).unwrap();
        assert_eq!(listed.items.len(), 3);
        assert_eq!(
            listed
                .items
                .iter()
                .find(|item| item.uid == 1)
                .unwrap()
                .attachment_count,
            1
        );
        assert_eq!(
            listed
                .items
                .iter()
                .find(|item| item.uid == 3)
                .unwrap()
                .attachment_count,
            0
        );

        let first = db
            .list_messages_filtered(
                mailbox,
                None,
                1,
                MessageListFilter::Unread,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].uid, 3);
        let second = db
            .list_messages_filtered(
                mailbox,
                first.next_cursor.as_ref(),
                1,
                MessageListFilter::Unread,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].uid, 2);
        assert!(!second.has_more);

        let starred = db
            .list_messages_filtered(
                mailbox,
                None,
                10,
                MessageListFilter::Starred,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(starred.items.len(), 1);
        assert!(starred.items[0].is_starred);

        let files = db
            .list_messages_filtered(
                mailbox,
                None,
                10,
                MessageListFilter::Attachments,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(files.items.len(), 1);
        assert!(files.items[0].has_attachments);
        assert!(files.items[0].is_read);

        let none = db
            .list_messages_filtered(
                mailbox,
                None,
                10,
                MessageListFilter::Pinned,
                MessageListSort::Date,
            )
            .unwrap();
        assert!(none.items.is_empty());
        let newest_row = db.message_summary_by_uid(mailbox, 3).unwrap().unwrap();
        let middle_row = db.message_summary_by_uid(mailbox, 2).unwrap().unwrap();
        assert_eq!(
            db.set_pinned(&account.summary.id, &[newest_row.id, middle_row.id], true,)
                .unwrap(),
            2
        );
        let first_pinned = db
            .list_messages_filtered(
                mailbox,
                None,
                1,
                MessageListFilter::Pinned,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(first_pinned.items.len(), 1);
        assert_eq!(first_pinned.items[0].uid, 3);
        assert!(first_pinned.items[0].pinned);
        let next_pinned = db
            .list_messages_filtered(
                mailbox,
                first_pinned.next_cursor.as_ref(),
                1,
                MessageListFilter::Pinned,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(next_pinned.items.len(), 1);
        assert_eq!(next_pinned.items[0].uid, 2);
        assert!(!next_pinned.has_more);

        let mut copied = message(4, "2026-08-18T09:00:00Z");
        copied.to = vec!["lee@example.com".into()];
        copied.cc = vec!["sam@example.com".into()];
        copied.recipients = "lee@example.com, sam@example.com".into();
        db.upsert_message(&account.summary.id, mailbox, &copied)
            .unwrap();
        let addressed = db
            .list_messages_filtered(
                mailbox,
                None,
                10,
                MessageListFilter::ToMe,
                MessageListSort::Date,
            )
            .unwrap();
        assert!(addressed.items.iter().all(|item| item.to_me));
        assert!(addressed.items.iter().any(|item| item.uid == 3));
        assert!(addressed.items.iter().all(|item| item.uid != 4));

        let mut invite = message(5, "2026-08-18T08:00:00Z");
        invite.has_calendar = true;
        db.upsert_message(&account.summary.id, mailbox, &invite)
            .unwrap();
        let invitations = db
            .list_messages_filtered(
                mailbox,
                None,
                10,
                MessageListFilter::Invitations,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(invitations.items.len(), 1);
        assert_eq!(invitations.items[0].uid, 5);
        assert!(invitations.items[0].has_calendar);
    }

    #[test]
    fn message_list_sort_pages_from_subject_and_size() {
        use crate::models::{MessageListFilter, MessageListSort};
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut zoe = message(1, "2026-08-18T12:00:00Z");
        zoe.sender_name = "Zoe".into();
        zoe.sender_address = "zoe@example.com".into();
        zoe.subject = "Zoo".into();
        zoe.size = 100;
        let mut ada_newer = message(4, "2026-08-18T09:00:00Z");
        ada_newer.sender_name = "Ada".into();
        ada_newer.subject = "Picnic".into();
        ada_newer.size = 9;
        let mut ada_older = message(2, "2026-08-18T10:00:00Z");
        ada_older.sender_name = "ada".into();
        ada_older.subject = "Picnic".into();
        ada_older.size = 9;
        let mut address_only = message(3, "2026-08-18T11:00:00Z");
        address_only.sender_name = String::new();
        address_only.sender_address = "aaron@example.com".into();
        address_only.subject = "Middle".into();
        address_only.size = 1;
        for item in [&zoe, &ada_newer, &ada_older, &address_only] {
            db.upsert_message(&account.summary.id, mailbox, item)
                .unwrap();
        }

        let mut page = db
            .list_messages_filtered(
                mailbox,
                None,
                1,
                MessageListFilter::All,
                MessageListSort::Sender,
            )
            .unwrap();
        assert_eq!(page.items[0].uid, 3);
        assert_eq!(page.next_cursor.as_ref().unwrap().key, "aaron@example.com");
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                1,
                MessageListFilter::All,
                MessageListSort::Sender,
            )
            .unwrap();
        assert_eq!(page.items[0].uid, 4);
        assert_eq!(page.next_cursor.as_ref().unwrap().key, "Ada");
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                1,
                MessageListFilter::All,
                MessageListSort::Sender,
            )
            .unwrap();
        assert_eq!(page.items[0].uid, 2);
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                1,
                MessageListFilter::All,
                MessageListSort::Sender,
            )
            .unwrap();
        assert_eq!(page.items[0].uid, 1);
        assert!(!page.has_more);

        page = db
            .list_messages_filtered(
                mailbox,
                None,
                2,
                MessageListFilter::All,
                MessageListSort::Subject,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![3, 4]
        );
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                2,
                MessageListFilter::All,
                MessageListSort::Subject,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert!(!page.has_more);

        page = db
            .list_messages_filtered(
                mailbox,
                None,
                1,
                MessageListFilter::All,
                MessageListSort::Size,
            )
            .unwrap();
        assert_eq!(page.items[0].uid, 1);
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                1,
                MessageListFilter::All,
                MessageListSort::Size,
            )
            .unwrap();
        assert_eq!(page.items[0].uid, 4);
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                2,
                MessageListFilter::All,
                MessageListSort::Size,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(!page.has_more);

        let newest = db
            .list_messages_filtered(
                mailbox,
                None,
                1,
                MessageListFilter::All,
                MessageListSort::Date,
            )
            .unwrap();
        assert_eq!(newest.items[0].uid, 1);

        page = db
            .list_messages_filtered(
                mailbox,
                None,
                1,
                MessageListFilter::All,
                MessageListSort::DateOldest,
            )
            .unwrap();
        assert_eq!(page.items[0].uid, 4);
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                1,
                MessageListFilter::All,
                MessageListSort::DateOldest,
            )
            .unwrap();
        assert_eq!(page.items[0].uid, 2);
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                2,
                MessageListFilter::All,
                MessageListSort::DateOldest,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![3, 1]
        );
        assert!(!page.has_more);

        page = db
            .list_messages_filtered(
                mailbox,
                None,
                2,
                MessageListFilter::All,
                MessageListSort::SenderDesc,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![1, 2]
        );
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                2,
                MessageListFilter::All,
                MessageListSort::SenderDesc,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![4, 3]
        );
        assert!(!page.has_more);

        page = db
            .list_messages_filtered(
                mailbox,
                None,
                2,
                MessageListFilter::All,
                MessageListSort::SubjectDesc,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![1, 2]
        );
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                2,
                MessageListFilter::All,
                MessageListSort::SubjectDesc,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![4, 3]
        );
        assert!(!page.has_more);

        page = db
            .list_messages_filtered(
                mailbox,
                None,
                2,
                MessageListFilter::All,
                MessageListSort::SizeAsc,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![3, 2]
        );
        page = db
            .list_messages_filtered(
                mailbox,
                page.next_cursor.as_ref(),
                2,
                MessageListFilter::All,
                MessageListSort::SizeAsc,
            )
            .unwrap();
        assert_eq!(
            page.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![4, 1]
        );
        assert!(!page.has_more);
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
        db.evict_account_to_policy(&account.summary.id, &CachePolicy::default())
            .unwrap();
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
    fn received_sender_suggestions_follow_sent_history_and_stay_account_scoped() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let other = account_with_id("account-2", "other@example.com");
        db.insert_account(&other).unwrap();
        let other_inbox = mailbox(&db, &other.summary.id, "INBOX", &MailboxRole::Inbox);

        for (uid, address, name, received_at) in [
            (1, "jane@example.test", "Jane", "2026-08-18T12:00:00Z"),
            (
                2,
                "sent@example.test",
                "From the sent history",
                "2026-08-18T13:00:00Z",
            ),
            (3, "dave@example.test", "Dave", "2026-08-18T14:00:00Z"),
        ] {
            let mut received = message(uid, received_at);
            received.sender_address = address.into();
            received.sender_name = name.into();
            received.message_id = Some(format!("<{uid}@example.test>"));
            db.upsert_message(&account.summary.id, inbox, &received)
                .unwrap();
        }
        let mut private = message(1, "2026-08-18T15:00:00Z");
        private.sender_address = "private@example.test".into();
        db.upsert_message(&other.summary.id, other_inbox, &private)
            .unwrap();
        db.record_recipients(
            &account.summary.id,
            &[
                ("sent@example.test".into(), "Sent history".into()),
                ("sent@example.test".into(), "Sent history".into()),
                ("jane@example.test".into(), "Jane before receipt".into()),
            ],
        )
        .unwrap();

        let suggestions = db
            .suggest_recipients(&account.summary.id, "example.test", 8)
            .unwrap();
        assert_eq!(
            suggestions
                .iter()
                .map(|suggestion| suggestion.address.as_str())
                .collect::<Vec<_>>(),
            [
                "sent@example.test",
                "jane@example.test",
                "dave@example.test"
            ]
        );
        assert_eq!(suggestions[0].use_count, 2);
        assert_eq!(suggestions[1].name, "Jane before receipt");
    }

    #[test]
    fn received_sender_suggestions_exclude_private_blocked_muted_and_filed_mail() {
        let db = Database::memory();
        let mut account = account();
        account.summary.aliases = vec!["alias@example.test".into()];
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let junk = mailbox(&db, &account.summary.id, "Junk", &MailboxRole::Junk);
        let trash = mailbox(&db, &account.summary.id, "Trash", &MailboxRole::Trash);

        for (field, contains) in [("from", "blocked@example.test"), ("domain", "blocked.test")] {
            db.create_filter_rule(&FilterRule {
                id: String::new(),
                account_id: account.summary.id.clone(),
                name: "Blocked sender".into(),
                field: field.into(),
                contains: contains.into(),
                action: "move_junk".into(),
                target_mailbox: None,
                enabled: true,
            })
            .unwrap();
        }

        let add_received = |uid: u32, address: &str, mailbox_id: i64| {
            let mut received = message(uid, "2026-08-18T12:00:00Z");
            received.sender_name = format!("Sender {uid}");
            received.sender_address = address.into();
            received.message_id = Some(format!("<{uid}@example.test>"));
            db.upsert_message(&account.summary.id, mailbox_id, &received)
                .unwrap();
        };
        add_received(1, "allowed@example.test", inbox);
        add_received(2, "invalid sender", inbox);
        add_received(3, "noreply@example.test", inbox);
        add_received(4, "no-reply@example.test", inbox);
        add_received(5, "sam@example.com", inbox);
        add_received(6, "alias@example.test", inbox);
        add_received(7, "blocked@example.test", inbox);
        add_received(8, "notice@sub.blocked.test", inbox);
        add_received(9, "muted@example.test", inbox);
        add_received(10, "junk@example.test", junk);
        add_received(11, "trash@example.test", trash);
        add_received(12, "pending-junk@example.test", inbox);
        add_received(13, "restored@example.test", junk);

        let conn = db.conn().unwrap();
        conn.execute(
            "INSERT INTO muted_ids(account_id,message_id,group_id) VALUES(?1,?2,'muted')",
            params![&account.summary.id, "<9@example.test>"],
        )
        .unwrap();
        conn.execute(
            "UPDATE messages SET pending_move_to=?1 WHERE account_id=?2 AND uid=12",
            params![junk, &account.summary.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE messages SET pending_move_to=?1 WHERE account_id=?2 AND uid=13",
            params![inbox, &account.summary.id],
        )
        .unwrap();
        drop(conn);

        let suggestions = db
            .suggest_recipients(&account.summary.id, "sender", 20)
            .unwrap();
        let addresses = suggestions
            .iter()
            .map(|suggestion| suggestion.address.as_str())
            .collect::<Vec<_>>();
        assert!(addresses.contains(&"allowed@example.test"));
        assert!(addresses.contains(&"restored@example.test"));
        for excluded in [
            "invalid sender",
            "noreply@example.test",
            "no-reply@example.test",
            "sam@example.com",
            "alias@example.test",
            "blocked@example.test",
            "notice@sub.blocked.test",
            "muted@example.test",
            "junk@example.test",
            "trash@example.test",
            "pending-junk@example.test",
        ] {
            assert!(!addresses.contains(&excluded), "leaked {excluded}");
        }
    }

    #[test]
    fn received_sender_suggestions_escape_wildcards_and_cap_results() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        for uid in 1..=24 {
            let mut received = message(uid, "2026-08-18T12:00:00Z");
            received.sender_name = format!("Person {uid}");
            received.sender_address = format!("person{uid}@example.test");
            received.message_id = Some(format!("<{uid}@example.test>"));
            db.upsert_message(&account.summary.id, inbox, &received)
                .unwrap();
        }

        assert!(db
            .suggest_recipients(&account.summary.id, "%", 8)
            .unwrap()
            .is_empty());
        assert!(db
            .suggest_recipients(&account.summary.id, "_", 8)
            .unwrap()
            .is_empty());
        assert_eq!(
            db.suggest_recipients(&account.summary.id, "person", 2)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            db.suggest_recipients(&account.summary.id, "person", 200)
                .unwrap()
                .len(),
            20
        );
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
    fn muted_conversation_files_later_inbox_replies_and_unmute_stops() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, &account.summary.id, "Archive", &MailboxRole::Archive);
        let sent = mailbox(&db, &account.summary.id, "Sent", &MailboxRole::Sent);
        let parent = message(1, "2026-08-18T12:00:00Z");
        db.upsert_envelope(&account.summary.id, inbox, &parent)
            .unwrap();
        let parent_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        assert!(!db.list_messages(inbox, None, 10).unwrap().items[0].conversation_muted);
        db.remember_muted_conversation(&account.summary.id, parent_id)
            .unwrap();
        assert!(db.list_messages(inbox, None, 10).unwrap().items[0].conversation_muted);
        assert_eq!(
            db.file_muted_inbox(&account.summary.id).unwrap(),
            vec![parent_id]
        );
        assert!(db.file_muted_inbox(&account.summary.id).unwrap().is_empty());
        assert!(db.list_messages(inbox, None, 10).unwrap().items.is_empty());
        let (is_read, pending): (i64, i64) = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT is_read, pending_move_to FROM messages WHERE id=?1",
                [parent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(is_read, 1);
        assert_eq!(pending, archive);

        let mut sent_reply = message(4, "2026-08-18T15:00:00Z");
        sent_reply.thread_parent = Some("<1@example.com>".into());
        db.upsert_envelope(&account.summary.id, sent, &sent_reply)
            .unwrap();

        let mut child = message(2, "2026-08-18T13:00:00Z");
        child.thread_parent = Some("<1@example.com>".into());
        db.upsert_envelope(&account.summary.id, inbox, &child)
            .unwrap();
        let child_row = db.list_messages(inbox, None, 10).unwrap().items;
        assert_eq!(child_row.len(), 1);
        assert!(child_row[0].conversation_muted);
        let child_id = child_row[0].id;
        assert_eq!(
            db.file_muted_inbox(&account.summary.id).unwrap(),
            vec![child_id]
        );

        let mut grandchild = message(3, "2026-08-18T14:00:00Z");
        grandchild.thread_parent = Some("<2@example.com>".into());
        db.upsert_envelope(&account.summary.id, inbox, &grandchild)
            .unwrap();
        let grand = db.list_messages(inbox, None, 10).unwrap().items;
        assert!(grand[0].conversation_muted);
        let grand_id = grand[0].id;
        assert_eq!(
            db.file_muted_inbox(&account.summary.id).unwrap(),
            vec![grand_id]
        );
        assert_eq!(db.list_messages(sent, None, 10).unwrap().items.len(), 1);

        db.forget_muted_conversation(&account.summary.id, grand_id)
            .unwrap();
        let mut later = message(5, "2026-08-18T16:00:00Z");
        later.thread_parent = Some("<3@example.com>".into());
        db.upsert_envelope(&account.summary.id, inbox, &later)
            .unwrap();
        let later_rows = db.list_messages(inbox, None, 10).unwrap().items;
        assert!(!later_rows[0].conversation_muted);
        assert!(db.file_muted_inbox(&account.summary.id).unwrap().is_empty());

        let other = account_with_id("account-2", "lee@example.com");
        db.insert_account(&other).unwrap();
        let other_inbox = mailbox(&db, &other.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_envelope(&other.summary.id, other_inbox, &parent)
            .unwrap();
        let other_id = db.list_messages(other_inbox, None, 10).unwrap().items[0].id;
        assert!(db
            .remember_muted_conversation(&account.summary.id, other_id)
            .is_err());
        assert!(db.file_muted_inbox(&other.summary.id).unwrap().is_empty());

        let mut nameless = message(9, "2026-08-18T17:00:00Z");
        nameless.message_id = None;
        db.upsert_envelope(&account.summary.id, inbox, &nameless)
            .unwrap();
        let nameless_id = db
            .list_messages(inbox, None, 10)
            .unwrap()
            .items
            .iter()
            .find(|item| item.uid == 9)
            .unwrap()
            .id;
        assert!(db
            .remember_muted_conversation(&account.summary.id, nameless_id)
            .is_err());

        let lone = account_with_id("account-3", "pat@example.com");
        db.insert_account(&lone).unwrap();
        let lone_inbox = mailbox(&db, &lone.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_envelope(&lone.summary.id, lone_inbox, &parent)
            .unwrap();
        let lone_id = db.list_messages(lone_inbox, None, 10).unwrap().items[0].id;
        db.remember_muted_conversation(&lone.summary.id, lone_id)
            .unwrap();
        assert!(db.file_muted_inbox(&lone.summary.id).unwrap().is_empty());
        assert_eq!(
            db.list_messages(lone_inbox, None, 10).unwrap().items.len(),
            1
        );
    }

    // Failure modes: detail select shifts columns so summary.thread_root
    // reads to_json; root is null for unthreaded mail; detail body fields
    // (to/cc) must still map after any select reorder.
    #[test]
    fn message_detail_reports_thread_root_not_recipients() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut child = message(2, "2026-08-18T13:00:00Z");
        child.thread_parent = Some("<1@example.com>".into());
        db.upsert_message(&account.summary.id, mailbox, &child)
            .unwrap();
        let id = db
            .list_messages(mailbox, None, 10)
            .unwrap()
            .items
            .first()
            .unwrap()
            .id;
        let detail = db.message_detail(id, &account.summary.id).unwrap();
        let listed = db.list_messages(mailbox, None, 10).unwrap().items;
        assert_eq!(detail.summary.thread_root, listed[0].thread_root);
        assert_eq!(
            detail.summary.thread_root.as_deref(),
            Some("<1@example.com>")
        );
        assert!(!detail.to.is_empty(), "{:?}", detail.to);
    }

    #[test]
    fn message_detail_opens_envelope_only_and_evicted_messages() {
        // Ways this can fail: empty raw_message errors, evicted rows keep a stale
        // List-Post, or a missing row reports a different error.
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut cached = message(1, "2026-08-18T12:00:00Z");
        cached.raw_message =
            b"List-Post: <mailto:list@example.com>\r\nSubject: Family picnic\r\n\r\nBody".to_vec();
        db.upsert_message(&account.summary.id, mailbox, &cached)
            .unwrap();
        db.upsert_envelope(
            &account.summary.id,
            mailbox,
            &envelope_only(2, "2026-08-18T13:00:00Z"),
        )
        .unwrap();
        let rows = db.list_messages(mailbox, None, 10).unwrap().items;
        let full = rows.iter().find(|row| row.uid == 1).unwrap().id;
        let envelope = rows.iter().find(|row| row.uid == 2).unwrap().id;

        let before = db.message_detail(full, &account.summary.id).unwrap();
        assert!(before.list_post.is_some());
        let blank = db.message_detail(envelope, &account.summary.id).unwrap();
        assert_eq!(blank.list_post, None);

        db.clear_downloaded_mail().unwrap();
        let evicted = db.message_detail(full, &account.summary.id).unwrap();
        assert_eq!(evicted.list_post, None);
        assert!(evicted.html_body.is_none());
        assert!(db.message_detail(9999, &account.summary.id).is_err());
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
        cached.bcc = vec!["hidden@example.com".into()];
        cached.internal_at = Some("2026-08-18T18:00:00Z".into());
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
        assert_eq!(detail.bcc, vec!["hidden@example.com"]);
        assert_eq!(detail.reply_to.as_deref(), Some("reply@example.com"));
        assert_eq!(detail.summary.arrived_at, "2026-08-18T18:00:00Z");
        assert_eq!(
            db.search(&SearchQuery {
                account_id: account.summary.id.clone(),
                mailbox_id: Some(mailbox),
                text: "hidden@example.com".into(),
                all_folders: false,
                limit: 10,
            })
            .unwrap()
            .len(),
            1
        );
        let blank = envelope_only(1, "2026-08-18T12:00:00Z");
        db.upsert_envelope(&account.summary.id, mailbox, &blank)
            .unwrap();
        let kept = db.message_detail(id, &account.summary.id).unwrap();
        assert_eq!(kept.bcc, vec!["hidden@example.com"]);
        assert_eq!(kept.summary.arrived_at, "2026-08-18T18:00:00Z");
        assert!(detail
            .html_body
            .as_deref()
            .unwrap_or_default()
            .contains("data-remote-src=\"https://images.example.com/pic.png\""));
        assert!(!detail
            .html_body
            .as_deref()
            .unwrap_or_default()
            .contains("<img src=\"https://"));
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
    fn migrates_v6_two_null_offline_ops_get_unique_keys() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            let account = account();
            db.insert_account(&account).unwrap();
            db.conn()
                .unwrap()
                .execute_batch(
                    "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key) VALUES('account-1','flags','{}',NULL);
                     INSERT INTO offline_ops(account_id,kind,payload,dedupe_key) VALUES('account-1','move','{}',NULL);
                     PRAGMA user_version=5;",
                )
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        let keys: Vec<String> = migrated
            .conn()
            .unwrap()
            .prepare("SELECT dedupe_key FROM offline_ops WHERE account_id='account-1' ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(keys.len(), 2);
        assert!(keys[0].starts_with("legacy:"));
        assert!(keys[1].starts_with("legacy:"));
        assert_ne!(keys[0], keys[1]);
        let version: u32 = migrated
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migrates_unversioned_pre_thread_schema_without_data_loss() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(SCHEMA_V1).unwrap();
            connection
                .execute_batch(
                    "DROP INDEX IF EXISTS messages_thread;
                     ALTER TABLE messages DROP COLUMN thread_root;
                     ALTER TABLE messages DROP COLUMN thread_parent;
                     INSERT INTO accounts(id,provider,email,display_name,imap_host,imap_port,imap_tls,imap_username,smtp_host,smtp_port,smtp_tls,smtp_username)
                       VALUES('account-1','manual','sam@example.com','Sam','imap.example.com',993,'tls','sam@example.com','smtp.example.com',587,'startTls','sam@example.com');
                     INSERT INTO mailboxes(id,account_id,name,display_name,role)
                       VALUES(1,'account-1','INBOX','Inbox','inbox');
                     INSERT INTO messages(account_id,mailbox_id,uid,subject,received_at)
                       VALUES('account-1',1,1,'Existing message','2026-08-18T12:00:00Z');
                     PRAGMA user_version=0;",
                )
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        let connection = migrated.conn().unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert!(column_exists(&connection, "messages", "thread_root").unwrap());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='messages_thread'",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT subject FROM messages WHERE account_id='account-1' AND uid=1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Existing message"
        );
    }

    #[test]
    fn mailbox_for_role_prefers_special_use_over_name() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        db.upsert_mailbox_with_source(
            &account.summary.id,
            "Sent",
            &MailboxRole::Sent,
            "name",
            Some(1),
            Some(2),
            Some(0),
            0,
        )
        .unwrap();
        let special = db
            .upsert_mailbox_with_source(
                &account.summary.id,
                "Sent Messages",
                &MailboxRole::Sent,
                "specialUse",
                Some(1),
                Some(2),
                Some(0),
                0,
            )
            .unwrap();
        let chosen = db
            .mailbox_for_role(&account.summary.id, "sent")
            .unwrap()
            .unwrap();
        assert_eq!(chosen.0, special);
        assert_eq!(chosen.1, "Sent Messages");
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
    fn migrates_v13_with_duplicate_emails_without_locking_out_accounts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .unwrap()
                .execute_batch("DROP INDEX accounts_email_unique;")
                .unwrap();
            let first = account();
            db.insert_account(&first).unwrap();
            let mut duplicate = first.clone();
            duplicate.summary.id = "account-duplicate".into();
            duplicate.summary.display_name = "Duplicate".into();
            db.insert_account(&duplicate).unwrap();
            db.conn()
                .unwrap()
                .pragma_update(None, "user_version", 13)
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        assert_eq!(migrated.list_accounts().unwrap().len(), 2);
        let version: u32 = migrated
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migrates_v14_with_duplicate_emails_defers_index_without_lockout() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .unwrap()
                .execute_batch("DROP INDEX accounts_email_unique;")
                .unwrap();
            let first = account();
            db.insert_account(&first).unwrap();
            let mut duplicate = first.clone();
            duplicate.summary.id = "account-duplicate".into();
            duplicate.summary.display_name = "Duplicate".into();
            db.insert_account(&duplicate).unwrap();
            db.conn()
                .unwrap()
                .pragma_update(None, "user_version", 14)
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        assert_eq!(migrated.list_accounts().unwrap().len(), 2);
        assert!(!accounts_email_unique_index_exists(&migrated));
        assert!(migrated.email_taken("sam@example.com").unwrap());
        let version: u32 = migrated
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migrates_v14_restores_unique_index_when_duplicates_are_gone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .unwrap()
                .execute_batch("DROP INDEX accounts_email_unique; PRAGMA user_version=14;")
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        assert!(accounts_email_unique_index_exists(&migrated));
        let account = account();
        migrated.insert_account(&account).unwrap();
        assert!(migrated.insert_account(&account).is_err());
        let version: u32 = migrated
            .conn()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn remove_account_restores_unique_index_once_duplicates_clear() {
        let db = Database::memory();
        db.conn()
            .unwrap()
            .execute_batch("DROP INDEX accounts_email_unique;")
            .unwrap();
        let first = account();
        db.insert_account(&first).unwrap();
        for id in ["account-duplicate", "account-third"] {
            let mut duplicate = first.clone();
            duplicate.summary.id = id.into();
            db.insert_account(&duplicate).unwrap();
        }

        // Removing one of three still leaves duplicates: the index cannot be
        // built yet and the removal must still commit.
        db.remove_account("account-third").unwrap();
        assert_eq!(db.list_accounts().unwrap().len(), 2);
        assert!(!accounts_email_unique_index_exists(&db));

        db.remove_account("account-duplicate").unwrap();
        assert!(accounts_email_unique_index_exists(&db));
        let mut fourth = first.clone();
        fourth.summary.id = "account-fourth".into();
        assert!(db.insert_account(&fourth).is_err());
    }

    #[test]
    fn reorder_accounts_keeps_every_account_in_the_chosen_order() {
        let db = Database::memory();
        db.insert_account(&account_with_id("account-1", "sam@example.com"))
            .unwrap();
        db.insert_account(&account_with_id("account-2", "work@example.com"))
            .unwrap();
        db.reorder_accounts(&["account-2".into(), "account-1".into()])
            .unwrap();
        let ids: Vec<String> = db
            .list_accounts()
            .unwrap()
            .into_iter()
            .map(|account| account.id)
            .collect();
        assert_eq!(ids, vec!["account-2", "account-1"]);
        assert!(db.reorder_accounts(&["account-2".into()]).is_err());
        assert!(db
            .reorder_accounts(&["account-2".into(), "account-2".into()])
            .is_err());
        let still: Vec<String> = db
            .list_accounts()
            .unwrap()
            .into_iter()
            .map(|account| account.id)
            .collect();
        assert_eq!(still, vec!["account-2", "account-1"]);
    }

    #[test]
    fn account_color_is_saved_and_listed() {
        let db = Database::memory();
        db.insert_account(&account()).unwrap();
        db.update_account_color("account-1", Some("purple"))
            .unwrap();
        assert_eq!(
            db.list_accounts().unwrap()[0].color.as_deref(),
            Some("purple")
        );
        db.update_account_color("account-1", None).unwrap();
        assert_eq!(db.list_accounts().unwrap()[0].color, None);
        assert!(db.update_account_color("missing", Some("purple")).is_err());
    }

    #[test]
    fn outbox_reads_resanitize_html_bodies() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mut outgoing = draft(&account.summary.id);
        outgoing.html_body =
            "<p>Hello</p><script>alert(1)</script><img src=x onerror=alert(1)>".into();
        let id = db
            .queue_outbox(
                &outgoing,
                "queued",
                None,
                "<stable@example.com>",
                b"Subject: test\r\n\r\nbody",
                None,
            )
            .unwrap();

        let (read, state) = db.outbox(&id, &account.summary.id).unwrap();
        assert_eq!(state, "queued");
        assert!(read.html_body.contains("Hello"));
        assert!(!read.html_body.contains("<script"));
        assert!(!read.html_body.contains("onerror"));
        assert_eq!(read.to, outgoing.to);
        assert_eq!(read.subject, outgoing.subject);
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
    fn rich_account_signatures_are_sanitized_and_round_trip() {
        // Failure modes:
        // 1. Scripts or event handlers are stored in a reusable signature.
        // 2. Remote images or unsafe URLs survive into later sends.
        // 3. Saving HTML changes the legacy text fallback or another account.
        let db = Database::memory();
        let first = account();
        db.insert_account(&first).unwrap();
        let mut second = account();
        second.summary.id = "account-2".into();
        second.summary.email = "other@example.com".into();
        db.insert_account(&second).unwrap();

        let signature_html = "<p onclick=\"run()\"><strong>Best,</strong></p><p>Sam</p><script>secret()</script><img src=\"https://tracker.example.test/p.gif\" onerror=\"run()\"><a href=\"javascript:run()\">link</a>";
        db.update_account_signatures(&first.summary.id, "Best,\nSam", signature_html)
            .unwrap();

        let stored = db.account(&first.summary.id).unwrap().summary;
        assert_eq!(stored.signature, "Best,\nSam");
        assert!(stored.signature_html.contains("<strong>Best,</strong>"));
        for unsafe_value in [
            "<script",
            "secret()",
            "onclick",
            "onerror",
            "<img",
            "tracker.example.test",
            "javascript:",
        ] {
            assert!(
                !stored.signature_html.contains(unsafe_value),
                "{unsafe_value}"
            );
        }
        let untouched = db.account(&second.summary.id).unwrap().summary;
        assert_eq!(untouched.signature_html, "");
        assert!(db
            .update_account_signatures(&first.summary.id, "Best", &"x".repeat(20_001))
            .is_err());
    }

    // Failure modes for the default body format setter:
    // 1. An unknown account silently succeeds.
    // 2. The value is not stored, or is stored for the wrong account.
    // 3. An unknown format string passes IPC and reaches the database.
    // 4. Setting Plain changes the signature or other account fields.
    #[test]
    fn account_default_body_format_round_trips_per_account() {
        use crate::models::BodyFormat;
        let db = Database::memory();
        let first = account();
        db.insert_account(&first).unwrap();
        let mut second = account();
        second.summary.id = "account-2".into();
        second.summary.email = "other@example.com".into();
        db.insert_account(&second).unwrap();
        assert!(db
            .set_account_default_body_format("missing", BodyFormat::Plain)
            .is_err());
        let summary = db
            .set_account_default_body_format(&first.summary.id, BodyFormat::Plain)
            .unwrap();
        assert_eq!(summary.default_body_format, BodyFormat::Plain);
        assert_eq!(summary.signature, first.summary.signature);
        let listed = db.list_accounts().unwrap();
        let format_of = |id: &str| {
            listed
                .iter()
                .find(|item| item.id == id)
                .unwrap()
                .default_body_format
        };
        assert_eq!(format_of(&first.summary.id), BodyFormat::Plain);
        assert_eq!(format_of(&second.summary.id), BodyFormat::Html);
        db.set_account_default_body_format(&first.summary.id, BodyFormat::Html)
            .unwrap();
        assert_eq!(
            db.account(&first.summary.id)
                .unwrap()
                .summary
                .default_body_format,
            BodyFormat::Html
        );
        assert!(serde_json::from_str::<BodyFormat>("\"rich\"").is_err());
        assert!(serde_json::from_str::<BodyFormat>("\"plain\"").is_ok());
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

        // An empty needs_attention row (legacy migration) may repair its MIME.
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
        db.prepare_queued_outbox(
            &uncertain,
            &account.summary.id,
            "<must-not-send@example.com>",
            b"Subject: repaired\r\n\r\nbody",
        )
        .unwrap();
        // A row that already holds prepared MIME is never rewritten.
        assert!(db
            .prepare_queued_outbox(
                &uncertain,
                &account.summary.id,
                "<rewritten@example.com>",
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
    fn outbox_claim_requires_the_checked_state() {
        // W12: a caller that checked "scheduled" must not send a row that
        // another delivery already left needing attention.
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let id = db
            .queue_outbox(
                &draft(&account.summary.id),
                "scheduled",
                None,
                "",
                b"",
                Some("2000-01-01T00:00:00Z"),
            )
            .unwrap();
        db.set_outbox_state(&id, &account.summary.id, "needs_attention", None)
            .unwrap();
        assert!(!db
            .claim_outbox_delivery(&id, &account.summary.id, "scheduled")
            .unwrap());
        assert!(!db
            .claim_outbox_delivery(&id, &account.summary.id, "queued")
            .unwrap());
        assert!(!db
            .claim_outbox_delivery(&id, "other-account", "needs_attention")
            .unwrap());
        assert!(db
            .claim_outbox_delivery(&id, &account.summary.id, "needs_attention")
            .unwrap());
        assert!(!db
            .claim_outbox_delivery(&id, &account.summary.id, "needs_attention")
            .unwrap());
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

    #[test]
    fn snooze_messages_hides_the_set_or_none_of_it() {
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
        let ids = db
            .list_messages(mailbox, None, 10)
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert!(db
            .snooze_messages(&account.summary.id, &[], "2999-01-01T00:00:00+00:00")
            .is_err());
        assert!(db
            .snooze_messages(
                &account.summary.id,
                &[ids[0], 999],
                "2999-01-01T00:00:00+00:00",
            )
            .is_err());
        assert_eq!(db.list_messages(mailbox, None, 10).unwrap().items.len(), 2);
        db.snooze_messages(
            &account.summary.id,
            &[ids[0], ids[1], ids[0]],
            "2999-01-01T00:00:00+00:00",
        )
        .unwrap();
        assert!(db
            .list_messages(mailbox, None, 10)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            db.list_snoozed(&account.summary.id, "2026-01-01T00:00:00+00:00")
                .unwrap()
                .len(),
            2
        );
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
    fn from_rule_with_full_address_matches_only_that_sender() {
        // Ways this can fail: a suffix domain (x.io.com) or subdomain (some.me@x.io)
        // matches, a display name holding the address matches, or LIKE wildcards in
        // the needle act as patterns. A non-address needle must stay a substring.
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let cases = [
            (1, "me@x.io", "Me", "exact"),
            (2, "ME@X.IO", "Me", "upper"),
            (3, "me@x.io.com", "Me", "suffix"),
            (4, "some.me@x.io", "Me", "subdomain"),
            (5, "lee@example.test", "me@x.io", "display"),
            (6, "a_b@example.test", "A", "underscore"),
            (7, "axb@example.test", "A", "not-underscore"),
        ];
        for (uid, address, name, subject) in cases {
            let mut value = message(uid, "2026-08-18T12:00:00Z");
            value.sender_address = address.into();
            value.sender_name = name.into();
            value.subject = subject.into();
            db.upsert_message(&account.summary.id, inbox, &value)
                .unwrap();
        }
        let mut rule = filter_rule(&account.summary.id);
        rule.contains = "me@x.io".into();
        let preview = db.preview_rule_matches(&account.summary.id, &rule).unwrap();
        let mut subjects = preview.subjects.clone();
        subjects.sort();
        assert_eq!(subjects, vec!["exact", "upper"]);

        rule.contains = "a_b@".into();
        let literal = db.preview_rule_matches(&account.summary.id, &rule).unwrap();
        assert_eq!(literal.subjects, vec!["underscore"]);

        rule.contains = "billing".into();
        assert_eq!(
            db.preview_rule_matches(&account.summary.id, &rule)
                .unwrap()
                .matched,
            0
        );
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
        bill.recipients = "billing@power.example.com, sam@example.com".into();
        db.upsert_message(&account.summary.id, inbox, &bill)
            .unwrap();
        let family = message(2, "2026-08-18T13:00:00Z");
        db.upsert_message(&account.summary.id, inbox, &family)
            .unwrap();
        // Read mail never matches.
        let read_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.set_flags(read_id, Some(true), None).unwrap();

        let rule = filter_rule(&account.summary.id);
        let matches = db
            .find_rule_matches(&account.summary.id, &rule, None)
            .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].1, 1);

        let mut subject_rule = filter_rule(&account.summary.id);
        subject_rule.field = "subject".into();
        subject_rule.contains = "PICNIC".into();
        let subject_matches = db
            .find_rule_matches(&account.summary.id, &subject_rule, None)
            .unwrap();
        assert_eq!(subject_matches.len(), 1);

        let mut recipient_rule = filter_rule(&account.summary.id);
        recipient_rule.field = "to".into();
        recipient_rule.contains = "Billing@Power".into();
        let recipient_matches = db
            .find_rule_matches(&account.summary.id, &recipient_rule, None)
            .unwrap();
        assert_eq!(recipient_matches.len(), 1);
        assert_eq!(recipient_matches[0].1, 1);
        let preview = db
            .preview_rule_matches(&account.summary.id, &recipient_rule)
            .unwrap();
        assert_eq!(preview.matched, 1);
        assert_eq!(preview.subjects, vec!["Family picnic"]);

        let mut unknown = filter_rule(&account.summary.id);
        unknown.field = "body".into();
        assert!(db
            .find_rule_matches(&account.summary.id, &unknown, None)
            .unwrap()
            .is_empty());

        // LIKE metacharacters match literally.
        let mut wild = filter_rule(&account.summary.id);
        wild.contains = "%".into();
        assert!(db
            .find_rule_matches(&account.summary.id, &wild, None)
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
    fn domain_rules_match_that_host_and_its_subdomains() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut host = message(1, "2026-08-18T12:00:00Z");
        host.sender_address = "jane@example.com".into();
        host.subject = "At the host".into();
        db.upsert_message(&account.summary.id, inbox, &host)
            .unwrap();
        let mut child = message(2, "2026-08-18T12:01:00Z");
        child.sender_address = "jane@mail.example.com".into();
        child.subject = "At a subdomain".into();
        db.upsert_message(&account.summary.id, inbox, &child)
            .unwrap();
        let mut lookalike = message(3, "2026-08-18T12:02:00Z");
        lookalike.sender_address = "jane@example.com.evil.test".into();
        lookalike.subject = "Lookalike host".into();
        db.upsert_message(&account.summary.id, inbox, &lookalike)
            .unwrap();
        let mut rule = filter_rule(&account.summary.id);
        rule.field = "domain".into();
        rule.contains = "Example.COM".into();
        let matches = db
            .find_rule_matches(&account.summary.id, &rule, None)
            .unwrap();
        let uids: Vec<u32> = matches.iter().map(|item| item.1).collect();
        assert!(uids.contains(&1));
        assert!(uids.contains(&2));
        assert!(!uids.contains(&3));
        assert_eq!(uids.len(), 2);
    }

    #[test]
    fn filter_rule_order_and_preview_do_not_file_mail() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut bill = message(1, "2026-08-18T12:00:00Z");
        bill.sender_address = "bills@power.example.com".into();
        bill.subject = "August power\nbill".into();
        db.upsert_message(&account.summary.id, inbox, &bill)
            .unwrap();
        let id = db.list_messages(inbox, None, 10).unwrap().items[0].id;

        let mut first = filter_rule(&account.summary.id);
        first.name = "First".into();
        let mut second = filter_rule(&account.summary.id);
        second.name = "Second".into();
        second.contains = "no-such-sender".into();
        let first = db.create_filter_rule(&first).unwrap();
        let second = db.create_filter_rule(&second).unwrap();
        let ordered = db
            .reorder_filter_rules(&account.summary.id, &[second.id.clone(), first.id.clone()])
            .unwrap();
        assert_eq!(ordered[0].id, second.id);
        assert_eq!(ordered[1].id, first.id);
        assert!(db
            .reorder_filter_rules(&account.summary.id, std::slice::from_ref(&first.id),)
            .is_err());

        let preview = db
            .preview_rule_matches(&account.summary.id, &first)
            .unwrap();
        assert_eq!(preview.matched, 1);
        assert!(!preview.capped);
        assert_eq!(preview.subjects, vec!["August power bill"]);
        assert!(db
            .unread_message_ids(inbox)
            .unwrap()
            .iter()
            .any(|(unread_id, _)| unread_id == &id));
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
    fn message_references_keep_references_header_order() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox_id = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut msg = message(1, "2026-08-18T12:00:00Z");
        msg.raw_message = b"In-Reply-To: <parent@example.test>\r\nReferences: <root@example.test> <parent@example.test>\r\n\r\nbody".to_vec();
        msg.thread_parent = Some("<parent@example.test>".into());
        db.upsert_message(&account.summary.id, mailbox_id, &msg)
            .unwrap();
        let id = db.list_messages(mailbox_id, None, 10).unwrap().items[0].id;
        assert_eq!(
            db.message_references(id, &account.summary.id).unwrap(),
            vec![
                "<root@example.test>".to_string(),
                "<parent@example.test>".to_string()
            ]
        );
    }

    #[test]
    fn find_message_by_header_id_prefers_a_live_folder() {
        let db = Database::memory();
        let account = account();
        let other = account_with_id("account-2", "two@example.com");
        db.insert_account(&account).unwrap();
        db.insert_account(&other).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let trash = mailbox(&db, &account.summary.id, "Trash", &MailboxRole::Trash);
        let other_inbox = mailbox(&db, &other.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut archived = message(1, "2026-08-17T12:00:00Z");
        archived.message_id = Some("<parent@example.test>".into());
        archived.subject = "Earlier note".into();
        db.upsert_message(&account.summary.id, inbox, &archived)
            .unwrap();
        let mut trashed = message(2, "2026-08-19T12:00:00Z");
        trashed.message_id = Some("<parent@example.test>".into());
        trashed.subject = "Trashed copy".into();
        db.upsert_message(&account.summary.id, trash, &trashed)
            .unwrap();
        let mut foreign = message(3, "2026-08-19T12:00:00Z");
        foreign.message_id = Some("<parent@example.test>".into());
        db.upsert_message(&other.summary.id, other_inbox, &foreign)
            .unwrap();
        let found = db
            .find_message_by_header_id(&account.summary.id, "<parent@example.test>")
            .unwrap()
            .unwrap();
        assert_eq!(found.subject, "Earlier note");
        assert_eq!(found.mailbox_id, inbox);
        assert!(db
            .find_message_by_header_id(&account.summary.id, "<missing@example.test>")
            .unwrap()
            .is_none());
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

        let full = CachePolicy {
            mode: "full".into(),
            days: 0,
            max_bytes: 0,
        };
        let uncached = db
            .prefetch_candidates(mailbox_id, &full, 10, u64::MAX, 1000)
            .unwrap();
        assert_eq!(
            uncached.iter().map(|(uid, _)| *uid).collect::<Vec<_>>(),
            vec![4, 3, 1]
        );
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
        let saved = db
            .update_account_reply_to("acc-1", "replies@example.com")
            .unwrap();
        assert_eq!(saved.reply_to, "replies@example.com");
        assert_eq!(
            db.list_accounts()
                .unwrap()
                .into_iter()
                .find(|account| account.id == "acc-1")
                .unwrap()
                .reply_to,
            "replies@example.com"
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

    #[test]
    fn purge_stale_mailbox_removes_rows_and_generation_bound_operations() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, &account.summary.id, "Archive", &MailboxRole::Archive);
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(7, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let message_id = db.message_summary_by_uid(inbox, 7).unwrap().unwrap().id;
        db.queue_operation(
            &account.summary.id,
            "flags",
            &serde_json::json!({"messageId": message_id, "uid": 7, "mailbox": "INBOX"}),
            Some("flags:7"),
        )
        .unwrap();
        db.queue_operation(
            &account.summary.id,
            "move",
            &serde_json::json!({
                "messageId": message_id,
                "uid": 7,
                "source": "INBOX",
                "destination": "Archive"
            }),
            Some("move:7"),
        )
        .unwrap();
        db.queue_operation(
            &account.summary.id,
            "flags",
            &serde_json::json!({"messageId": message_id, "uid": 7, "mailbox": "Archive"}),
            Some("flags:archive:7"),
        )
        .unwrap();

        db.purge_stale_mailbox(&account.summary.id, "INBOX", inbox)
            .unwrap();

        assert_eq!(db.max_uid(inbox).unwrap(), 0);
        assert!(db.list_messages(inbox, None, 10).unwrap().items.is_empty());
        let remaining = db.queued_operations(&account.summary.id).unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0].2.contains("Archive"));
        assert!(db.message_summary_by_uid(archive, 7).unwrap().is_none());
    }

    #[test]
    fn outbox_and_offline_mutations_are_account_scoped() {
        let db = Database::memory();
        let first = account_with_id("account-1", "one@example.com");
        let second = account_with_id("account-2", "two@example.com");
        db.insert_account(&first).unwrap();
        db.insert_account(&second).unwrap();
        let draft = draft(&first.summary.id);
        let outbox_id = db
            .queue_outbox(
                &draft,
                "queued",
                None,
                "<stable@example.com>",
                b"Subject: test\r\n\r\nbody",
                None,
            )
            .unwrap();

        db.set_outbox_state(
            &outbox_id,
            &second.summary.id,
            "needs_attention",
            Some("wrong"),
        )
        .unwrap();
        let (_, state) = db.outbox(&outbox_id, &first.summary.id).unwrap();
        assert_eq!(state, "queued");
        assert_eq!(
            db.remove_outbox(&outbox_id, &second.summary.id),
            Err("Queued message not found.".into())
        );
        assert!(db.outbox(&outbox_id, &first.summary.id).is_ok());

        db.set_outbox_state(
            &outbox_id,
            &first.summary.id,
            "needs_attention",
            Some("right"),
        )
        .unwrap();
        let (_, state) = db.outbox(&outbox_id, &first.summary.id).unwrap();
        assert_eq!(state, "needs_attention");
        db.remove_outbox(&outbox_id, &first.summary.id).unwrap();
        assert!(db.outbox(&outbox_id, &first.summary.id).is_err());

        db.queue_operation(
            &first.summary.id,
            "flags",
            &serde_json::json!({"uid": 1}),
            Some("flags:1"),
        )
        .unwrap();
        let operation_id = db.queued_operations(&first.summary.id).unwrap()[0].0;
        db.remove_operation(&second.summary.id, operation_id)
            .unwrap();
        assert_eq!(db.queued_operations(&first.summary.id).unwrap().len(), 1);
        db.remove_operation(&first.summary.id, operation_id)
            .unwrap();
        assert!(db.queued_operations(&first.summary.id).unwrap().is_empty());
    }

    #[test]
    fn duplicate_account_email_is_reported_as_already_set_up() {
        let db = Database::memory();
        db.insert_account(&account()).unwrap();
        let duplicate = account_with_id("account-2", "sam@example.com");
        assert_eq!(
            db.insert_account(&duplicate),
            Err("An account with this email address is already set up.".into())
        );
        assert!(db.email_taken("sam@example.com").unwrap());
        assert_eq!(db.list_accounts().unwrap().len(), 1);
    }

    // Failure modes E1-E9, S2, S8, S9, D2 and D4 from docs/SYNC_FAILURE_MODES.md.

    fn recent(days: u32) -> CachePolicy {
        CachePolicy {
            mode: "recent".into(),
            days,
            max_bytes: 0,
        }
    }

    fn full(max_bytes: u64) -> CachePolicy {
        CachePolicy {
            mode: "full".into(),
            days: 0,
            max_bytes,
        }
    }

    fn envelope_only(uid: u32, received_at: &str) -> CachedMessage {
        let mut value = message(uid, received_at);
        value.raw_message = Vec::new();
        value.text_body = String::new();
        value
    }

    fn days_ago(days: i64) -> String {
        crate::mail::parse::canonical_time(Utc::now() - chrono::Duration::days(days))
    }

    fn cached(db: &Database, mailbox: i64, uid: u32, account_id: &str) -> bool {
        let id = db.message_summary_by_uid(mailbox, uid).unwrap().unwrap().id;
        db.message_content_cached(id, account_id).unwrap()
    }

    #[test]
    fn importance_round_trips_and_an_envelope_without_it_keeps_the_stored_value() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let mut full = message(1, "2026-08-18T12:00:00Z");
        full.importance = "HIGH".into();
        db.upsert_message(account_id, inbox, &full).unwrap();
        let blank = envelope_only(1, "2026-08-18T12:00:00Z");
        db.upsert_envelope(account_id, inbox, &blank).unwrap();
        let kept = db.message_summary_by_uid(inbox, 1).unwrap().unwrap();
        assert_eq!(kept.importance, "high");

        let mut injected = message(2, "2026-08-18T12:00:00Z");
        injected.importance = "high\r\nBcc: evil@example.com".into();
        db.upsert_message(account_id, inbox, &injected).unwrap();
        let rejected = db.message_summary_by_uid(inbox, 2).unwrap().unwrap();
        assert_eq!(rejected.importance, "");

        let mut envelope = envelope_only(3, "2026-08-18T12:00:00Z");
        envelope.importance = "low".into();
        db.upsert_envelope(account_id, inbox, &envelope).unwrap();
        let listed = db.message_summary_by_uid(inbox, 3).unwrap().unwrap();
        assert_eq!(listed.importance, "low");
    }

    #[test]
    fn read_receipt_choice_survives_a_later_body_write() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let mut full = message(1, "2026-08-18T12:00:00Z");
        full.disposition_to = "Jane <jane@example.com>".into();
        full.raw_message = b"Disposition-Notification-To: Jane <jane@example.com>\r\nSubject: Family picnic\r\n\r\nBring sandwiches".to_vec();
        db.upsert_message(account_id, inbox, &full).unwrap();
        let id = db.message_summary_by_uid(inbox, 1).unwrap().unwrap().id;
        let detail = db.message_detail(id, account_id).unwrap();
        assert_eq!(detail.disposition_to, "");
        full.disposition_to = "jane@example.com".into();
        db.upsert_message(account_id, inbox, &full).unwrap();
        let detail = db.message_detail(id, account_id).unwrap();
        assert_eq!(detail.disposition_to, "jane@example.com");
        assert_eq!(detail.receipt_choice, "");
        assert_eq!(
            db.set_receipt_choice(id, account_id, "declined").unwrap(),
            "declined"
        );
        full.disposition_to = "lee@example.com".into();
        db.upsert_message(account_id, inbox, &full).unwrap();
        let detail = db.message_detail(id, account_id).unwrap();
        assert_eq!(detail.disposition_to, "lee@example.com");
        assert_eq!(detail.receipt_choice, "declined");
        assert_eq!(
            db.set_receipt_choice(id, account_id, "sent").unwrap(),
            "declined"
        );
        let mut envelope = envelope_only(1, "2026-08-18T12:00:00Z");
        envelope.disposition_to = "evil@example.com".into();
        db.upsert_envelope(account_id, inbox, &envelope).unwrap();
        let detail = db.message_detail(id, account_id).unwrap();
        assert_eq!(detail.disposition_to, "lee@example.com");
        assert_eq!(detail.receipt_choice, "declined");
    }

    #[test]
    fn pin_stays_through_an_envelope_refresh_and_sorts_first() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(account_id, inbox, &message(3, "2026-08-18T12:00:00Z"))
            .unwrap();
        db.upsert_message(account_id, inbox, &message(2, "2026-08-17T12:00:00Z"))
            .unwrap();
        db.upsert_message(account_id, inbox, &message(1, "2026-08-16T12:00:00Z"))
            .unwrap();
        let oldest = db.message_summary_by_uid(inbox, 1).unwrap().unwrap();
        assert!(!oldest.pinned);
        assert_eq!(db.set_pinned(account_id, &[oldest.id], true).unwrap(), 1);
        assert_eq!(
            db.set_pinned("other-account", &[oldest.id], false).unwrap(),
            0
        );
        let blank = envelope_only(1, "2026-08-16T12:00:00Z");
        db.upsert_envelope(account_id, inbox, &blank).unwrap();
        let first = db.list_messages(inbox, None, 2).unwrap();
        assert_eq!(
            first.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert!(first.items[0].pinned);
        assert!(first.has_more);
        let second = db
            .list_messages(inbox, first.next_cursor.as_ref(), 2)
            .unwrap();
        assert_eq!(
            second.items.iter().map(|item| item.uid).collect::<Vec<_>>(),
            vec![2]
        );
        assert!(!second.has_more);
        assert_eq!(db.set_pinned(account_id, &[oldest.id], false).unwrap(), 1);
        let unpinned = db.list_messages(inbox, None, 3).unwrap();
        assert_eq!(
            unpinned
                .items
                .iter()
                .map(|item| item.uid)
                .collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        let too_many = vec![0_i64; 201];
        assert!(db.set_pinned(account_id, &too_many, true).is_err());
    }

    #[test]
    fn per_account_eviction_keeps_envelopes_drafts_and_outbox() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(account_id, inbox, &message(1, "2000-01-01T00:00:00+00:00"))
            .unwrap();
        let draft_id = db.save_draft(&draft(account_id)).unwrap();
        db.queue_outbox(
            &draft(account_id),
            "queued",
            None,
            "<q@example.com>",
            b"MIME",
            None,
        )
        .unwrap();

        db.evict_account_to_policy(account_id, &recent(90)).unwrap();

        let page = db.list_messages(inbox, None, 10).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].subject, "Family picnic");
        assert!(!cached(&db, inbox, 1, account_id));
        assert!(db.draft(&draft_id, account_id).is_ok());
        assert_eq!(db.list_outbox(account_id).unwrap().len(), 1);
        let (fts_rows, message_rows): (i64, i64) = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM message_fts), (SELECT COUNT(*) FROM messages)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(fts_rows, message_rows);
    }

    #[test]
    fn widening_policy_reactivates_cutoff_backfill() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let default = CachePolicy::default();
        db.set_account_cache_policy(account_id, &recent(90), &default)
            .unwrap();
        db.set_backfill(inbox, Some(40), "cutoff").unwrap();

        assert!(!db
            .set_account_cache_policy(account_id, &recent(30), &default)
            .unwrap());
        assert_eq!(
            db.mailbox_sync_meta(inbox).unwrap().backfill_state,
            "cutoff"
        );

        assert!(db
            .set_account_cache_policy(account_id, &recent(365), &default)
            .unwrap());
        assert_eq!(
            db.mailbox_sync_meta(inbox).unwrap().backfill_state,
            "active"
        );

        db.set_backfill(inbox, Some(40), "cutoff").unwrap();
        assert!(db
            .set_account_cache_policy(account_id, &full(0), &default)
            .unwrap());
        assert_eq!(
            db.mailbox_sync_meta(inbox).unwrap().backfill_state,
            "active"
        );
        assert_eq!(
            db.account_cache_policy(account_id, &default).unwrap().mode,
            "full"
        );
    }

    #[test]
    fn size_cap_keeps_recently_opened_bodies() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        for (uid, date) in [(1, days_ago(30)), (2, days_ago(20)), (3, days_ago(10))] {
            db.upsert_message(account_id, inbox, &message(uid, &date))
                .unwrap();
        }
        let oldest = db.message_summary_by_uid(inbox, 1).unwrap().unwrap().id;
        db.message_detail(oldest, account_id).unwrap();
        let one_body = message(1, "").raw_message.len() + message(1, "").text_body.len();

        db.evict_account_to_policy(account_id, &full((one_body * 2) as u64))
            .unwrap();

        assert!(cached(&db, inbox, 1, account_id), "opened today");
        assert!(cached(&db, inbox, 3, account_id), "newest");
        assert!(!cached(&db, inbox, 2, account_id));
    }

    #[test]
    fn prefetch_candidates_respect_recent_cutoff() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_envelope(account_id, inbox, &envelope_only(1, &days_ago(200)))
            .unwrap();
        db.upsert_envelope(account_id, inbox, &envelope_only(2, &days_ago(5)))
            .unwrap();

        let candidates = db
            .prefetch_candidates(inbox, &recent(90), 10, u64::MAX, u64::MAX)
            .unwrap();
        assert_eq!(
            candidates.iter().map(|(uid, _)| *uid).collect::<Vec<_>>(),
            vec![2]
        );
        let everything = db
            .prefetch_candidates(inbox, &full(0), 10, u64::MAX, u64::MAX)
            .unwrap();
        assert_eq!(everything.len(), 2);
    }

    #[test]
    fn prefetch_candidates_plan_uses_order_index() {
        let db = Database::memory();
        let conn = db.conn().unwrap();
        let explain = format!(
            "EXPLAIN QUERY PLAN {}",
            files_cache::PREFETCH_CANDIDATES_SQL
        );
        let mut statement = conn.prepare(&explain).unwrap();
        let details: Vec<String> = statement
            .query_map(params![1i64, 1i64, None::<String>, 10u32], |row| row.get(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("messages_prefetch_order")),
            "plan: {details:?}"
        );
        assert!(
            !details
                .iter()
                .any(|detail| detail.contains("USE TEMP B-TREE FOR ORDER BY")),
            "plan: {details:?}"
        );
    }

    #[test]
    fn per_account_eviction_is_isolated() {
        let db = Database::memory();
        let first = account();
        let second = account_with_id("22222222-2222-4222-8222-222222222222", "kim@example.com");
        db.insert_account(&first).unwrap();
        db.insert_account(&second).unwrap();
        let first_inbox = mailbox(&db, &first.summary.id, "INBOX", &MailboxRole::Inbox);
        let second_inbox = mailbox(&db, &second.summary.id, "INBOX", &MailboxRole::Inbox);
        let old = "2000-01-01T00:00:00+00:00";
        db.upsert_message(&first.summary.id, first_inbox, &message(1, old))
            .unwrap();
        db.upsert_message(&second.summary.id, second_inbox, &message(1, old))
            .unwrap();

        db.evict_account_to_policy(&first.summary.id, &recent(90))
            .unwrap();
        db.evict_account_to_policy(&first.summary.id, &full(1))
            .unwrap();

        assert!(!cached(&db, first_inbox, 1, &first.summary.id));
        assert!(cached(&db, second_inbox, 1, &second.summary.id));
        assert_eq!(
            db.account_cache_usage(&first.summary.id, 0).unwrap().bytes,
            0
        );
        assert!(db.account_cache_usage(&second.summary.id, 0).unwrap().bytes > 0);
    }

    #[test]
    fn unlimited_policy_never_evicts() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(account_id, inbox, &message(1, "1990-01-01T00:00:00+00:00"))
            .unwrap();

        db.evict_account_to_policy(account_id, &full(0)).unwrap();

        assert!(cached(&db, inbox, 1, account_id));
    }

    #[test]
    fn policy_seed_is_idempotent() {
        let db = Database::memory();
        let first = account();
        let second = account_with_id("33333333-3333-4333-8333-333333333333", "lee@example.com");
        db.insert_account(&first).unwrap();
        db.insert_account(&second).unwrap();
        db.seed_account_cache_policies(&recent(90)).unwrap();
        db.set_account_cache_policy(&first.summary.id, &full(0), &recent(90))
            .unwrap();

        db.seed_account_cache_policies(&recent(30)).unwrap();

        assert_eq!(
            db.account_cache_policy(&first.summary.id, &recent(7))
                .unwrap()
                .mode,
            "full"
        );
        assert_eq!(
            db.account_cache_policy(&second.summary.id, &recent(7))
                .unwrap()
                .days,
            90
        );
    }

    #[test]
    fn migrates_v17_to_v18_preserving_rows() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(account_id, inbox, &message(1, "2026-08-18T12:00:00+00:00"))
            .unwrap();
        {
            let mut connection = db.conn().unwrap();
            connection
                .execute_batch(
                    "DROP INDEX messages_account_message_id;
                     DROP INDEX messages_account_thread_parent;
                     DROP INDEX messages_mailbox_internal;
                     DROP INDEX messages_account_bodies;
                     DROP INDEX messages_prefetch_order;
                     ALTER TABLE accounts DROP COLUMN cache_mode;
                     ALTER TABLE accounts DROP COLUMN cache_days;
                     ALTER TABLE accounts DROP COLUMN cache_max_bytes;
                     ALTER TABLE accounts DROP COLUMN color;
                     ALTER TABLE accounts DROP COLUMN sort_order;
                     ALTER TABLE mailboxes DROP COLUMN highest_modseq;
                     ALTER TABLE mailboxes DROP COLUMN backfill_state;
                     ALTER TABLE mailboxes DROP COLUMN last_flag_scan_at;
                     ALTER TABLE mailboxes DROP COLUMN sync_error;
                     ALTER TABLE mailboxes DROP COLUMN delimiter;
                     ALTER TABLE messages DROP COLUMN internal_at;
                     ALTER TABLE messages DROP COLUMN body_bytes;
                     ALTER TABLE messages DROP COLUMN prefetch_failures;
                     ALTER TABLE messages DROP COLUMN prefetch_retry_at;
                     UPDATE mailboxes SET backfill_uid=0;
                     PRAGMA user_version=17;",
                )
                .unwrap();
            migrate_schema(&mut connection).unwrap();
            let version: u32 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, CURRENT_SCHEMA_VERSION);
        }
        let meta = db.mailbox_sync_meta(inbox).unwrap();
        assert_eq!(meta.backfill_state, "cutoff");
        assert!(cached(&db, inbox, 1, account_id));
        assert!(db.account_cache_usage(account_id, 0).unwrap().bytes > 0);
        let internal_at: Option<String> = db
            .conn()
            .unwrap()
            .query_row("SELECT internal_at FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(internal_at.as_deref(), Some("2026-08-18T12:00:00+00:00"));
        assert_eq!(
            db.account_cache_policy(account_id, &recent(45))
                .unwrap()
                .days,
            45
        );
    }

    // v19 failure modes, written before the migration:
    // - a v18 DB with drafts/outbox/messages/managed attachments loses rows
    // - migration is partial or not inside the migrate_schema transaction
    // - migrated schema differs from a fresh schema
    // - defaults are wrong (formats must be 'html', calendar 0, others NULL)
    // - an unknown body_format / source_kind is accepted at the IPC boundary
    // - re-running the migration fails or resets stored values
    const V19_DROPS: &str = "ALTER TABLE drafts DROP COLUMN source_message_id;
         ALTER TABLE drafts DROP COLUMN source_kind;
         ALTER TABLE drafts DROP COLUMN body_format;
         ALTER TABLE accounts DROP COLUMN default_body_format;
         ALTER TABLE messages DROP COLUMN list_unsubscribe;
         ALTER TABLE messages DROP COLUMN list_unsubscribe_post;
         ALTER TABLE messages DROP COLUMN has_calendar;";

    fn table_columns(
        connection: &Connection,
        table: &str,
    ) -> Vec<(String, String, i64, Option<String>)> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let mut columns = statement
            .query_map([], |row| {
                Ok((row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        columns.sort();
        columns
    }

    // v20 failure modes: cached message lost; reply flags default to set;
    // migrated shape differs from fresh; re-run from v19 fails.
    #[test]
    fn migrates_v19_to_v20_preserving_messages_and_defaults() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(account_id, inbox, &message(1, "2026-08-18T12:00:00+00:00"))
            .unwrap();
        let fresh_shape = table_columns(&db.conn().unwrap(), "messages");
        {
            let mut connection = db.conn().unwrap();
            connection
                .execute_batch(
                    "ALTER TABLE messages DROP COLUMN is_answered;
                     ALTER TABLE messages DROP COLUMN is_forwarded;
                     ALTER TABLE messages DROP COLUMN calendar_json;
                     PRAGMA user_version=19;",
                )
                .unwrap();
            migrate_schema(&mut connection).unwrap();
            connection.execute_batch("PRAGMA user_version=19;").unwrap();
            migrate_schema(&mut connection).unwrap();
            let version: u32 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, CURRENT_SCHEMA_VERSION);
            assert_eq!(table_columns(&connection, "messages"), fresh_shape);
        }
        assert!(cached(&db, inbox, 1, account_id));
        let (answered, forwarded, calendar): (i64, i64, Option<String>) = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT is_answered,is_forwarded,calendar_json FROM messages",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((answered, forwarded, calendar), (0, 0, None));
    }

    #[test]
    fn migrates_v18_to_v19_preserving_rows_and_defaults() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(account_id, inbox, &message(1, "2026-08-18T12:00:00+00:00"))
            .unwrap();
        let draft_id = db.save_draft(&draft(account_id)).unwrap();
        {
            let connection = db.conn().unwrap();
            connection
                .execute(
                    "INSERT INTO file_grants(token,path,account_id,size) VALUES('tok','/tmp/x',?1,0)",
                    [account_id],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO attachment_refs(token,owner_kind,owner_id) VALUES('tok','draft',?1)",
                    [&draft_id],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO outbox(id,account_id,draft_json,state) VALUES('o1',?1,'{}','queued')",
                    [account_id],
                )
                .unwrap();
        }
        let fresh_shape = {
            let connection = db.conn().unwrap();
            ["drafts", "accounts", "messages", "outbox"]
                .map(|table| table_columns(&connection, table))
        };
        {
            let mut connection = db.conn().unwrap();
            connection
                .execute_batch(&format!("{V19_DROPS} PRAGMA user_version=18;"))
                .unwrap();
            migrate_schema(&mut connection).unwrap();
            // Re-running from the same version must be a no-op.
            connection.execute_batch("PRAGMA user_version=18;").unwrap();
            migrate_schema(&mut connection).unwrap();
            let version: u32 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, CURRENT_SCHEMA_VERSION);
            let migrated_shape = ["drafts", "accounts", "messages", "outbox"]
                .map(|table| table_columns(&connection, table));
            assert_eq!(migrated_shape, fresh_shape);
        }
        assert!(cached(&db, inbox, 1, account_id));
        assert_eq!(
            db.draft(&draft_id, account_id).unwrap().subject,
            "Family update"
        );
        let connection = db.conn().unwrap();
        let refs: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM attachment_refs WHERE token='tok'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(refs, 1);
        let outbox: i64 = connection
            .query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outbox, 1);
        let (format, source_id, source_kind): (String, Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT body_format,source_message_id,source_kind FROM drafts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (format.as_str(), source_id, source_kind),
            ("html", None, None)
        );
        let account_format: String = connection
            .query_row("SELECT default_body_format FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(account_format, "html");
        let (unsub, post, calendar): (Option<String>, Option<String>, i64) = connection
            .query_row(
                "SELECT list_unsubscribe,list_unsubscribe_post,has_calendar FROM messages",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((unsub, post, calendar), (None, None, 0));
    }

    #[test]
    fn failed_v19_step_rolls_back_whole_migration() {
        let db = Database::memory();
        let mut connection = db.conn().unwrap();
        connection
            .execute_batch(&format!("{V19_DROPS} PRAGMA user_version=18;"))
            .unwrap();
        let tx = connection.transaction().unwrap();
        migrate_v19(&tx).unwrap();
        drop(tx); // dropped without commit: nothing persists
        assert!(!column_exists(&connection, "drafts", "body_format").unwrap());
        assert!(!column_exists(&connection, "messages", "has_calendar").unwrap());
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 18);
    }

    #[test]
    fn draft_round_trip_keeps_source_and_format() {
        use crate::models::{BodyFormat, DraftSourceKind};
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let mut value = draft(account_id);
        value.body_format = BodyFormat::Plain;
        value.source_message_id = Some(42);
        value.source_kind = Some(DraftSourceKind::ReplyAll);
        let id = db.save_draft(&value).unwrap();
        let loaded = db.draft(&id, account_id).unwrap();
        assert_eq!(loaded.body_format, BodyFormat::Plain);
        assert_eq!(loaded.source_kind, Some(DraftSourceKind::ReplyAll));
        let row: (String, Option<i64>, Option<String>) = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT body_format,source_message_id,source_kind FROM drafts WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("plain".into(), Some(42), Some("reply_all".into())));
    }

    #[test]
    fn unknown_enum_strings_are_rejected_at_ipc() {
        use crate::models::{BodyFormat, DraftSourceKind};
        assert!(serde_json::from_str::<BodyFormat>("\"rtf\"").is_err());
        assert!(serde_json::from_str::<DraftSourceKind>("\"bounce\"").is_err());
        assert_eq!(
            serde_json::from_str::<DraftSourceKind>("\"redirect\"").unwrap(),
            DraftSourceKind::Redirect
        );
        assert_eq!(
            serde_json::from_str::<DraftSourceKind>("\"reply_all\"").unwrap(),
            DraftSourceKind::ReplyAll
        );
        // Legacy draft JSON without the new keys still loads with defaults.
        let legacy = r#"{"id":null,"accountId":"a","from":null,"to":[],"cc":[],"bcc":[],"subject":"","htmlBody":"","textBody":"","attachments":[],"inReplyTo":null,"references":null}"#;
        let parsed: ComposeDraft = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.body_format, BodyFormat::Html);
        assert_eq!(parsed.source_kind, None);
    }

    #[test]
    fn expunge_reconcile_keeps_pending_moves() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, account_id, "Archive", &MailboxRole::Archive);
        for uid in 1..=3 {
            db.upsert_envelope(
                account_id,
                inbox,
                &envelope_only(uid, "2026-08-18T12:00:00+00:00"),
            )
            .unwrap();
        }
        let moving = db.message_summary_by_uid(inbox, 2).unwrap().unwrap().id;
        db.mark_pending_move(moving, archive).unwrap();

        let server = [3u32].into_iter().collect::<std::collections::HashSet<_>>();
        let removed = db.reconcile_expunged(inbox, 1, 3, &server).unwrap();

        assert_eq!(removed, 1);
        assert_eq!(db.cached_message_count(inbox).unwrap(), 2);
        assert_eq!(db.pending_move_uids(inbox).unwrap(), vec![2]);
    }

    // Failure modes: VANISHED must not touch the same UID in another mailbox,
    // rows under a pending move, or UIDs never cached; repeats are harmless.
    #[test]
    fn apply_vanished_is_mailbox_scoped_and_keeps_pending_moves() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let archive = mailbox(&db, account_id, "Archive", &MailboxRole::Archive);
        for uid in 1..=4 {
            db.upsert_envelope(
                account_id,
                inbox,
                &envelope_only(uid, "2026-08-18T12:00:00+00:00"),
            )
            .unwrap();
        }
        db.upsert_envelope(
            account_id,
            archive,
            &envelope_only(1, "2026-08-18T12:00:00+00:00"),
        )
        .unwrap();
        let moving = db.message_summary_by_uid(inbox, 2).unwrap().unwrap().id;
        db.mark_pending_move(moving, archive).unwrap();

        let removed = db.apply_vanished(inbox, &[1, 2, 99]).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(db.cached_message_count(inbox).unwrap(), 3);
        assert_eq!(db.cached_message_count(archive).unwrap(), 1);
        assert_eq!(db.pending_move_uids(inbox).unwrap(), vec![2]);
        assert_eq!(db.apply_vanished(inbox, &[1]).unwrap(), 0);
        assert_eq!(db.apply_vanished(inbox, &[]).unwrap(), 0);
    }

    // Failure modes: `from:` matches a body mention; operator-only queries
    // return nothing; `after:` drops its own day or `before:` includes it;
    // subject hits rank below body hits; hostile FTS text errors or widens
    // the match; operators leak rows across mailboxes.
    #[test]
    fn search_operators_filter_and_rank() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let other = mailbox(&db, account_id, "Other", &MailboxRole::Other);
        let mut first = message(1, "2026-08-10T09:00:00+00:00");
        first.subject = "Budget review".into();
        first.text_body = "numbers inside".into();
        first.importance = "high".into();
        let mut second = message(2, "2026-08-20T09:00:00+00:00");
        second.subject = "Lunch".into();
        second.sender_name = "Bob".into();
        second.sender_address = "bob@example.com".into();
        second.text_body = "the budget came from jane".into();
        second.is_read = true;
        second.is_starred = true;
        second.importance = "low".into();
        second.size = 2_000_000;
        second.attachments = vec![Attachment {
            id: "a1".into(),
            filename: "100%plan.pdf".into(),
            content_type: "application/pdf".into(),
            size: 10,
            content_id: None,
            inline: false,
        }];
        let mut third = message(3, "2026-09-01T09:00:00+00:00");
        third.subject = "Trip".into();
        third.recipients = "sam@example.com, lee@example.com".into();
        third.text_body = "photos".into();
        third.is_read = true;
        third.size = 500;
        for item in [&first, &second, &third] {
            db.upsert_message(account_id, inbox, item).unwrap();
        }
        let mut stray = message(1, "2026-08-11T09:00:00+00:00");
        stray.subject = "Budget elsewhere".into();
        db.upsert_message(account_id, other, &stray).unwrap();
        let id_for = |uid: u32| -> i64 {
            db.conn()
                .unwrap()
                .query_row(
                    "SELECT id FROM messages WHERE mailbox_id=?1 AND uid=?2",
                    rusqlite::params![inbox, uid],
                    |row| row.get(0),
                )
                .unwrap()
        };
        db.mark_replied(id_for(2), account_id, true, false).unwrap();
        db.mark_replied(id_for(3), account_id, false, true).unwrap();
        assert_eq!(db.set_pinned(account_id, &[id_for(1)], true).unwrap(), 1);

        let run = |text: &str| -> Vec<u32> {
            db.search(&SearchQuery {
                account_id: account_id.clone(),
                mailbox_id: Some(inbox),
                text: text.into(),
                all_folders: false,
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|item| item.uid)
            .collect()
        };
        // Subject weight beats a body mention.
        assert_eq!(run("budget"), vec![1, 2]);
        let mut from = run("from:jane");
        from.sort_unstable();
        assert_eq!(from, vec![1, 3]);
        assert_eq!(run("from:jane is:unread"), vec![1]);
        assert_eq!(run("is:flagged"), vec![2]);
        assert_eq!(run("is:starred"), vec![2]);
        assert_eq!(run("is:pinned"), vec![1]);
        assert_eq!(run("is:pinned is:important"), vec![1]);
        assert!(run("is:pinned is:starred").is_empty());
        assert!(run("is:pin").is_empty());
        assert_eq!(run("is:important"), vec![1]);
        assert_eq!(run("is:high"), vec![1]);
        assert_eq!(run("is:low"), vec![2]);
        assert_eq!(run("is:important from:jane"), vec![1]);
        assert!(run("is:important from:bob@example.com").is_empty());
        assert_eq!(run("is:important is:low"), vec![2]);
        assert!(run("is:urgent").is_empty());
        assert_eq!(run("is:replied"), vec![2]);
        assert_eq!(run("is:answered"), vec![2]);
        assert_eq!(run("is:forwarded"), vec![3]);
        assert_eq!(run("has:attachment"), vec![2]);
        assert_eq!(run("filename:plan"), vec![2]);
        assert_eq!(run("filename:PLAN"), vec![2]);
        assert_eq!(run("filename:100%"), vec![2]);
        assert!(run("filename:1000").is_empty());
        assert_eq!(run("larger:1M"), vec![2]);
        assert_eq!(run("smaller:1K"), vec![3, 1]);
        assert_eq!(run("larger:100 smaller:1K"), vec![3]);
        let run_all = |text: &str| -> Vec<(i64, u32)> {
            db.search(&SearchQuery {
                account_id: account_id.clone(),
                mailbox_id: Some(inbox),
                text: text.into(),
                all_folders: true,
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|item| (item.mailbox_id, item.uid))
            .collect()
        };
        assert_eq!(
            run_all("in:inbox")
                .into_iter()
                .map(|(_, uid)| uid)
                .collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        assert_eq!(run_all("in:other"), vec![(other, 1)]);
        assert_eq!(run_all("in:inbox subject:budget"), vec![(inbox, 1)]);
        assert!(run_all("in:no-such-folder").is_empty());
        assert_eq!(run("to:lee"), vec![3]);
        assert_eq!(run("subject:budget"), vec![1]);
        assert_eq!(run("body:budget"), vec![2]);
        assert_eq!(run("body:numbers"), vec![1]);
        assert_eq!(run("body:numbers from:jane"), vec![1]);
        assert!(run("body:budget from:jane").is_empty());
        assert!(run("body:").is_empty());
        assert!(run("bodies:budget").is_empty());
        assert_eq!(run("is:read after:2026-08-20 before:2026-09-01"), vec![2]);
        assert_eq!(run("after:2026-08-11"), vec![3, 2]);
        assert_eq!(run("before:2026-08-11"), vec![1]);
        assert_eq!(run("on:2026-08-20"), vec![2]);
        assert_eq!(run("on:2026-08-10"), vec![1]);
        assert!(run("on:2026-08-21").is_empty());
        assert_eq!(run("on:2026-08-20 from:bob@example.com"), vec![2]);
        assert!(run("on:2026-08-20 from:jane").is_empty());
        assert!(run("on:2026-13-45").is_empty());
        // Unknown operators fall back to plain text; no match here.
        assert!(run("nosuch:thing").is_empty());
        // FTS syntax stays literal.
        for hostile in [
            "budget OR \"",
            "NEAR(a b) OR *",
            "from:\"x\" OR subject:*",
            "\"unterminated",
            "-budget",
            "sender:jane",
        ] {
            let _ = run(hostile);
        }
        assert!(run("cc:sam@example.com").is_empty());
        assert!(run("is:muted").is_empty());
        assert!(run("sender:jane").is_empty());
        assert!(run("").is_empty());
    }

    #[test]
    fn search_me_matches_this_account_not_a_lookalike() {
        let db = Database::memory();
        let mut account = account();
        account.summary.aliases = vec!["Alias@Example.com".into()];
        db.insert_account(&account).unwrap();
        let account_id = &account.summary.id;
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let mut outbound = message(1, "2026-08-18T12:00:00Z");
        outbound.sender_address = "sam@example.com".into();
        outbound.sender_name = "Sam".into();
        outbound.recipients = "lee@example.com".into();
        outbound.to = vec!["lee@example.com".into()];
        outbound.subject = "Outbound".into();
        outbound.text_body = "hello".into();
        let mut inbound = message(2, "2026-08-18T13:00:00Z");
        inbound.sender_address = "jane@example.com".into();
        inbound.recipients = "sam@example.com".into();
        inbound.to = vec!["sam@example.com".into()];
        inbound.subject = "Inbound".into();
        inbound.text_body = "hi".into();
        let mut alias_copy = message(3, "2026-08-18T14:00:00Z");
        alias_copy.sender_address = "Alias@Example.com".into();
        alias_copy.recipients = "lee@example.com, sam@example.com".into();
        alias_copy.to = vec!["lee@example.com".into()];
        alias_copy.cc = vec!["sam@example.com".into()];
        alias_copy.subject = "Alias".into();
        alias_copy.text_body = "copy".into();
        let mut lookalike = message(4, "2026-08-18T15:00:00Z");
        lookalike.sender_address = "notsam@example.com".into();
        lookalike.sender_name = "Sam".into();
        lookalike.recipients = "notsam@example.com".into();
        lookalike.to = vec!["notsam@example.com".into()];
        lookalike.subject = "Lookalike".into();
        lookalike.text_body = "no".into();
        for item in [&outbound, &inbound, &alias_copy, &lookalike] {
            db.upsert_message(account_id, inbox, item).unwrap();
        }
        let run = |text: &str| -> Vec<u32> {
            db.search(&SearchQuery {
                account_id: account_id.clone(),
                mailbox_id: Some(inbox),
                text: text.into(),
                all_folders: false,
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|item| item.uid)
            .collect()
        };
        assert_eq!(run("from:me"), vec![3, 1]);
        assert_eq!(run("FROM:ME"), vec![3, 1]);
        assert_eq!(run("to:me"), vec![3, 2]);
        assert_eq!(run("from:me to:me"), vec![3]);
        assert!(run("from:medea").is_empty());
        assert!(run("from:me@example.com").is_empty());
    }

    #[test]
    fn search_cc_matches_copied_addresses_only() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let account_id = &account.summary.id;
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let mut copied = message(1, "2026-08-18T12:00:00Z");
        copied.to = vec!["lee@example.com".into()];
        copied.cc = vec!["Sam@Example.com".into()];
        copied.recipients = "lee@example.com, Sam@Example.com".into();
        copied.subject = "Copied".into();
        copied.text_body = "copy".into();
        let mut direct = message(2, "2026-08-18T13:00:00Z");
        direct.to = vec!["sam@example.com".into()];
        direct.cc = vec!["lee@example.com".into()];
        direct.recipients = "sam@example.com, lee@example.com".into();
        direct.subject = "Direct".into();
        direct.text_body = "to".into();
        let mut lookalike = message(3, "2026-08-18T14:00:00Z");
        lookalike.to = vec!["lee@example.com".into()];
        lookalike.cc = vec!["notlee@example.com".into()];
        lookalike.recipients = "lee@example.com, notlee@example.com".into();
        lookalike.subject = "Lookalike".into();
        lookalike.text_body = "no".into();
        for item in [&copied, &direct, &lookalike] {
            db.upsert_message(account_id, inbox, item).unwrap();
        }
        let run = |text: &str| -> Vec<u32> {
            db.search(&SearchQuery {
                account_id: account_id.clone(),
                mailbox_id: Some(inbox),
                text: text.into(),
                all_folders: false,
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|item| item.uid)
            .collect()
        };
        assert_eq!(run("cc:me"), vec![1]);
        assert_eq!(run("CC:ME"), vec![1]);
        assert_eq!(run("cc:lee@example.com"), vec![2]);
        assert_eq!(run("cc:lee"), vec![2]);
        assert_eq!(run("to:me"), vec![2, 1]);
        assert!(run("cc:notsam@example.com").is_empty());
    }

    #[test]
    fn search_muted_matches_the_conversation_only() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let account_id = &account.summary.id;
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let parent = message(1, "2026-08-18T12:00:00Z");
        let mut child = message(2, "2026-08-18T13:00:00Z");
        child.thread_parent = Some("<1@example.com>".into());
        child.subject = "Reply".into();
        let other = message(3, "2026-08-18T14:00:00Z");
        for item in [&parent, &child, &other] {
            db.upsert_message(account_id, inbox, item).unwrap();
        }
        let rows = db.list_messages(inbox, None, 10).unwrap().items;
        let parent_id = rows.iter().find(|item| item.uid == 1).unwrap().id;
        assert!(db
            .search(&SearchQuery {
                account_id: account_id.clone(),
                mailbox_id: Some(inbox),
                text: "is:muted".into(),
                all_folders: false,
                limit: 10,
            })
            .unwrap()
            .is_empty());
        db.remember_muted_conversation(account_id, parent_id)
            .unwrap();
        let run = |text: &str| -> Vec<u32> {
            db.search(&SearchQuery {
                account_id: account_id.clone(),
                mailbox_id: Some(inbox),
                text: text.into(),
                all_folders: false,
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|item| item.uid)
            .collect()
        };
        assert_eq!(run("is:muted"), vec![2, 1]);
        assert_eq!(run("IS:MUTED"), vec![2, 1]);
        assert!(run("is:muted from:lee@example.com").is_empty());
        db.forget_muted_conversation(account_id, parent_id).unwrap();
        assert!(run("is:muted").is_empty());
    }

    #[test]
    fn prefetch_failures_back_off() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_envelope(account_id, inbox, &envelope_only(1, &days_ago(1)))
            .unwrap();
        db.upsert_envelope(account_id, inbox, &envelope_only(2, &days_ago(2)))
            .unwrap();

        db.record_prefetch_failure(inbox, 1).unwrap();
        let candidates = db
            .prefetch_candidates(inbox, &full(0), 10, u64::MAX, u64::MAX)
            .unwrap();
        assert_eq!(
            candidates.iter().map(|(uid, _)| *uid).collect::<Vec<_>>(),
            vec![2]
        );

        db.conn()
            .unwrap()
            .execute(
                "UPDATE messages SET prefetch_failures=5, prefetch_retry_at=NULL WHERE uid=1",
                [],
            )
            .unwrap();
        let candidates = db
            .prefetch_candidates(inbox, &full(0), 10, u64::MAX, u64::MAX)
            .unwrap();
        assert!(candidates.iter().all(|(uid, _)| *uid != 1));
    }

    #[test]
    fn prefetch_candidates_fit_budget() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        for (uid, size) in [(1u32, 400u64), (2, 300), (3, 200)] {
            let mut value = envelope_only(uid, &days_ago(i64::from(uid)));
            value.size = size;
            db.upsert_envelope(account_id, inbox, &value).unwrap();
        }

        let batch = db
            .prefetch_candidates(inbox, &full(0), 10, 550, u64::MAX)
            .unwrap();
        assert_eq!(
            batch.iter().map(|(uid, _)| *uid).collect::<Vec<_>>(),
            vec![1]
        );
        let oversized_first = db
            .prefetch_candidates(inbox, &full(0), 10, 100, u64::MAX)
            .unwrap();
        assert_eq!(oversized_first.len(), 1, "one item always makes progress");
        let capped = db
            .prefetch_candidates(inbox, &full(0), 10, u64::MAX, 250)
            .unwrap();
        assert_eq!(
            capped.iter().map(|(uid, _)| *uid).collect::<Vec<_>>(),
            vec![3]
        );
    }

    #[test]
    fn envelope_batch_is_atomic() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        db.conn()
            .unwrap()
            .execute_batch(
                "CREATE TEMP TRIGGER fail_second BEFORE INSERT ON messages WHEN NEW.uid=2
                 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
            )
            .unwrap();

        let batch = vec![
            envelope_only(1, "2026-08-18T12:00:00+00:00"),
            envelope_only(2, "2026-08-18T12:00:00+00:00"),
        ];
        assert!(db.upsert_envelopes(account_id, inbox, &batch).is_err());

        assert_eq!(db.cached_message_count(inbox).unwrap(), 0);
    }

    #[test]
    fn envelope_batch_keeps_fts_in_step() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let batch = (1..=40)
            .map(|uid| envelope_only(uid, "2026-08-18T12:00:00+00:00"))
            .collect::<Vec<_>>();
        db.upsert_envelopes(account_id, inbox, &batch).unwrap();
        db.upsert_envelopes(account_id, inbox, &batch).unwrap();

        let (fts_rows, message_rows): (i64, i64) = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM message_fts), (SELECT COUNT(*) FROM messages)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(message_rows, 40);
        assert_eq!(fts_rows, message_rows);
    }
    #[test]
    fn folder_assignments_are_owned_and_missing_targets_fail_closed() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let id = db
            .upsert_mailbox(
                &account.summary.id,
                "CustomSent",
                &MailboxRole::Other,
                Some(1),
                Some(1),
                Some(0),
                0,
            )
            .unwrap();
        assert!(db
            .set_folder_assignment("foreign", "sent", Some(id))
            .is_err());
        db.set_folder_assignment(&account.summary.id, "sent", Some(id))
            .unwrap();
        assert_eq!(
            db.mailbox_for_role(&account.summary.id, "sent")
                .unwrap()
                .unwrap()
                .0,
            id
        );
        db.rename_mailbox_local(&account.summary.id, "CustomSent", "RenamedSent")
            .unwrap();
        assert_eq!(
            db.mailbox_for_role(&account.summary.id, "sent")
                .unwrap()
                .unwrap()
                .1,
            "RenamedSent"
        );
        db.conn()
            .unwrap()
            .execute("DELETE FROM mailboxes WHERE id=?1", [id])
            .unwrap();
        assert!(db.mailbox_for_role(&account.summary.id, "sent").is_err());
        db.set_folder_assignment(&account.summary.id, "sent", None)
            .unwrap();
        assert!(db
            .mailbox_for_role(&account.summary.id, "sent")
            .unwrap()
            .is_none());
    }

    #[test]
    fn bridge_provider_round_trips_and_defaults_have_no_trust() {
        let db = Database::memory();
        let mut account = account();
        account.summary.provider = ProviderKind::ProtonBridge;
        db.insert_account(&account).unwrap();
        let loaded = db.account(&account.summary.id).unwrap();
        assert_eq!(loaded.summary.provider, ProviderKind::ProtonBridge);
        assert!(loaded.imap.trusted_certificate.is_none());
        assert!(db
            .folder_assignments(&account.summary.id)
            .unwrap()
            .iter()
            .all(|assignment| assignment.mailbox_id.is_none()));
    }

    #[test]
    fn identity_reset_preserves_drafts_and_clears_remote_tracking() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let local = draft(&account.summary.id);
        let id = db.save_draft(&local).unwrap();
        db.conn().unwrap().execute("UPDATE drafts SET remote_mailbox='Old',remote_uid=7,remote_uid_validity=1 WHERE id=?1", [&id]).unwrap();
        db.reset_remote_identity(&account.summary.id).unwrap();
        let tracked = db
            .pending_draft_sync(&account.summary.id)
            .unwrap()
            .into_iter()
            .find(|record| record.id == id)
            .unwrap();
        assert!(tracked.remote_uid.is_none());
        assert!(tracked.remote_mailbox.is_none());
    }
    // Failure inventory: reset/eviction must not recycle IDs retained by an
    // open composer; both insert paths preserve existing IDs and legacy maxima.
    #[test]
    fn stale_composer_source_ids_never_resolve_after_identity_reset() {
        for envelope_only in [false, true] {
            let db = Database::memory();
            let account = account();
            db.insert_account(&account).unwrap();
            let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
            let old = message(1, "2026-08-18T12:00:00Z");
            if envelope_only {
                db.upsert_envelope(&account.summary.id, inbox, &old)
                    .unwrap();
            } else {
                db.upsert_message(&account.summary.id, inbox, &old).unwrap();
            }
            let old_id = db
                .conn()
                .unwrap()
                .query_row(
                    "SELECT id FROM messages WHERE mailbox_id=?1",
                    [inbox],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap();
            db.reset_remote_identity(&account.summary.id).unwrap();
            let replacement = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
            let new = message(1, "2026-08-19T12:00:00Z");
            if envelope_only {
                db.upsert_envelope(&account.summary.id, replacement, &new)
                    .unwrap();
            } else {
                db.upsert_message(&account.summary.id, replacement, &new)
                    .unwrap();
            }
            let new_id = db
                .conn()
                .unwrap()
                .query_row(
                    "SELECT id FROM messages WHERE mailbox_id=?1",
                    [replacement],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap();
            assert!(new_id > old_id, "stale composer ID must remain unavailable");
            db.mark_replied(old_id, &account.summary.id, true, true)
                .unwrap();
            let detail = db.message_detail(new_id, &account.summary.id).unwrap();
            assert!(!detail.summary.is_answered && !detail.summary.is_forwarded);
            assert!(db.message_detail(old_id, &account.summary.id).is_err());
        }
    }

    #[test]
    fn message_id_sequence_migration_preserves_legacy_high_water() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        {
            let mut conn = db.conn().unwrap();
            conn.execute("UPDATE messages SET id=500", []).unwrap();
            conn.execute_batch("DROP TABLE IF EXISTS message_id_sequence; PRAGMA user_version=21;")
                .unwrap();
            migrate_schema(&mut conn).unwrap();
            conn.execute("DELETE FROM messages", []).unwrap();
        }
        db.upsert_envelope(
            &account.summary.id,
            inbox,
            &message(2, "2026-08-19T12:00:00Z"),
        )
        .unwrap();
        let id = db
            .conn()
            .unwrap()
            .query_row("SELECT id FROM messages", [], |row| row.get::<_, i64>(0))
            .unwrap();
        assert!(id > 500);
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(2, "2026-08-19T12:00:00Z"),
        )
        .unwrap();
        assert_eq!(
            db.conn()
                .unwrap()
                .query_row("SELECT id FROM messages", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            id
        );
    }

    #[test]
    fn vanished_assigned_folder_is_missing_even_when_operations_keep_cache() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let target = mailbox(&db, &account.summary.id, "CustomSent", &MailboxRole::Other);
        db.set_folder_assignment(&account.summary.id, "sent", Some(target))
            .unwrap();
        db.queue_operation(
            &account.summary.id,
            "flags",
            &serde_json::json!({"mailbox":"CustomSent","uid":1}),
            Some("guarded-folder"),
        )
        .unwrap();
        db.reconcile_mailboxes(&account.summary.id, &std::collections::HashSet::new())
            .unwrap();
        assert!(
            db.mailbox(target).is_ok(),
            "pending operations keep cached folder"
        );
        assert!(
            db.folder_assignments(&account.summary.id)
                .unwrap()
                .into_iter()
                .find(|item| item.role == "sent")
                .unwrap()
                .missing
        );
        assert!(db.mailbox_for_role(&account.summary.id, "sent").is_err());
        db.upsert_mailbox(
            &account.summary.id,
            "CustomSent",
            &MailboxRole::Other,
            Some(1),
            Some(1),
            Some(0),
            0,
        )
        .unwrap();
        assert!(db
            .mailbox_for_role(&account.summary.id, "sent")
            .unwrap()
            .is_some());
    }
    // Failure inventory: selected folder IDs survive in UI and queued IPC
    // after identity reset/account removal; new folders must never reuse them.
    #[test]
    fn stale_mailbox_ids_never_resolve_after_identity_reset() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let old = mailbox(&db, &account.summary.id, "OldPersonal", &MailboxRole::Other);
        db.reset_remote_identity(&account.summary.id).unwrap();
        let replacement = mailbox(
            &db,
            &account.summary.id,
            "DifferentPersonal",
            &MailboxRole::Other,
        );
        assert!(replacement > old);
        assert!(db.mailbox(old).is_err());
        assert_eq!(
            mailbox(
                &db,
                &account.summary.id,
                "DifferentPersonal",
                &MailboxRole::Other
            ),
            replacement
        );
        db.rename_mailbox_local(&account.summary.id, "DifferentPersonal", "RenamedPersonal")
            .unwrap();
        assert_eq!(db.mailbox(replacement).unwrap().1, "RenamedPersonal");
    }

    #[test]
    fn mailbox_ids_never_reuse_removed_account_folders() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let old = mailbox(&db, &account.summary.id, "OldPersonal", &MailboxRole::Other);
        db.remove_account(&account.summary.id).unwrap();
        db.insert_account(&account).unwrap();
        let replacement = mailbox(&db, &account.summary.id, "NewPersonal", &MailboxRole::Other);
        assert!(replacement > old);
        assert!(db.mailbox(old).is_err());
    }

    #[test]
    fn mailbox_id_sequence_migration_preserves_assigned_tombstone_high_water() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        {
            let mut conn = db.conn().unwrap();
            conn.execute("UPDATE mailboxes SET id=500", []).unwrap();
            conn.execute(
                "INSERT INTO folder_assignments(account_id,role,mailbox_id) VALUES(?1,'sent',900)",
                [&account.summary.id],
            )
            .unwrap();
            conn.execute_batch("DROP TABLE IF EXISTS mailbox_id_sequence; PRAGMA user_version=21;")
                .unwrap();
            migrate_schema(&mut conn).unwrap();
        }
        db.remove_account(&account.summary.id).unwrap();
        db.insert_account(&account).unwrap();
        let new = mailbox(&db, &account.summary.id, "NewPersonal", &MailboxRole::Other);
        assert!(new > 900);
    }

    #[test]
    fn remote_flags_reconcile_active_pending_destination_overlay() {
        let db = Database::memory();
        let account = account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                account_id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(5),
                10,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                account_id,
                "Archive",
                &MailboxRole::Archive,
                Some(1),
                Some(2),
                Some(1),
                3,
            )
            .unwrap();
        db.upsert_message(account_id, inbox, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap();
        let id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.mark_pending_move(id, archive).unwrap();

        // Source STATUS succeeds while destination STATUS does not.
        db.update_mailbox_status(inbox, Some(1), Some(2), Some(4), 10)
            .unwrap();
        db.reconcile_flags(inbox, &[(1, true, false)], &[1])
            .unwrap();
        db.clear_pending_move(id).unwrap();

        assert_eq!(mailbox_counts(&db, account_id, archive), (3, 1));
    }

    // Failure modes for erasing local mail:
    // 1. Cleared bodies stay readable in free pages of the database file.
    // 2. Cleared bodies stay readable in the WAL file.
    // 3. Removing an account leaves its mail recoverable on disk.
    // 4. Compacting loses envelopes that should survive a body clear.
    #[test]
    fn cleared_and_removed_mail_is_not_left_on_disk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("postal-snap.sqlite3");
        let marker = "zq-private-body-marker";
        let on_disk = |needle: &str| {
            ["postal-snap.sqlite3", "postal-snap.sqlite3-wal"]
                .iter()
                .filter_map(|name| std::fs::read(directory.path().join(name)).ok())
                .any(|bytes| {
                    bytes
                        .windows(needle.len())
                        .any(|window| window == needle.as_bytes())
                })
        };
        let db = Database::open(&path).unwrap();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        let mut cached = message(1, "2026-08-18T12:00:00Z");
        cached.text_body = marker.repeat(400);
        cached.raw_message = marker.repeat(400).into_bytes();
        db.upsert_message(&account.summary.id, inbox, &cached)
            .unwrap();
        assert!(on_disk(marker));

        db.clear_downloaded_mail().unwrap();
        db.compact().unwrap();
        assert!(!on_disk(marker));
        assert_eq!(db.list_messages(inbox, None, 10).unwrap().items.len(), 1);

        db.remove_account(&account.summary.id).unwrap();
        db.compact().unwrap();
        assert!(!on_disk("Family picnic"));
    }

    // Failure modes for the parse quarantine:
    // 1. One quit or update restart mid-parse quarantines a good message.
    // 2. A parser that crashes the app every time is parsed on every launch.
    // 3. A caught parser panic is retried like an ordinary failure.
    // 4. A finished parse leaves an unfinished count behind.
    // 5. Opening a quarantined message parses it again.
    #[test]
    fn interrupted_parse_quarantines_only_repeat_crashes() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        for uid in [1, 2, 3] {
            let mut envelope = message(uid, "2026-08-18T12:00:00Z");
            envelope.raw_message.clear();
            envelope.text_body.clear();
            db.upsert_message(&account.summary.id, inbox, &envelope)
                .unwrap();
        }
        let policy = CachePolicy::default();
        let candidates = |db: &Database| {
            let mut uids = db
                .prefetch_candidates(inbox, &policy, 10, u64::MAX, u64::MAX)
                .unwrap()
                .into_iter()
                .map(|(uid, _)| uid)
                .collect::<Vec<_>>();
            uids.sort_unstable();
            uids
        };
        let quarantined = |uid: u32| {
            let item = db
                .list_messages(inbox, None, 10)
                .unwrap()
                .items
                .into_iter()
                .find(|item| item.uid == uid)
                .unwrap();
            db.parse_quarantined(item.id, &account.summary.id).unwrap()
        };
        // Message 1: one unfinished parse (a quit) is forgiven.
        db.begin_parse(inbox, 1).unwrap();
        assert!(!quarantined(1));
        assert_eq!(candidates(&db), vec![1, 2, 3]);
        // A second unfinished parse in a row looks like a crash.
        db.begin_parse(inbox, 1).unwrap();
        assert!(quarantined(1));
        // Message 2: a finished parse resets the count.
        db.begin_parse(inbox, 2).unwrap();
        db.end_parse(inbox, 2).unwrap();
        db.begin_parse(inbox, 2).unwrap();
        assert!(!quarantined(2));
        // Message 3: a caught panic quarantines at once.
        db.quarantine_parse(inbox, 3).unwrap();
        assert!(quarantined(3));
        assert_eq!(candidates(&db), vec![2]);
    }

    fn never_returns() -> impl std::future::Future<Output = Result<(), MailError>> {
        std::future::pending()
    }

    /// True when the attempt was cut off before the parser returned.
    async fn cancelled_attempt(db: &Database, mailbox_id: i64, uid: u32) -> bool {
        let attempt = crate::mail::sync::guard_parse(db, mailbox_id, uid, never_returns());
        tokio::time::timeout(std::time::Duration::from_millis(20), attempt)
            .await
            .is_err()
    }

    // Failure modes for the guarded parse shared by full and partial bodies:
    // 1. An attempt cancelled mid-parse is not counted, so it repeats forever.
    // 2. One unfinished attempt quarantines a good message (a quit is forgiven).
    // 3. A caught panic waits for a second attempt.
    // 4. A finished attempt leaves a count behind.
    #[tokio::test]
    async fn guarded_parse_counts_attempts_on_every_path() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        for uid in [1, 2, 3] {
            db.upsert_envelope(
                &account.summary.id,
                inbox,
                &message(uid, "2026-08-18T12:00:00Z"),
            )
            .unwrap();
        }
        let quarantined = |uid: u32| {
            let id = db
                .list_messages(inbox, None, 10)
                .unwrap()
                .items
                .into_iter()
                .find(|item| item.uid == uid)
                .unwrap()
                .id;
            db.parse_quarantined(id, &account.summary.id).unwrap()
        };
        assert!(cancelled_attempt(&db, inbox, 1).await);
        assert!(!quarantined(1));
        assert!(cancelled_attempt(&db, inbox, 1).await);
        assert!(quarantined(1));

        let panicked = crate::mail::sync::guard_parse(&db, inbox, 2, async {
            Err::<(), _>(crate::mail::failure::MailError::new(
                crate::mail::failure::FailureKind::Unreadable,
                "panic",
            ))
        })
        .await;
        assert!(panicked.is_err());
        assert!(quarantined(2));

        assert!(cancelled_attempt(&db, inbox, 3).await);
        crate::mail::sync::guard_parse(&db, inbox, 3, async { Ok::<_, MailError>(()) })
            .await
            .unwrap();
        assert!(cancelled_attempt(&db, inbox, 3).await);
        assert!(!quarantined(3));
    }

    // Failure modes for partial bodies:
    // 1. The flag survives a full download, or a full row is marked partial.
    // 2. A partial row with an empty text body is re-selected for prefetch forever.
    // 3. Clearing downloads leaves the flag set, so the message never refetches.
    #[test]
    fn partial_body_flag_follows_the_stored_body() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let account_id = account.summary.id.clone();
        let inbox = mailbox(&db, &account_id, "INBOX", &MailboxRole::Inbox);
        db.upsert_envelope(&account_id, inbox, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap();
        let id = db
            .list_messages(inbox, None, 10)
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.uid == 1)
            .unwrap()
            .id;
        let policy = CachePolicy::default();
        let is_candidate = |db: &Database| {
            db.prefetch_candidates(inbox, &policy, 10, u64::MAX, u64::MAX)
                .unwrap()
                .iter()
                .any(|(uid, _)| *uid == 1)
        };

        let mut partial = message(1, "2026-08-18T12:00:00Z");
        partial.raw_message.clear();
        partial.text_body.clear();
        partial.html_body = None;
        assert!(db
            .attach_partial_body_if_current(inbox, 1, &partial)
            .unwrap());
        let state = db.body_state(id, &account_id).unwrap();
        assert!(!state.has_raw && state.body_partial);
        assert!(db.message_detail(id, &account_id).unwrap().body_partial);
        assert!(!is_candidate(&db));

        assert!(db
            .attach_body_if_current(inbox, 1, &message(1, "2026-08-18T12:00:00Z"))
            .unwrap());
        let state = db.body_state(id, &account_id).unwrap();
        assert!(state.has_raw && !state.body_partial);

        assert!(db
            .attach_partial_body_if_current(inbox, 1, &partial)
            .unwrap());
        db.clear_account_downloads(&account_id).unwrap();
        let state = db.body_state(id, &account_id).unwrap();
        assert!(!state.has_raw && !state.body_partial);
        assert!(!db.message_detail(id, &account_id).unwrap().body_partial);
        assert!(is_candidate(&db));
    }

    // Failure modes: partial-only usage is zero globally; mixed rows count
    // only raw MIME; message count excludes partial bodies; clear leaves stale
    // body totals; or queued MIME disappears from global storage usage.
    #[test]
    fn global_cache_usage_counts_partial_full_and_outbox_then_clear() {
        let db = Database::memory();
        let account = account();
        let account_id = account.summary.id.clone();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account_id, "INBOX", &MailboxRole::Inbox);

        let mut partial = message(1, "2026-08-18T12:00:00Z");
        partial.raw_message.clear();
        partial.text_body = "partial cached text".into();
        partial.html_body = Some("<p>partial cached html</p>".into());
        partial.attachments = vec![];
        let mut envelope = message(1, "2026-08-18T12:00:00Z");
        envelope.raw_message.clear();
        envelope.text_body.clear();
        envelope.html_body = None;
        envelope.attachments.clear();
        db.upsert_envelope(&account_id, inbox, &envelope).unwrap();
        assert!(db
            .attach_partial_body_if_current(inbox, 1, &partial)
            .unwrap());

        let partial_account = db.account_cache_usage(&account_id, 1024).unwrap();
        let partial_global = db.cache_usage(1024).unwrap();
        assert!(partial_account.bytes > 0);
        assert_eq!(partial_global.bytes, partial_account.bytes);
        assert_eq!(partial_global.message_count, 1);

        db.upsert_message(&account_id, inbox, &message(2, "2026-08-19T12:00:00Z"))
            .unwrap();
        let mixed_account = db.account_cache_usage(&account_id, 1024).unwrap();
        let mixed_global = db.cache_usage(1024).unwrap();
        assert_eq!(mixed_global.bytes, mixed_account.bytes);
        assert!(mixed_global.bytes > partial_global.bytes);
        assert_eq!(mixed_global.message_count, 2);

        let outbox_mime = b"synthetic queued MIME";
        db.queue_outbox(
            &draft(&account_id),
            "queued",
            None,
            "<synthetic@example.invalid>",
            outbox_mime,
            None,
        )
        .unwrap();
        let queued_global = db.cache_usage(1024).unwrap();
        assert_eq!(
            queued_global.bytes,
            mixed_account.bytes + outbox_mime.len() as u64
        );
        assert_eq!(queued_global.message_count, 2);

        db.clear_downloaded_mail().unwrap();
        let cleared_account = db.account_cache_usage(&account_id, 1024).unwrap();
        let cleared_global = db.cache_usage(1024).unwrap();
        assert_eq!(cleared_account.bytes, 0);
        assert_eq!(cleared_account.message_count, 0);
        assert_eq!(cleared_global.bytes, outbox_mime.len() as u64);
        assert_eq!(cleared_global.message_count, 0);
    }

    #[test]
    fn current_schema_upgrades_v37_database_preserving_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        let account = account();
        {
            let db = Database::open(&path).unwrap();
            db.insert_account(&account).unwrap();
            let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
            db.upsert_message(
                &account.summary.id,
                inbox,
                &message(1, "2026-08-18T12:00:00Z"),
            )
            .unwrap();
        }
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "ALTER TABLE messages DROP COLUMN body_partial;
                     PRAGMA user_version=37;",
                )
                .unwrap();
        }
        let migrated = Database::open(&path).unwrap();
        let conn = migrated.conn().unwrap();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        let (count, partial): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),MIN(body_partial) FROM messages",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((count, partial), (1, 0));
    }

    // Failure modes for v39 rich-signature storage:
    // 1. A saved legacy plain signature is lost during migration.
    // 2. The new HTML field is nullable or has no empty default.
    // 3. The sender lookup index is missing or uses case-sensitive matching.
    #[test]
    fn migration_39_preserves_plain_signatures_and_indexes_sender_addresses() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mail.sqlite3");
        let mut legacy = account();
        legacy.summary.signature = "Best,\nSam".into();
        {
            let db = Database::open(&path).unwrap();
            db.insert_account(&legacy).unwrap();
        }
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "ALTER TABLE accounts DROP COLUMN signature_html;
                     DROP INDEX IF EXISTS messages_account_sender_address;
                     PRAGMA user_version=38;",
                )
                .unwrap();
        }

        let migrated = Database::open(&path).unwrap();
        let stored = migrated.account(&legacy.summary.id).unwrap().summary;
        assert_eq!(stored.signature, "Best,\nSam");
        assert_eq!(stored.signature_html, "");
        let connection = migrated.conn().unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::db::CURRENT_SCHEMA_VERSION);
        let index: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name='messages_account_sender_address'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(index.contains("account_id"));
        assert!(index.contains("sender_address COLLATE NOCASE"));
    }

    // Failure modes for a database the app cannot open:
    // 1. A newer schema is reported as generic damage, not as a newer version.
    // 2. Opening it rewrites or migrates the newer file.
    // 3. The stand-in cannot list accounts, so the window cannot load.
    #[test]
    fn newer_database_is_reported_and_left_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("postal-snap.sqlite3");
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(Database::open(&path).err().as_deref(), Some(NEWER_DATABASE));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(Database::unavailable()
            .unwrap()
            .list_accounts()
            .unwrap()
            .is_empty());
    }

    // Failure modes for an interrupted new-mail catch-up:
    // 1. The next pass sees the stored UIDNEXT, calls the folder unchanged,
    //    and never fetches the rest of the gap.
    // 2. Forgetting UIDNEXT also loses validity or counts.
    #[test]
    fn interrupted_catch_up_is_not_seen_as_unchanged() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(11),
                Some(100),
                Some(3),
                7,
            )
            .unwrap();
        db.forget_uid_next(inbox).unwrap();
        assert_eq!(
            db.mailbox_sync_state(&account.summary.id, "INBOX").unwrap(),
            Some((Some(11), None, 7, Some(3)))
        );
    }

    // Failure modes for "try later" retries:
    // 1. A deferred row is retried on the very next sync pass.
    // 2. Retries never stop for a server that always says "try later".
    // 3. A user retry from needs_attention starts with a spent budget.
    // 4. Another account's rows are touched.
    #[test]
    fn try_later_replies_back_off_and_stop() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let account_id = &account.summary.id;
        let id = db
            .queue_outbox(&draft(account_id), "queued", None, "", b"", None)
            .unwrap();
        assert_eq!(
            db.due_queued_outbox_ids(account_id).unwrap(),
            vec![id.clone()]
        );
        assert!(db.defer_outbox_retry(&id, account_id, 3).unwrap());
        assert!(db.due_queued_outbox_ids(account_id).unwrap().is_empty());
        assert!(db
            .due_queued_outbox_ids("other-account")
            .unwrap()
            .is_empty());
        assert!(db.defer_outbox_retry(&id, account_id, 3).unwrap());
        assert!(!db.defer_outbox_retry(&id, account_id, 3).unwrap());
        db.set_outbox_state(&id, account_id, "needs_attention", None)
            .unwrap();
        assert!(db
            .claim_outbox_delivery(&id, account_id, "needs_attention")
            .unwrap());
        db.set_outbox_state(&id, account_id, "queued", None)
            .unwrap();
        assert_eq!(
            db.due_queued_outbox_ids(account_id).unwrap(),
            vec![id.clone()]
        );
        assert!(db.defer_outbox_retry(&id, account_id, 3).unwrap());
    }

    // Failure modes for the read-only connection:
    // 1. A list or detail read waits behind a held writer lock.
    // 2. A read does not see a write that already committed.
    // 3. The reader can write, bypassing the writer's rules.
    // 4. A panic while the writer is locked breaks the database for good.
    #[test]
    fn reads_do_not_wait_for_the_writer_and_see_commits() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(&directory.path().join("postal-snap.sqlite3")).unwrap();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();

        let writer = db.conn().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = db.clone();
        std::thread::spawn(move || {
            let accounts = reader.list_accounts().unwrap().len();
            let messages = reader
                .list_messages_filtered(
                    inbox,
                    None,
                    10,
                    crate::models::MessageListFilter::All,
                    crate::models::MessageListSort::Date,
                )
                .map(|page| page.items.len());
            sender.send((accounts, messages.is_ok())).unwrap();
        });
        // The account list must arrive while the writer is still held.
        let first = receiver.recv_timeout(Duration::from_secs(2));
        drop(writer);
        assert!(first.is_ok(), "reader waited for the writer");
        assert_eq!(first.unwrap().0, 1);

        assert!(db
            .read_conn()
            .unwrap()
            .execute("DELETE FROM accounts", [])
            .is_err());

        let panicking = db.clone();
        let _ = std::thread::spawn(move || {
            let _guard = panicking.conn().unwrap();
            panic!("simulated panic while locked");
        })
        .join();
        assert_eq!(db.list_accounts().unwrap().len(), 1);
        db.set_account_state(&account.summary.id, "idle", None)
            .unwrap();
    }

    // Failure modes for compacting while the reader is busy:
    // 1. A read in progress keeps the WAL from truncating, leaving old
    //    pages (and removed mail) in the WAL file.
    // 2. Compacting deadlocks with a read that is waiting on the writer.
    #[test]
    fn compact_waits_for_reads_and_empties_the_wal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("postal-snap.sqlite3");
        let db = Database::open(&path).unwrap();
        let account = account();
        db.insert_account(&account).unwrap();
        let held = db.read_conn().unwrap();
        let compacting = db.clone();
        let done = std::thread::spawn(move || compacting.compact());
        std::thread::sleep(Duration::from_millis(100));
        assert!(!done.is_finished(), "compact ran under an open read");
        drop(held);
        done.join().unwrap().unwrap();
        let wal = std::fs::metadata(directory.path().join("postal-snap.sqlite3-wal"))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        assert_eq!(wal, 0);
        assert_eq!(db.list_accounts().unwrap().len(), 1);
    }

    // Failure modes for recording when a message was opened:
    // 1. Opening a message while sync holds the writer waits behind it.
    // 2. That open is never recorded, so eviction drops the body early.
    #[test]
    fn opening_during_a_sync_write_still_records_recency() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(&directory.path().join("postal-snap.sqlite3")).unwrap();
        let account = account();
        db.insert_account(&account).unwrap();
        let inbox = mailbox(&db, &account.summary.id, "INBOX", &MailboxRole::Inbox);
        db.upsert_message(
            &account.summary.id,
            inbox,
            &message(1, "2026-08-18T12:00:00Z"),
        )
        .unwrap();
        let id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.conn()
            .unwrap()
            .execute("UPDATE messages SET accessed_at='2000-01-01 00:00:00'", [])
            .unwrap();
        let writer = db.conn().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = db.clone();
        let account_id = account.summary.id.clone();
        std::thread::spawn(move || {
            sender
                .send(reader.message_detail(id, &account_id).is_ok())
                .unwrap();
        });
        assert_eq!(receiver.recv_timeout(Duration::from_secs(2)), Ok(true));
        drop(writer);
        let recorded = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            let at: String = db
                .read_conn()
                .unwrap()
                .query_row(
                    "SELECT accessed_at FROM messages WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            at.as_str() > "2000-01-01 00:00:00"
        });
        assert!(recorded, "the open was never recorded");
    }
}
