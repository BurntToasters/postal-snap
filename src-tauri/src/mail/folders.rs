use futures_util::TryStreamExt;

use super::{ImapSession, IMAP_COMMAND_TIMEOUT, MAX_MESSAGE_BYTES};
use crate::{models::AccountRecord, security::redact_error};

const MAX_REPLAY_MATCH_CANDIDATES: usize = 64;
const MAX_REPLAY_COMPARE_BYTES: usize = MAX_MESSAGE_BYTES * 2;
const MAX_REPLAY_VERIFY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// A failed mailbox operation that keeps the terminal/transient distinction
/// the redacted error string cannot carry. Terminal failures must not be
/// replayed forever from the offline queue.
#[derive(Debug, Clone)]
pub struct MailboxOperationError {
    pub terminal: bool,
    pub message: String,
}

impl MailboxOperationError {
    pub(crate) fn transient(message: String) -> Self {
        Self {
            terminal: false,
            message,
        }
    }

    pub(crate) fn terminal(message: String) -> Self {
        Self {
            terminal: true,
            message,
        }
    }
}

impl std::fmt::Display for MailboxOperationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<MailboxOperationError> for String {
    fn from(error: MailboxOperationError) -> Self {
        error.message
    }
}

/// A server `NO`/`BAD` response means the command itself was refused; retrying
/// the identical UID operation cannot succeed. Connection and parse failures
/// stay transient.
fn classify_imap_failure(error: &async_imap::error::Error) -> bool {
    match error {
        async_imap::error::Error::No(message) | async_imap::error::Error::Bad(message) => {
            let lower = message.to_ascii_lowercase();
            lower.contains("not found")
                || lower.contains("no such")
                || lower.contains("does not exist")
                || lower.contains("nonexistent")
                || lower.contains("unknown mailbox")
                || lower.contains("already")
                || lower.contains("expung")
                || lower.contains("missing")
                || lower.contains("invalid")
        }
        async_imap::error::Error::Validate(_) => true,
        _ => false,
    }
}

fn remote_failure(error: async_imap::error::Error, action: &str) -> MailboxOperationError {
    let message = redact_error(&error, action);
    if classify_imap_failure(&error) {
        MailboxOperationError::terminal(message)
    } else {
        MailboxOperationError::transient(message)
    }
}

/// Replied/forwarded keyword set on the source message after a sent reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKeyword {
    Answered,
    Forwarded,
}

impl SourceKeyword {
    fn atom(self) -> &'static str {
        match self {
            Self::Answered => "\\Answered",
            Self::Forwarded => "$Forwarded",
        }
    }
}

/// `$Forwarded` is a custom keyword: only set it when the mailbox lets
/// clients create keywords (`\*`) or already lists it.
pub fn forwarded_permitted(permanent: &[async_imap::types::Flag<'_>]) -> bool {
    permanent.iter().any(|flag| match flag {
        async_imap::types::Flag::MayCreate => true,
        async_imap::types::Flag::Custom(name) => name.eq_ignore_ascii_case("$Forwarded"),
        _ => false,
    })
}

/// Set one keyword on one message. `$Forwarded` on a server that forbids it
/// is skipped without error.
pub async fn set_remote_keyword(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    expected_uid_validity: Option<u32>,
    keyword: SourceKeyword,
) -> Result<(), MailboxOperationError> {
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        MailboxOperationError::transient(
            "Mailbox identity is unavailable; refresh mail and try again.".to_string(),
        )
    })?;
    let mut session = super::pool::checkout(account, password)
        .await
        .map_err(|error| MailboxOperationError::transient(error.into()))?;
    let wire_mailbox = session.mailbox_name(mailbox);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_mailbox))
        .await
        .map_err(|_| MailboxOperationError::transient("Message update timed out.".to_string()))?
        .map_err(|error| remote_failure(error, "Message update"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err(MailboxOperationError::terminal(
            "This mailbox changed; refresh mail and try again.".to_string(),
        ));
    }
    if keyword == SourceKeyword::Forwarded && !forwarded_permitted(&selected.permanent_flags) {
        session.release();
        return Ok(());
    }
    let command = format!("+FLAGS.SILENT ({})", keyword.atom());
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_store(uid.to_string(), command)
            .await
            .map_err(|error| remote_failure(error, "Message update"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| remote_failure(error, "Message update"))
    })
    .await
    .map_err(|_| MailboxOperationError::transient("Message update timed out.".to_string()))??;
    session.release();
    Ok(())
}

pub async fn set_remote_flags(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    expected_uid_validity: Option<u32>,
    is_read: Option<bool>,
    is_starred: Option<bool>,
) -> Result<(), MailboxOperationError> {
    set_remote_uid_flags(
        account,
        password,
        mailbox,
        &[uid],
        expected_uid_validity,
        is_read,
        is_starred,
    )
    .await
}

pub async fn set_remote_uid_flags(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uids: &[u32],
    expected_uid_validity: Option<u32>,
    is_read: Option<bool>,
    is_starred: Option<bool>,
) -> Result<(), MailboxOperationError> {
    if uids.is_empty() {
        return Ok(());
    }
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        MailboxOperationError::transient(
            "Mailbox identity is unavailable; refresh mail and try again.".to_string(),
        )
    })?;
    let mut session = super::pool::checkout(account, password)
        .await
        .map_err(|error| MailboxOperationError::transient(error.into()))?;
    let wire_mailbox = session.mailbox_name(mailbox);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_mailbox))
        .await
        .map_err(|_| MailboxOperationError::transient("Message update timed out.".to_string()))?
        .map_err(|error| remote_failure(error, "Message update"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err(MailboxOperationError::terminal(
            "This mailbox changed; refresh mail and try again.".to_string(),
        ));
    }
    store_uid_flags_selected(&mut session, uids, is_read, is_starred, "Message update").await?;
    session.release();
    Ok(())
}

async fn store_uid_flags_selected(
    session: &mut ImapSession,
    uids: &[u32],
    is_read: Option<bool>,
    is_starred: Option<bool>,
    action: &str,
) -> Result<(), MailboxOperationError> {
    if uids.is_empty() {
        return Ok(());
    }
    let set = uids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    if let Some(value) = is_read {
        let operation = if value {
            "+FLAGS.SILENT (\\Seen)"
        } else {
            "-FLAGS.SILENT (\\Seen)"
        };
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            session
                .uid_store(set.clone(), operation)
                .await
                .map_err(|error| remote_failure(error, action))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| remote_failure(error, action))
        })
        .await
        .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))??;
    }
    if let Some(value) = is_starred {
        let operation = if value {
            "+FLAGS.SILENT (\\Flagged)"
        } else {
            "-FLAGS.SILENT (\\Flagged)"
        };
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            session
                .uid_store(set, operation)
                .await
                .map_err(|error| remote_failure(error, action))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| remote_failure(error, action))
        })
        .await
        .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))??;
    }
    Ok(())
}

#[derive(Clone, Copy, Default)]
pub struct MoveReplayFlags {
    pub is_read: Option<bool>,
    pub is_starred: Option<bool>,
}

#[derive(Clone, Copy, Default)]
pub struct MoveOptions<'a> {
    pub message_id: Option<&'a str>,
    /// Set when replaying an offline move so an already-applied server move is
    /// recognized instead of copied twice.
    pub dedupe_existing: bool,
    /// Latest queued source flags, copied to an existing destination before
    /// the replay removes its source.
    pub replay_flags: Option<MoveReplayFlags>,
}

pub async fn move_remote(
    account: &AccountRecord,
    password: &str,
    source: &str,
    destination: &str,
    uid: u32,
    expected_uid_validity: Option<u32>,
    options: MoveOptions<'_>,
) -> Result<(), MailboxOperationError> {
    move_remote_inner(
        account,
        password,
        source,
        destination,
        &[uid],
        expected_uid_validity,
        options,
    )
    .await
}

#[derive(Default)]
pub struct CopyOptions<'a> {
    pub message_id: Option<&'a str>,
    /// Set on replay so a copy that already landed is not stored twice.
    pub dedupe_existing: bool,
}

/// Copy one message. The source stays.
pub async fn copy_remote(
    account: &AccountRecord,
    password: &str,
    source: &str,
    destination: &str,
    uid: u32,
    expected_uid_validity: Option<u32>,
    options: CopyOptions<'_>,
) -> Result<(), MailboxOperationError> {
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        MailboxOperationError::transient(
            "Mailbox identity is unavailable; refresh mail and try again.".to_string(),
        )
    })?;
    let mut session = super::pool::checkout(account, password)
        .await
        .map_err(|error| MailboxOperationError::transient(error.into()))?;
    let wire_source = session.mailbox_name(source);
    let wire_destination = session.mailbox_name(destination);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_source))
        .await
        .map_err(|_| MailboxOperationError::transient("Copy timed out.".to_string()))?
        .map_err(|error| remote_failure(error, "Copy"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err(MailboxOperationError::terminal(
            "This mailbox changed; refresh mail and try again.".to_string(),
        ));
    }
    if options.dedupe_existing {
        if let Some(search) = options.message_id.and_then(header_message_id_search) {
            match matching_destination_content(
                &mut session,
                &wire_source,
                &wire_destination,
                uid,
                expected_uid_validity,
                &search,
                "Copy",
            )
            .await?
            {
                ReplayContentMatch::ExistingCopy { .. } => {
                    session.release();
                    return Ok(());
                }
                ReplayContentMatch::SourceMissing => {
                    return Err(MailboxOperationError::terminal(
                        "This message is no longer available on the server.".to_string(),
                    ));
                }
                ReplayContentMatch::NoMatch => {}
            }
        }
    }
    tokio::time::timeout(
        IMAP_COMMAND_TIMEOUT,
        session.uid_copy(uid.to_string(), &wire_destination),
    )
    .await
    .map_err(|_| MailboxOperationError::transient("Copy timed out.".to_string()))?
    .map_err(|error| remote_failure(error, "Copy"))?;
    session.release();
    Ok(())
}

/// Copy several messages in one IMAP command. The source messages stay.
pub async fn copy_remote_uids(
    account: &AccountRecord,
    password: &str,
    source: &str,
    destination: &str,
    uids: &[u32],
    expected_uid_validity: Option<u32>,
) -> Result<(), MailboxOperationError> {
    if uids.is_empty() {
        return Ok(());
    }
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        MailboxOperationError::transient(
            "Mailbox identity is unavailable; refresh mail and try again.".to_string(),
        )
    })?;
    let mut session = super::pool::checkout(account, password)
        .await
        .map_err(|error| MailboxOperationError::transient(error.into()))?;
    let wire_source = session.mailbox_name(source);
    let wire_destination = session.mailbox_name(destination);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_source))
        .await
        .map_err(|_| MailboxOperationError::transient("Copy timed out.".to_string()))?
        .map_err(|error| remote_failure(error, "Copy"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err(MailboxOperationError::terminal(
            "This mailbox changed; refresh mail and try again.".to_string(),
        ));
    }
    let set = uids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    tokio::time::timeout(
        IMAP_COMMAND_TIMEOUT,
        session.uid_copy(set, &wire_destination),
    )
    .await
    .map_err(|_| MailboxOperationError::transient("Copy timed out.".to_string()))?
    .map_err(|error| remote_failure(error, "Copy"))?;
    session.release();
    Ok(())
}

pub async fn move_remote_uids(
    account: &AccountRecord,
    password: &str,
    source: &str,
    destination: &str,
    uids: &[u32],
    expected_uid_validity: Option<u32>,
) -> Result<(), MailboxOperationError> {
    move_remote_inner(
        account,
        password,
        source,
        destination,
        uids,
        expected_uid_validity,
        MoveOptions::default(),
    )
    .await
}

fn quote_imap_search(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The dedupe SEARCH for a Message-ID, or None when the id is unsafe to send.
/// None means no dedupe: the copy or move proceeds as a normal operation.
fn header_message_id_search(raw: &str) -> Option<String> {
    // Checked before trimming so a trailing CR or LF also disables the search.
    if raw.trim().is_empty() || !raw.is_ascii() || raw.chars().any(|c| c.is_ascii_control()) {
        return None;
    }
    Some(format!(
        "HEADER Message-ID \"{}\"",
        quote_imap_search(raw.trim())
    ))
}

async fn fetch_replay_body(
    session: &mut ImapSession,
    uid: u32,
    action: &str,
) -> Result<Option<Vec<u8>>, MailboxOperationError> {
    let query = super::sync::body_fetch_query("UID RFC822.SIZE");
    let timeout = super::sync::download_timeout(MAX_MESSAGE_BYTES as u64);
    let mut rows = tokio::time::timeout(timeout, async {
        session
            .uid_fetch(uid.to_string(), query)
            .await
            .map_err(|error| remote_failure(error, action))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| remote_failure(error, action))
    })
    .await
    .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))??;
    if rows.len() > 1 {
        return Err(MailboxOperationError::transient(format!(
            "Could not safely verify whether the {action} already completed."
        )));
    }
    let Some(item) = rows.pop() else {
        return Ok(None);
    };
    if item.uid != Some(uid) {
        return Err(MailboxOperationError::transient(format!(
            "The mail server returned a different message while verifying {action}."
        )));
    }
    let Some(body) = item.body() else {
        return Err(MailboxOperationError::transient(format!(
            "The mail server did not return the message needed to verify {action}."
        )));
    };
    let Some(size) = item.size else {
        return Err(MailboxOperationError::transient(format!(
            "The mail server did not return the message size needed to verify {action}."
        )));
    };
    if size as usize > MAX_MESSAGE_BYTES || body.len() > MAX_MESSAGE_BYTES {
        return Err(MailboxOperationError::transient(format!(
            "The message could not be bounded for safe {action} replay."
        )));
    }
    if body.len() != size as usize {
        return Err(MailboxOperationError::transient(format!(
            "The mail server returned incomplete content while verifying {action}."
        )));
    }
    Ok(Some(body.to_vec()))
}

async fn replay_uid_exists(
    session: &mut ImapSession,
    uid: u32,
    action: &str,
) -> Result<bool, MailboxOperationError> {
    let rows = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_fetch(uid.to_string(), "(UID)")
            .await
            .map_err(|error| remote_failure(error, action))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| remote_failure(error, action))
    })
    .await
    .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))??;
    Ok(rows.iter().any(|item| item.uid == Some(uid)))
}

async fn verify_replayed_flags(
    session: &mut ImapSession,
    uid: u32,
    is_read: Option<bool>,
    is_starred: Option<bool>,
    action: &str,
) -> Result<(), MailboxOperationError> {
    let mut rows = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_fetch(uid.to_string(), "(UID FLAGS)")
            .await
            .map_err(|error| remote_failure(error, action))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| remote_failure(error, action))
    })
    .await
    .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))??;
    if rows.len() != 1 {
        return Err(MailboxOperationError::transient(format!(
            "The copied message changed while verifying {action}; the source was kept."
        )));
    }
    let item = rows.pop().expect("one fetched row was checked");
    if item.uid != Some(uid) {
        return Err(MailboxOperationError::transient(format!(
            "The mail server returned a different message while verifying {action}."
        )));
    }
    let (seen, flagged) = item
        .flags()
        .fold((false, false), |(seen, flagged), flag| match flag {
            async_imap::types::Flag::Seen => (true, flagged),
            async_imap::types::Flag::Flagged => (seen, true),
            _ => (seen, flagged),
        });
    if is_read.is_some_and(|expected| expected != seen)
        || is_starred.is_some_and(|expected| expected != flagged)
    {
        return Err(MailboxOperationError::transient(format!(
            "The mail server did not save the copied message flags for {action}; the source was kept."
        )));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReplayContentMatch {
    SourceMissing,
    NoMatch,
    ExistingCopy { uid: u32, uid_validity: u32 },
}

/// Match full RFC822 content after a Message-ID search; the header alone is
/// not reliable identity. The selected mailbox is the source on return.
async fn matching_destination_content(
    session: &mut ImapSession,
    source: &str,
    destination: &str,
    source_uid: u32,
    expected_uid_validity: u32,
    search: &str,
    action: &str,
) -> Result<ReplayContentMatch, MailboxOperationError> {
    tokio::time::timeout(
        MAX_REPLAY_VERIFY_TIMEOUT,
        matching_destination_content_inner(
            session,
            source,
            destination,
            source_uid,
            expected_uid_validity,
            search,
            action,
        ),
    )
    .await
    .map_err(|_| {
        MailboxOperationError::transient(format!(
            "Could not safely verify whether the {action} already completed; the operation was kept."
        ))
    })?
}

async fn matching_destination_content_inner(
    session: &mut ImapSession,
    source: &str,
    destination: &str,
    source_uid: u32,
    expected_uid_validity: u32,
    search: &str,
    action: &str,
) -> Result<ReplayContentMatch, MailboxOperationError> {
    select_replay_source(session, source, expected_uid_validity, action).await?;
    if !replay_uid_exists(session, source_uid, action).await? {
        return Ok(ReplayContentMatch::SourceMissing);
    }

    let destination_selected =
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(destination))
            .await
            .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))?
            .map_err(|error| remote_failure(error, action))?;
    let Some(destination_validity) = destination_selected.uid_validity else {
        return Err(MailboxOperationError::transient(format!(
            "The destination mailbox identity is unavailable; the {action} was kept for safety."
        )));
    };
    let existing = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_search(search))
        .await
        .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))?
        .map_err(|error| remote_failure(error, action))?;
    if existing.is_empty() {
        select_replay_destination(session, destination, destination_validity, action).await?;
        select_replay_source(session, source, expected_uid_validity, action).await?;
        return Ok(ReplayContentMatch::NoMatch);
    }
    if existing.len() > MAX_REPLAY_MATCH_CANDIDATES {
        return Err(MailboxOperationError::transient(format!(
            "Too many matching messages to verify {action} safely; the operation was kept."
        )));
    }
    select_replay_source(session, source, expected_uid_validity, action).await?;
    let Some(source_body) = fetch_replay_body(session, source_uid, action).await? else {
        return Ok(ReplayContentMatch::SourceMissing);
    };
    let source_size = source_body.len();
    select_replay_destination(session, destination, destination_validity, action).await?;
    let mut compared_bytes = source_size;
    let mut identical = None;
    for uid in existing {
        if let Some(body) = fetch_replay_body(session, uid, action).await? {
            compared_bytes = compared_bytes.saturating_add(body.len());
            if compared_bytes > MAX_REPLAY_COMPARE_BYTES {
                return Err(MailboxOperationError::transient(format!(
                    "Too many matching messages to verify {action} safely; the operation was kept."
                )));
            }
            if body == source_body && identical.replace(uid).is_some() {
                return Err(MailboxOperationError::transient(format!(
                    "Matching copies are ambiguous; the {action} was kept for safety."
                )));
            }
        }
    }
    select_replay_destination(session, destination, destination_validity, action).await?;
    select_replay_source(session, source, expected_uid_validity, action).await?;
    Ok(match identical {
        Some(uid) => ReplayContentMatch::ExistingCopy {
            uid,
            uid_validity: destination_validity,
        },
        None => ReplayContentMatch::NoMatch,
    })
}

async fn select_replay_destination(
    session: &mut ImapSession,
    destination: &str,
    expected_uid_validity: u32,
    action: &str,
) -> Result<(), MailboxOperationError> {
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(destination))
        .await
        .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))?
        .map_err(|error| remote_failure(error, action))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err(MailboxOperationError::transient(format!(
            "The destination mailbox changed while verifying {action}; the operation was kept."
        )));
    }
    Ok(())
}

async fn select_replay_source(
    session: &mut ImapSession,
    source: &str,
    expected_uid_validity: u32,
    action: &str,
) -> Result<(), MailboxOperationError> {
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(source))
        .await
        .map_err(|_| MailboxOperationError::transient(format!("{action} timed out.")))?
        .map_err(|error| remote_failure(error, action))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err(MailboxOperationError::terminal(
            "This mailbox changed; refresh mail and try again.".to_string(),
        ));
    }
    Ok(())
}

async fn move_remote_inner(
    account: &AccountRecord,
    password: &str,
    source: &str,
    destination: &str,
    uids: &[u32],
    expected_uid_validity: Option<u32>,
    options: MoveOptions<'_>,
) -> Result<(), MailboxOperationError> {
    if uids.is_empty() {
        return Ok(());
    }
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        MailboxOperationError::transient(
            "Mailbox identity is unavailable; refresh mail and try again.".to_string(),
        )
    })?;
    let mut session = super::pool::checkout(account, password)
        .await
        .map_err(|error| MailboxOperationError::transient(error.into()))?;
    let wire_source = session.mailbox_name(source);
    let wire_destination = session.mailbox_name(destination);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_source))
        .await
        .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))?
        .map_err(|error| remote_failure(error, "Move"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err(MailboxOperationError::terminal(
            "This mailbox changed; refresh mail and try again.".to_string(),
        ));
    }
    // Checked once per connection by the pool; saves a round trip per move.
    let can_move = session.capabilities.mv;
    let has_uidplus = session.capabilities.uidplus;
    let set = uids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    if options.dedupe_existing && uids.len() == 1 {
        if let Some(search) = options.message_id.and_then(header_message_id_search) {
            let replay_match = matching_destination_content(
                &mut session,
                &wire_source,
                &wire_destination,
                uids[0],
                expected_uid_validity,
                &search,
                "Move",
            )
            .await?;
            match replay_match {
                ReplayContentMatch::SourceMissing => {
                    return Err(MailboxOperationError::terminal(
                        "This message is no longer available on the server.".to_string(),
                    ));
                }
                ReplayContentMatch::NoMatch => {}
                ReplayContentMatch::ExistingCopy { uid, uid_validity } => {
                    if !has_uidplus {
                        return Err(MailboxOperationError::terminal(
                            "This mail server cannot safely move messages.".to_string(),
                        ));
                    }
                    if let Some(flags) = options
                        .replay_flags
                        .filter(|flags| flags.is_read.is_some() || flags.is_starred.is_some())
                    {
                        select_replay_destination(
                            &mut session,
                            &wire_destination,
                            uid_validity,
                            "Move",
                        )
                        .await?;
                        if !replay_uid_exists(&mut session, uid, "Move").await? {
                            return Err(MailboxOperationError::transient(
                                "The copied message changed while replaying its flags; the source was kept."
                                    .to_string(),
                            ));
                        }
                        store_uid_flags_selected(
                            &mut session,
                            &[uid],
                            flags.is_read,
                            flags.is_starred,
                            "Move",
                        )
                        .await?;
                        select_replay_destination(
                            &mut session,
                            &wire_destination,
                            uid_validity,
                            "Move",
                        )
                        .await?;
                        verify_replayed_flags(
                            &mut session,
                            uid,
                            flags.is_read,
                            flags.is_starred,
                            "Move",
                        )
                        .await?;
                    }
                    select_replay_source(&mut session, &wire_source, expected_uid_validity, "Move")
                        .await?;
                    if !replay_uid_exists(&mut session, uids[0], "Move").await? {
                        return Err(MailboxOperationError::terminal(
                            "This message is no longer available on the server.".to_string(),
                        ));
                    }
                    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
                        session
                            .uid_store(set.clone(), "+FLAGS.SILENT (\\Deleted)")
                            .await
                            .map_err(|error| remote_failure(error, "Move"))?
                            .try_collect::<Vec<_>>()
                            .await
                            .map_err(|error| remote_failure(error, "Move"))
                    })
                    .await
                    .map_err(|_| {
                        MailboxOperationError::transient("Move timed out.".to_string())
                    })??;
                    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
                        session
                            .uid_expunge(set)
                            .await
                            .map_err(|error| remote_failure(error, "Move"))?
                            .try_collect::<Vec<_>>()
                            .await
                            .map_err(|error| remote_failure(error, "Move"))
                    })
                    .await
                    .map_err(|_| {
                        MailboxOperationError::transient("Move timed out.".to_string())
                    })??;
                    session.release();
                    return Ok(());
                }
            }
        }
    }
    if can_move {
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_mv(set, &wire_destination))
            .await
            .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))?
            .map_err(|error| remote_failure(error, "Move"))?;
    } else if has_uidplus {
        tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.uid_copy(set.clone(), &wire_destination),
        )
        .await
        .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))?
        .map_err(|error| remote_failure(error, "Move"))?;
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            session
                .uid_store(set.clone(), "+FLAGS.SILENT (\\Deleted)")
                .await
                .map_err(|error| remote_failure(error, "Move"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| remote_failure(error, "Move"))
        })
        .await
        .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))??;
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            session
                .uid_expunge(set)
                .await
                .map_err(|error| remote_failure(error, "Move"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| remote_failure(error, "Move"))
        })
        .await
        .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))??;
    } else {
        return Err(MailboxOperationError::terminal(
            "This mail server cannot safely move messages.".to_string(),
        ));
    }
    session.release();
    Ok(())
}

pub async fn create_folder(
    account: &AccountRecord,
    password: &str,
    name: &str,
) -> Result<(), String> {
    let mut session = super::pool::checkout(account, password).await?;
    let wire_name = session.mailbox_name(name);
    let result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.create(&wire_name))
        .await
        .map_err(|_| "Creating the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder creation"));
    session.release();
    result
}

pub async fn rename_folder(
    account: &AccountRecord,
    password: &str,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    let mut session = super::pool::checkout(account, password).await?;
    let wire_old_name = session.mailbox_name(old_name);
    let wire_new_name = session.mailbox_name(new_name);
    let result = tokio::time::timeout(
        IMAP_COMMAND_TIMEOUT,
        session.rename(&wire_old_name, &wire_new_name),
    )
    .await
    .map_err(|_| "Renaming the folder timed out.".to_string())?
    .map_err(|error| redact_error(&error, "Folder rename"));
    session.release();
    result
}

pub async fn delete_folder(
    account: &AccountRecord,
    password: &str,
    name: &str,
) -> Result<(), String> {
    let mut session = super::pool::checkout(account, password).await?;
    let wire_name = session.mailbox_name(name);
    let result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.delete(&wire_name))
        .await
        .map_err(|_| "Deleting the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder deletion"));
    session.release();
    result
}

pub async fn empty_folder(
    account: &AccountRecord,
    password: &str,
    name: &str,
    expected_uid_validity: Option<u32>,
    protected_uids: &[u32],
) -> Result<(), String> {
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        "Mailbox identity is unavailable; refresh mail and try again.".to_string()
    })?;
    let mut session = super::pool::checkout(account, password).await?;
    let wire_name = session.mailbox_name(name);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_name))
        .await
        .map_err(|_| "Emptying the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder empty"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err("This mailbox changed; refresh mail and try again.".into());
    }
    if selected.exists == 0 {
        session.release();
        return Ok(());
    }
    let all_uids: Vec<u32> = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_search("ALL"))
        .await
        .map_err(|_| "Emptying the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder empty"))?
        .into_iter()
        .collect();
    if all_uids.is_empty() {
        session.release();
        return Ok(());
    }
    // A range, not a comma list: a folder with tens of thousands of messages
    // would otherwise exceed server command-length limits.
    let newest = all_uids.iter().copied().max().unwrap_or(1);
    let set = format!("1:{newest}");
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_store(set.clone(), "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|error| redact_error(&error, "Folder empty"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Folder empty"))
    })
    .await
    .map_err(|_| "Emptying the folder timed out.".to_string())??;
    // Messages with queued moves hide in Trash; unflag them so the expunge
    // below cannot destroy a move that has not replayed yet.
    if !protected_uids.is_empty() {
        let protected = protected_uids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",");
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            session
                .uid_store(protected, "-FLAGS.SILENT (\\Deleted)")
                .await
                .map_err(|error| redact_error(&error, "Folder empty"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Folder empty"))
        })
        .await
        .map_err(|_| "Emptying the folder timed out.".to_string())??;
    }
    let uid_expunge = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_expunge(set)
            .await
            .map_err(|error| redact_error(&error, "Folder empty"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Folder empty"))
    })
    .await;
    match uid_expunge {
        Ok(Ok(_)) => {}
        _ => {
            tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
                session
                    .expunge()
                    .await
                    .map_err(|error| redact_error(&error, "Folder empty"))?
                    .try_collect::<Vec<_>>()
                    .await
                    .map_err(|error| redact_error(&error, "Folder empty"))
            })
            .await
            .map_err(|_| "Emptying the folder timed out.".to_string())??;
        }
    }
    session.release();
    Ok(())
}

/// Comma-separated UID set for one STORE / UID EXPUNGE. Empty, zero, and
/// oversized sets are rejected so a bad caller cannot widen the command.
pub(crate) fn uid_set(uids: &[u32]) -> Result<String, String> {
    if uids.is_empty() || uids.len() > 200 || uids.contains(&0) {
        return Err("Choose up to 200 messages.".into());
    }
    let mut ordered = uids.to_vec();
    ordered.sort_unstable();
    ordered.dedup();
    Ok(ordered
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(","))
}

/// Delete specific Trash messages. UID EXPUNGE is limited to `uids`. A server
/// without UIDPLUS is told to clear `\Deleted` on that same set; this never
/// falls back to a mailbox-wide EXPUNGE.
pub async fn expunge_uids(
    account: &AccountRecord,
    password: &str,
    name: &str,
    expected_uid_validity: u32,
    uids: &[u32],
) -> Result<(), String> {
    let set = uid_set(uids)?;
    let mut session = super::pool::checkout(account, password).await?;
    let wire_name = session.mailbox_name(name);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_name))
        .await
        .map_err(|_| "Deleting the message timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Delete message"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        session.release();
        return Err("This mailbox changed; refresh mail and try again.".into());
    }
    let flagged = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_store(set.clone(), "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|error| redact_error(&error, "Delete message"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Delete message"))
    })
    .await
    .map_err(|_| "Deleting the message timed out.".to_string())?;
    if let Err(error) = flagged {
        session.discard();
        return Err(error);
    }
    let expunged = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_expunge(set.clone())
            .await
            .map_err(|error| redact_error(&error, "Delete message"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Delete message"))
    })
    .await;
    match expunged {
        Ok(Ok(_)) => {
            session.release();
            Ok(())
        }
        // The command may still be running on the wire; the session cannot be reused.
        Err(_) => {
            session.discard();
            Err("Deleting the message timed out.".into())
        }
        // The server refused UID EXPUNGE; restore the flags on the same session.
        Ok(Err(_)) => {
            let restored = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
                session
                    .uid_store(set, "-FLAGS.SILENT (\\Deleted)")
                    .await
                    .map_err(|error| redact_error(&error, "Delete message"))?
                    .try_collect::<Vec<_>>()
                    .await
                    .map_err(|error| redact_error(&error, "Delete message"))
            })
            .await;
            if matches!(restored, Ok(Ok(_))) {
                session.release();
            } else {
                session.discard();
            }
            Err("This mail server cannot delete individual messages. Use Empty trash.".into())
        }
    }
}

/// Mark every message up to the current UIDNEXT as read on the server, not
/// only the ones cached locally. Mail arriving after the click stays unread.
pub async fn mark_folder_read(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    expected_uid_validity: u32,
) -> Result<(), String> {
    let mut session = super::pool::checkout(account, password).await?;
    let wire_mailbox = session.mailbox_name(mailbox);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_mailbox))
        .await
        .map_err(|_| "Marking the folder read timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mark folder read"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err("This mailbox changed; refresh mail and try again.".into());
    }
    let newest = selected
        .uid_next
        .map(|next| next.saturating_sub(1))
        .unwrap_or(0);
    if selected.exists == 0 || newest == 0 {
        session.release();
        return Ok(());
    }
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_store(format!("1:{newest}"), "+FLAGS.SILENT (\\Seen)")
            .await
            .map_err(|error| redact_error(&error, "Mark folder read"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Mark folder read"))
    })
    .await
    .map_err(|_| "Marking the folder read timed out.".to_string())??;
    session.release();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{header_message_id_search, quote_imap_search, uid_set};

    // Failure modes for the dedupe SEARCH built from a Message-ID:
    // 1. CR or LF would split the IMAP command and inject a new command.
    // 2. NUL or tab could truncate or corrupt the quoted search string.
    // 3. Non-ASCII needs a charset/literal the dedupe search does not send.
    // 4. An unescaped quote or backslash would end the quoted string early.
    // 5. Empty input must not produce a match-everything search.
    // 6. A safe id must still produce the normal HEADER search.
    #[test]
    fn dedupe_search_is_skipped_for_unsafe_message_ids() {
        for bad in [
            "<a@b>\r\nA1 LOGOUT",
            "<a@b>\n",
            "<a\0@b>",
            "<a\t@b>",
            "<ä@b>",
            "",
            "   ",
        ] {
            assert_eq!(
                header_message_id_search(bad),
                None,
                "built search for {bad:?}"
            );
        }
    }

    #[test]
    fn dedupe_search_quotes_safe_message_ids() {
        assert_eq!(
            header_message_id_search("<a@b.example>").as_deref(),
            Some("HEADER Message-ID \"<a@b.example>\"")
        );
        assert_eq!(
            header_message_id_search(r#"<a"\@b>"#).as_deref(),
            Some(r#"HEADER Message-ID "<a\"\\@b>""#)
        );
    }

    #[test]
    fn quoted_search_never_emits_control_characters() {
        for byte in 0u8..=127 {
            let raw = format!("<a{}b@c>", byte as char);
            if let Some(search) = header_message_id_search(&raw) {
                assert!(!search.chars().any(|c| c.is_ascii_control()), "byte {byte}");
            }
        }
        assert_eq!(quote_imap_search(r#"a"\b"#), r#"a\"\\b"#);
    }

    #[test]
    fn uid_set_sorts_and_rejects_a_wide_delete() {
        assert_eq!(uid_set(&[4, 2, 4]).unwrap(), "2,4");
        assert!(uid_set(&[]).is_err());
        assert!(uid_set(&[0, 2]).is_err());
        assert!(uid_set(&[1; 201]).is_err());
    }
}
