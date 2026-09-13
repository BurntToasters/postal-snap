use futures_util::TryStreamExt;

use super::send::connect_imap;
use super::IMAP_COMMAND_TIMEOUT;
use crate::{models::AccountRecord, security::redact_error};

pub async fn set_remote_flags(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    expected_uid_validity: Option<u32>,
    is_read: Option<bool>,
    is_starred: Option<bool>,
) -> Result<(), String> {
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
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        "Mailbox identity is unavailable; refresh mail and try again.".to_string()
    })?;
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
        .await
        .map_err(|_| "Message update timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Message update"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err("This mailbox changed; refresh mail and try again.".into());
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
                .map_err(|error| redact_error(&error, "Message update"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Message update"))
        })
        .await
        .map_err(|_| "Message update timed out.".to_string())??;
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
                .map_err(|error| redact_error(&error, "Message update"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Message update"))
        })
        .await
        .map_err(|_| "Message update timed out.".to_string())??;
    }
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    Ok(())
}

pub async fn move_remote(
    account: &AccountRecord,
    password: &str,
    source: &str,
    destination: &str,
    uid: u32,
    expected_uid_validity: Option<u32>,
) -> Result<(), String> {
    move_remote_uids(
        account,
        password,
        source,
        destination,
        &[uid],
        expected_uid_validity,
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
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        "Mailbox identity is unavailable; refresh mail and try again.".to_string()
    })?;
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(source))
        .await
        .map_err(|_| "Move timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Move"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err("This mailbox changed; refresh mail and try again.".into());
    }
    let set = uids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let capabilities = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.capabilities())
        .await
        .map_err(|_| "Move timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Move capability check"))?;
    if capabilities.has_str("MOVE") {
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_mv(set, destination))
            .await
            .map_err(|_| "Move timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Move"))?;
    } else if capabilities.has_str("UIDPLUS") {
        tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.uid_copy(set.clone(), destination),
        )
        .await
        .map_err(|_| "Move timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Move"))?;
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            session
                .uid_store(set.clone(), "+FLAGS.SILENT (\\Deleted)")
                .await
                .map_err(|error| redact_error(&error, "Move"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Move"))
        })
        .await
        .map_err(|_| "Move timed out.".to_string())??;
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            session
                .uid_expunge(set)
                .await
                .map_err(|error| redact_error(&error, "Move"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Move"))
        })
        .await
        .map_err(|_| "Move timed out.".to_string())??;
    } else {
        return Err("This mail server cannot safely move messages.".into());
    }
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    Ok(())
}

pub async fn create_folder(
    account: &AccountRecord,
    password: &str,
    name: &str,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.create(name))
        .await
        .map_err(|_| "Creating the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder creation"));
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    result
}

pub async fn rename_folder(
    account: &AccountRecord,
    password: &str,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.rename(old_name, new_name))
        .await
        .map_err(|_| "Renaming the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder rename"));
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    result
}

pub async fn delete_folder(
    account: &AccountRecord,
    password: &str,
    name: &str,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.delete(name))
        .await
        .map_err(|_| "Deleting the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder deletion"));
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
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
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(name))
        .await
        .map_err(|_| "Emptying the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder empty"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err("This mailbox changed; refresh mail and try again.".into());
    }
    if selected.exists == 0 {
        let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
        return Ok(());
    }
    let all_uids: Vec<u32> = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_search("ALL"))
        .await
        .map_err(|_| "Emptying the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder empty"))?
        .into_iter()
        .collect();
    if all_uids.is_empty() {
        let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
        return Ok(());
    }
    let set = all_uids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
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
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    Ok(())
}
