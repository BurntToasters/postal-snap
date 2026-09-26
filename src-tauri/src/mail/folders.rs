use futures_util::TryStreamExt;

use super::IMAP_COMMAND_TIMEOUT;
use crate::{models::AccountRecord, security::redact_error};

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
        .map_err(MailboxOperationError::transient)?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
        .await
        .map_err(|_| MailboxOperationError::transient("Message update timed out.".to_string()))?
        .map_err(|error| remote_failure(error, "Message update"))?;
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
                .map_err(|error| remote_failure(error, "Message update"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| remote_failure(error, "Message update"))
        })
        .await
        .map_err(|_| MailboxOperationError::transient("Message update timed out.".to_string()))??;
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
                .map_err(|error| remote_failure(error, "Message update"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| remote_failure(error, "Message update"))
        })
        .await
        .map_err(|_| MailboxOperationError::transient("Message update timed out.".to_string()))??;
    }
    session.release();
    Ok(())
}

#[derive(Default)]
pub struct MoveOptions<'a> {
    pub message_id: Option<&'a str>,
    /// Set when replaying an offline move so an already-applied server move is
    /// recognized instead of copied twice.
    pub dedupe_existing: bool,
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
        .map_err(MailboxOperationError::transient)?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(source))
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
    // A reconnect after an ambiguous COPY/MOVE replays the same source UID.
    // If the destination already holds this Message-ID the server applied the
    // original move, so only finish removing the source copy.
    if options.dedupe_existing {
        if let Some(raw_message_id) = options
            .message_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            let search = format!(
                "HEADER Message-ID \"{}\"",
                quote_imap_search(raw_message_id)
            );
            let destination_selected =
                tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(destination))
                    .await
                    .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))?
                    .map_err(|error| remote_failure(error, "Move"))?;
            let _ = destination_selected;
            let existing = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_search(&search))
                .await
                .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))?
                .map_err(|error| remote_failure(error, "Move"))?;
            if !existing.is_empty() {
                if !has_uidplus {
                    return Err(MailboxOperationError::terminal(
                        "This mail server cannot safely move messages.".to_string(),
                    ));
                }
                tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(source))
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
                session.release();
                return Ok(());
            }
            tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(source))
                .await
                .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))?
                .map_err(|error| remote_failure(error, "Move"))?;
        }
    }
    if can_move {
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_mv(set, destination))
            .await
            .map_err(|_| MailboxOperationError::transient("Move timed out.".to_string()))?
            .map_err(|error| remote_failure(error, "Move"))?;
    } else if has_uidplus {
        tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.uid_copy(set.clone(), destination),
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
    let result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.create(name))
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
    let result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.rename(old_name, new_name))
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
    let result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.delete(name))
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
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(name))
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

/// Mark every message up to the current UIDNEXT as read on the server, not
/// only the ones cached locally. Mail arriving after the click stays unread.
pub async fn mark_folder_read(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    expected_uid_validity: u32,
) -> Result<(), String> {
    let mut session = super::pool::checkout(account, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
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
