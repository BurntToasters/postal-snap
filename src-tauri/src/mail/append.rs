//! IMAP APPEND for mailbox import. Mirrors the Sent-copy APPEND in `send.rs`.

use super::{pool, IMAP_COMMAND_TIMEOUT};
use crate::{models::AccountRecord, security::redact_error};

/// Append each message as read (`\Seen`), one APPEND per message, and return
/// how many the server accepted. The caller bounds the batch size.
pub async fn append_seen(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    messages: &[Vec<u8>],
) -> Result<u32, String> {
    let mut session = pool::checkout(account, password).await?;
    let wire_mailbox = session.mailbox_name(mailbox);
    let mut appended = 0u32;
    for bytes in messages {
        tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.append(&wire_mailbox, Some("(\\Seen)"), None, bytes),
        )
        .await
        .map_err(|_| "Importing messages timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Import"))?;
        appended += 1;
    }
    session.release();
    Ok(appended)
}
