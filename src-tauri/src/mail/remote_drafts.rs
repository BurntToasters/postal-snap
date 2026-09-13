use chrono::Utc;
use futures_util::TryStreamExt;
use mail_parser::{MessageParser, MimeHeaders};

use super::parse::{
    attachment_id, legacy_attachment_id, normalize_rfc_message_id, parsed_addresses,
    validate_mime_resource_shape,
};
use super::send::connect_imap;
use super::{
    BodyBudget, ImapSession, RemoteDraftAttachment, RemoteDraftData, RemoteDraftLocation,
    RemoteDraftSnapshot, IMAP_COMMAND_TIMEOUT, MAX_ATTACHMENTS, MAX_MESSAGE_BYTES, MAX_MIME_PARTS,
};
use crate::{
    models::AccountRecord,
    security::{redact_error, safe_filename},
};

/// Cumulative delivered-body cap for one draft import chunk. The declared
/// RFC822.SIZE only filters which UIDs are requested; the delivered length and
/// this cumulative budget bound what is retained.
const DRAFT_BATCH_TOTAL_BYTES: usize = MAX_MESSAGE_BYTES;

#[allow(clippy::too_many_arguments)]
pub async fn upsert_remote_draft(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    message_id: &str,
    bytes: &[u8],
    previous_uid: Option<u32>,
    previous_uid_validity: Option<u32>,
) -> Result<RemoteDraftLocation, String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
        .await
        .map_err(|_| "Draft synchronization timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Draft synchronization"))?;
    let selected_uid_validity = selected.uid_validity.ok_or_else(|| {
        "The Drafts folder identity is unavailable; Postal Snap kept the local draft safely."
            .to_string()
    })?;
    let capabilities = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.capabilities())
        .await
        .map_err(|_| "Draft synchronization timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Draft synchronization"))?;
    if previous_uid.is_some() && !capabilities.has_str("UIDPLUS") {
        return Err("This mail server cannot safely replace synchronized drafts.".into());
    }
    let mut matching = search_message_id(&mut session, message_id, "Draft synchronization").await?;
    if matching.is_empty() {
        tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.append(mailbox, Some("(\\Draft)"), None, bytes),
        )
        .await
        .map_err(|_| "Draft upload timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Draft upload"))?;
        let refreshed = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
            .await
            .map_err(|_| "Draft synchronization timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Draft synchronization"))?;
        if refreshed.uid_validity != Some(selected_uid_validity) {
            return Err(
                "The Drafts folder changed; Postal Snap kept the local draft safely.".into(),
            );
        }
        matching = search_message_id(&mut session, message_id, "Draft synchronization").await?;
    }
    let uid = matching
        .into_iter()
        .max()
        .ok_or_else(|| "The uploaded draft could not be confirmed.".to_string())?;
    if previous_uid_validity == Some(selected_uid_validity) {
        if let Some(previous_uid) = previous_uid.filter(|previous_uid| *previous_uid != uid) {
            tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
                session
                    .uid_store(previous_uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
                    .await
                    .map_err(|error| redact_error(&error, "Draft replacement"))?
                    .try_collect::<Vec<_>>()
                    .await
                    .map_err(|error| redact_error(&error, "Draft replacement"))
            })
            .await
            .map_err(|_| "Draft replacement timed out.".to_string())??;
            tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
                session
                    .uid_expunge(previous_uid.to_string())
                    .await
                    .map_err(|error| redact_error(&error, "Draft replacement"))?
                    .try_collect::<Vec<_>>()
                    .await
                    .map_err(|error| redact_error(&error, "Draft replacement"))
            })
            .await
            .map_err(|_| "Draft replacement timed out.".to_string())??;
        }
    }
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    Ok(RemoteDraftLocation {
        uid,
        uid_validity: Some(selected_uid_validity),
    })
}

pub async fn delete_remote_draft(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    expected_uid_validity: Option<u32>,
) -> Result<(), String> {
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        "The Drafts folder identity is unavailable; Postal Snap kept the local draft safely."
            .to_string()
    })?;
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
        .await
        .map_err(|_| "Draft deletion timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Draft deletion"))?;
    if selected.uid_validity != Some(expected_uid_validity) {
        return Err("The Drafts folder changed; Postal Snap kept the local draft safely.".into());
    }
    let capabilities = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.capabilities())
        .await
        .map_err(|_| "Draft deletion timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Draft deletion"))?;
    if !capabilities.has_str("UIDPLUS") {
        return Err("This mail server cannot safely delete synchronized drafts.".into());
    }
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|error| redact_error(&error, "Draft deletion"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Draft deletion"))
    })
    .await
    .map_err(|_| "Draft deletion timed out.".to_string())??;
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_expunge(uid.to_string())
            .await
            .map_err(|error| redact_error(&error, "Draft deletion"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Draft deletion"))
    })
    .await
    .map_err(|_| "Draft deletion timed out.".to_string())??;
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    Ok(())
}

pub async fn fetch_remote_drafts(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    known_uids: &std::collections::HashSet<u32>,
) -> Result<RemoteDraftSnapshot, String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.examine(mailbox))
        .await
        .map_err(|_| "Draft download timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Draft download"))?;
    let selected_uid_validity = selected.uid_validity.ok_or_else(|| {
        "The Drafts folder identity is unavailable; server drafts were not imported.".to_string()
    })?;
    let mut uids = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_search("ALL"))
        .await
        .map_err(|_| "Draft download timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Draft download"))?
        .into_iter()
        .collect::<Vec<_>>();
    uids.sort_unstable();
    let unknown = uids
        .iter()
        .copied()
        .filter(|uid| !known_uids.contains(uid))
        .collect::<Vec<_>>();
    let mut drafts = Vec::new();
    let mut budget = BodyBudget::default();
    for chunk in unknown.chunks(100) {
        let set = chunk
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let sizes = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            session
                .uid_fetch(&set, "(UID RFC822.SIZE)")
                .await
                .map_err(|error| redact_error(&error, "Draft download"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Draft download"))
        })
        .await
        .map_err(|_| "Draft download timed out.".to_string())??;
        let safe = sizes
            .into_iter()
            .filter_map(|item| {
                (item.size.unwrap_or_default() as usize <= MAX_MESSAGE_BYTES).then_some(item.uid)
            })
            .flatten()
            .collect::<Vec<_>>();
        if safe.is_empty() {
            continue;
        }
        let safe_set = safe
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let mut fetched = tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.uid_fetch(safe_set, "(UID INTERNALDATE BODY.PEEK[])"),
        )
        .await
        .map_err(|_| "Draft download timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Draft download"))?;
        loop {
            let row = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, fetched.try_next())
                .await
                .map_err(|_| "Draft download timed out.".to_string())?
                .map_err(|error| redact_error(&error, "Draft download"))?;
            let Some(row) = row else {
                break;
            };
            let Some(uid) = row.uid else { continue };
            let Some(raw) = row.body() else { continue };
            if !budget.admit(raw.len(), MAX_MESSAGE_BYTES, DRAFT_BATCH_TOTAL_BYTES) {
                continue;
            }
            let updated_at = row
                .internal_date()
                .map(|date| date.with_timezone(&Utc).to_rfc3339())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            if let Ok(draft) = parse_remote_draft(uid, raw, updated_at) {
                drafts.push(draft);
            }
        }
    }
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    Ok(RemoteDraftSnapshot {
        uid_validity: Some(selected_uid_validity),
        uids,
        drafts,
    })
}

pub(crate) fn parse_remote_draft(
    uid: u32,
    raw: &[u8],
    updated_at: String,
) -> Result<RemoteDraftData, String> {
    validate_mime_resource_shape(raw)?;
    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| "A malformed server draft was skipped.".to_string())?;
    if message.parts.len() > MAX_MIME_PARTS || message.attachment_count() > MAX_ATTACHMENTS {
        return Err("A server draft exceeded safe MIME limits and was skipped.".into());
    }
    let attachments = message
        .attachments()
        .take(MAX_ATTACHMENTS)
        .map(|part| {
            let filename = safe_filename(part.attachment_name().unwrap_or("attachment"));
            let content_type = part
                .content_type()
                .and_then(|value| {
                    value
                        .subtype()
                        .map(|subtype| format!("{}/{subtype}", value.ctype()))
                })
                .unwrap_or_else(|| {
                    mime_guess::from_path(&filename)
                        .first_or_octet_stream()
                        .to_string()
                });
            RemoteDraftAttachment {
                filename,
                content_type,
                inline: part.content_id().is_some(),
                content_id: part.content_id().map(ToOwned::to_owned),
                bytes: part.contents().to_vec(),
            }
        })
        .collect();
    Ok(RemoteDraftData {
        uid,
        message_id: message.message_id().and_then(normalize_rfc_message_id),
        updated_at,
        from: message
            .from()
            .and_then(|address| address.first())
            .and_then(|entry| entry.address.as_deref())
            .filter(|address| address.contains('@'))
            .map(ToOwned::to_owned),
        to: parsed_addresses(message.to()),
        cc: parsed_addresses(message.cc()),
        bcc: parsed_addresses(message.bcc()),
        subject: message.subject().unwrap_or_default().to_string(),
        html_body: crate::html_sanitize::sanitize_compose_html(
            &message
                .body_html(0)
                .map(|body| body.into_owned())
                .unwrap_or_default(),
        ),
        text_body: message
            .body_text(0)
            .map(|body| body.into_owned())
            .unwrap_or_default(),
        in_reply_to: message.in_reply_to().as_text().map(ToOwned::to_owned),
        references: message
            .references()
            .as_text_list()
            .map(|values| values.iter().map(|value| value.to_string()).collect()),
        attachments,
    })
}

pub(crate) async fn search_message_id(
    session: &mut ImapSession,
    message_id: &str,
    context: &str,
) -> Result<Vec<u32>, String> {
    let value = message_id
        .chars()
        .filter(|character| !character.is_control())
        .take(998)
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let mut matches = tokio::time::timeout(
        IMAP_COMMAND_TIMEOUT,
        session.uid_search(format!("HEADER Message-ID \"{value}\"")),
    )
    .await
    .map_err(|_| format!("{context} timed out."))?
    .map_err(|error| redact_error(&error, context))?
    .into_iter()
    .collect::<Vec<_>>();
    matches.sort_unstable();
    Ok(matches)
}

pub fn extract_attachment(raw: &[u8], requested_id: &str) -> Result<(String, Vec<u8>), String> {
    validate_mime_resource_shape(raw)?;
    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| "The attachment could not be decoded.".to_string())?;
    for (index, part) in message.attachments().take(MAX_ATTACHMENTS).enumerate() {
        let filename = safe_filename(part.attachment_name().unwrap_or("attachment"));
        let stable = attachment_id(&filename, part.content_id(), part.len(), index);
        if stable == requested_id || legacy_attachment_id(index, &filename) == requested_id {
            return Ok((filename, part.contents().to_vec()));
        }
    }
    Err("Attachment not found.".into())
}
