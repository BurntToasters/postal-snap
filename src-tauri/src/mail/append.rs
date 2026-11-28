//! IMAP APPEND for mailbox import. Mirrors the Sent-copy APPEND in `send.rs`.

use super::pool;
use crate::{models::AccountRecord, security::redact_error};

pub(crate) fn imap_internaldate_from_raw(raw: &[u8]) -> Option<String> {
    super::parse::imap_internaldate_from_raw(raw)
}

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
        let internal_date = imap_internaldate_from_raw(bytes);
        tokio::time::timeout(
            super::send::append_timeout(bytes.len()),
            session.append(
                &wire_mailbox,
                Some("(\\Seen)"),
                internal_date.as_deref(),
                bytes,
            ),
        )
        .await
        .map_err(|_| "Importing messages timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Import"))?;
        appended += 1;
    }
    session.release();
    Ok(appended)
}

#[cfg(test)]
mod tests {
    // Failure modes:
    // 1. Missing or invalid Date header returns None instead of malformed IMAP syntax.
    // 2. Output omits outer double quotes required by RFC 3501 date-time because async-imap writes internaldate verbatim.
    // 3. Valid Date header formats as quoted IMAP INTERNALDATE with numeric offset.
    #[test]
    fn internaldate_formats_rfc3501_quoted_datetime_or_none() {
        assert_eq!(
            super::imap_internaldate_from_raw(b"Subject: No date\r\n\r\nhi"),
            None
        );
        assert_eq!(
            super::imap_internaldate_from_raw(b"Date: not-a-date\r\n\r\nhi"),
            None
        );
        let formatted = super::imap_internaldate_from_raw(
            b"Date: Mon, 5 Jan 2026 10:02:03 -0500\r\nSubject: Hi\r\n\r\nbody",
        )
        .unwrap();
        assert!(formatted.starts_with('"') && formatted.ends_with('"'));
        assert_eq!(formatted, "\"05-Jan-2026 10:02:03 -0500\"");
    }
}
