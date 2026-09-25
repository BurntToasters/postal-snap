use chrono::{DateTime, SecondsFormat, Utc};
use lettre::message::Mailbox;
use mail_parser::{MessageParser, MimeHeaders};
use sha2::{Digest, Sha256};

use super::{MAX_ATTACHMENTS, MAX_MESSAGE_BYTES, MAX_MIME_PARTS, MAX_MULTIPART_DECLARATIONS};
use crate::{db::CachedMessage, models::Attachment, security::safe_filename};

pub(crate) fn parse_mailbox(value: &str) -> Result<Mailbox, String> {
    value
        .parse()
        .map_err(|_| "One of the recipient addresses is invalid.".into())
}

pub(crate) fn parse_envelope(
    fetch: &async_imap::types::Fetch,
    is_read: bool,
    is_starred: bool,
) -> Result<CachedMessage, String> {
    let uid = fetch
        .uid
        .ok_or_else(|| "The mail server omitted a message identifier.".to_string())?;
    let envelope = fetch
        .envelope()
        .ok_or_else(|| "The mail server omitted a message envelope.".to_string())?;
    let sender = envelope
        .from
        .as_deref()
        .and_then(|addresses| addresses.first());
    let sender_name = sender
        .and_then(|address| address.name.as_deref())
        .map(decode_imap_text)
        .unwrap_or_default();
    let sender_address = sender.and_then(imap_address).unwrap_or_default();
    let to = imap_addresses(envelope.to.as_deref());
    let cc = imap_addresses(envelope.cc.as_deref());
    let reply_to = envelope
        .reply_to
        .as_deref()
        .and_then(|addresses| addresses.first())
        .and_then(imap_address);
    let received_at = envelope
        .date
        .as_deref()
        .and_then(|raw| std::str::from_utf8(raw).ok())
        .and_then(|date| DateTime::parse_from_rfc2822(date).ok())
        .map(|date| canonical_time(date.with_timezone(&Utc)))
        .or_else(|| {
            fetch
                .internal_date()
                .map(|date| canonical_time(date.with_timezone(&Utc)))
        })
        .unwrap_or_else(|| canonical_time(Utc::now()));
    let recipients = to
        .iter()
        .chain(cc.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    Ok(CachedMessage {
        internal_at: internal_date(fetch),
        uid,
        message_id: envelope
            .message_id
            .as_deref()
            .map(decode_imap_text)
            .as_deref()
            .and_then(normalize_rfc_message_id),
        subject: envelope
            .subject
            .as_deref()
            .map(decode_imap_text)
            .unwrap_or_default(),
        sender_name,
        sender_address,
        recipients,
        received_at,
        preview: String::new(),
        is_read,
        is_starred,
        size: fetch.size.unwrap_or_default() as u64,
        to,
        cc,
        reply_to,
        thread_parent: thread_parent_from_fetch(fetch),
        text_body: String::new(),
        html_body: None,
        attachments: Vec::new(),
        raw_message: Vec::new(),
        has_attachments: fetch.bodystructure().map_or_else(
            || header_suggests_attachments(fetch),
            bodystructure_has_attachments,
        ),
    })
}

/// Attachment hint for the message list from the top-level Content-Type,
/// used instead of BODYSTRUCTURE: a hostile, deeply nested structure can make
/// the whole envelope batch unparseable. The downloaded body corrects it.
fn header_suggests_attachments(fetch: &async_imap::types::Fetch) -> bool {
    let Some(text) = fetch.header().and_then(|raw| std::str::from_utf8(raw).ok()) else {
        return false;
    };
    let mut content_type = String::new();
    let mut in_content_type = false;
    for line in text.lines() {
        if line.starts_with([' ', '\t']) {
            if in_content_type {
                content_type.push(' ');
                content_type.push_str(line.trim());
            }
            continue;
        }
        in_content_type = false;
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-type") {
                content_type = value.trim().to_string();
                in_content_type = true;
            }
        }
    }
    let media = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    media == "multipart/mixed"
        || (!media.is_empty() && !media.starts_with("text/") && !media.starts_with("multipart/"))
}

fn part_is_inline(part: &mail_parser::MessagePart<'_>) -> bool {
    let disposition = part.content_disposition().map(|value| value.ctype());
    match disposition {
        Some(value) if value.eq_ignore_ascii_case("attachment") => false,
        Some(value) if value.eq_ignore_ascii_case("inline") => true,
        _ => part.content_id().is_some(),
    }
}

fn bodystructure_has_attachments(structure: &imap_proto::types::BodyStructure<'_>) -> bool {
    use imap_proto::types::BodyStructure;
    match structure {
        BodyStructure::Basic { common, .. } => part_looks_like_file(common),
        BodyStructure::Text { common, .. } => part_looks_like_file(common),
        BodyStructure::Message { .. } => true,
        BodyStructure::Multipart { bodies, .. } => bodies.iter().any(bodystructure_has_attachments),
    }
}

fn part_looks_like_file(common: &imap_proto::types::BodyContentCommon<'_>) -> bool {
    common
        .disposition
        .as_ref()
        .is_some_and(|disposition| disposition.ty.eq_ignore_ascii_case("attachment"))
        || (!common.ty.ty.eq_ignore_ascii_case("text")
            && !common.ty.ty.eq_ignore_ascii_case("multipart"))
}

/// Thread parent (normalized In-Reply-To, else last References id) from an
/// IMAP ENVELOPE+HEADER.FIELDS fetch. Missing on servers that omit headers.
fn thread_parent_from_fetch(fetch: &async_imap::types::Fetch) -> Option<String> {
    let raw = fetch.header()?;
    let text = std::str::from_utf8(raw).ok()?;
    let mut unfolded = String::with_capacity(text.len());
    for line in text.lines() {
        if line.starts_with([' ', '\t']) {
            unfolded.push(' ');
            unfolded.push_str(line.trim());
        } else {
            unfolded.push('\n');
            unfolded.push_str(line);
        }
    }
    let mut in_reply_to = None;
    let mut references = Vec::new();
    for line in unfolded.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "in-reply-to" => {
                if in_reply_to.is_none() {
                    in_reply_to = message_ids_in(value).into_iter().next();
                }
            }
            "references" => references.extend(message_ids_in(value)),
            _ => {}
        }
    }
    in_reply_to.or_else(|| references.into_iter().next_back())
}

fn message_ids_in(value: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find('<') {
        let after = &rest[start + 1..];
        if let Some(end) = after.find('>') {
            if let Some(normalized) = normalize_rfc_message_id(&after[..end]) {
                ids.push(normalized);
            }
            rest = &after[end + 1..];
        } else {
            break;
        }
    }
    ids
}

pub(crate) fn decode_imap_text(value: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(value).trim().to_string();
    if lossy.contains("=?") {
        let single_line = lossy.replace(['\r', '\n'], " ");
        let dummy = format!("Subject: {single_line}\r\n\r\n");
        if let Some(msg) = MessageParser::default().parse(dummy.as_bytes()) {
            if let Some(subject) = msg.subject() {
                return subject.trim().to_string();
            }
        }
    }
    lossy
}

fn imap_address(address: &async_imap::imap_proto::types::Address<'_>) -> Option<String> {
    let mailbox = address.mailbox.as_deref()?;
    let host = address.host.as_deref()?;
    let mailbox = decode_imap_text(mailbox);
    let host = decode_imap_text(host);
    (!mailbox.is_empty() && !host.is_empty()).then(|| format!("{mailbox}@{host}"))
}

fn imap_addresses(addresses: Option<&[async_imap::imap_proto::types::Address<'_>]>) -> Vec<String> {
    addresses
        .into_iter()
        .flatten()
        .filter_map(imap_address)
        .collect()
}

/// Canonical stored timestamp: whole seconds and an explicit UTC offset, so
/// text comparison matches time order (see `normalize_received_at`).
pub(crate) fn canonical_time(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(SecondsFormat::Secs, false)
}

/// Server arrival time. Unlike the sender-controlled Date header it cannot be
/// forged into the future, so retention and backfill cutoffs use it.
pub(crate) fn internal_date(item: &async_imap::types::Fetch) -> Option<String> {
    item.internal_date()
        .map(|date| canonical_time(date.with_timezone(&Utc)))
}

/// Match system flags by variant. Keywords are free-form atoms, so a
/// substring test would read `$Unseen` or `NotFlagged` as a system flag.
pub(crate) fn system_flags(item: &async_imap::types::Fetch) -> (bool, bool) {
    item.flags()
        .fold((false, false), |(seen, flagged), flag| match flag {
            async_imap::types::Flag::Seen => (true, flagged),
            async_imap::types::Flag::Flagged => (seen, true),
            _ => (seen, flagged),
        })
}

pub(crate) fn received_at_fallback(
    item: &async_imap::types::Fetch,
    cached_received_at: Option<&str>,
) -> Option<String> {
    item.internal_date()
        .map(|date| canonical_time(date.with_timezone(&Utc)))
        .or_else(|| cached_received_at.map(ToOwned::to_owned))
}

pub(crate) fn parse_message(
    uid: u32,
    raw: &[u8],
    is_read: bool,
    is_starred: bool,
    fallback_received_at: Option<&str>,
) -> Result<CachedMessage, String> {
    validate_mime_resource_shape(raw)?;
    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| "A malformed message was skipped.".to_string())?;
    if message.parts.len() > MAX_MIME_PARTS || message.attachment_count() > MAX_ATTACHMENTS {
        return Err("A message exceeded safe MIME limits and was skipped.".into());
    }
    let sender = message.from().and_then(|address| address.first());
    let sender_name = sender
        .and_then(|address| address.name.as_deref())
        .unwrap_or_default()
        .to_string();
    let sender_address = sender
        .and_then(|address| address.address.as_deref())
        .unwrap_or_default()
        .to_string();
    let to = parsed_addresses(message.to());
    let cc = parsed_addresses(message.cc());
    let reply_to = parsed_addresses(message.reply_to()).into_iter().next();
    let text_body = message
        .body_text(0)
        .map(|body| body.into_owned())
        .unwrap_or_default();
    let html_body = message
        .body_html(0)
        .map(|body| crate::html_sanitize::sanitize_received_html(&body).html);
    let preview = message
        .body_preview(180)
        .map(|body| body.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    let received_at = message
        .date()
        .and_then(|date| DateTime::<Utc>::from_timestamp(date.to_timestamp(), 0))
        .map(canonical_time)
        .or_else(|| fallback_received_at.map(ToOwned::to_owned))
        .unwrap_or_else(|| canonical_time(Utc::now()));
    let attachments = message
        .attachments()
        .take(MAX_ATTACHMENTS)
        .enumerate()
        .map(|(index, part)| {
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
            Attachment {
                id: attachment_id(&filename, part.content_id(), part.len(), index),
                filename,
                content_type,
                size: part.len() as u64,
                content_id: part.content_id().map(ToOwned::to_owned),
                inline: part_is_inline(part),
            }
        })
        .collect::<Vec<_>>();
    let recipients = to
        .iter()
        .chain(cc.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    Ok(CachedMessage {
        internal_at: None,
        uid,
        message_id: message.message_id().and_then(normalize_rfc_message_id),
        subject: message.subject().unwrap_or_default().to_string(),
        sender_name,
        sender_address,
        recipients,
        received_at,
        preview,
        is_read,
        is_starred,
        size: raw.len() as u64,
        to,
        cc,
        reply_to,
        thread_parent: message
            .in_reply_to()
            .as_text()
            .and_then(|value| message_ids_in(value).into_iter().next())
            .or_else(|| {
                message.references().as_text_list().and_then(|values| {
                    values
                        .iter()
                        .flat_map(|value| message_ids_in(value))
                        .next_back()
                })
            }),
        text_body,
        html_body,
        has_attachments: !attachments.is_empty(),
        attachments,
        raw_message: raw.to_vec(),
    })
}

pub(crate) fn validate_mime_resource_shape(raw: &[u8]) -> Result<(), String> {
    if raw.len() > MAX_MESSAGE_BYTES {
        return Err("This message is too large to process safely.".into());
    }
    // Count multipart declarations only inside header blocks (message start or
    // just after a boundary line). Plain text that quotes MIME source, digests,
    // and bug reports must not be rejected, while a genuinely deep tree still
    // exceeds the cap before the parser recurses.
    const CONTENT_TYPE: &[u8] = b"content-type:";
    const MULTIPART: &[u8] = b"multipart/";
    let mut declarations = 0usize;
    let mut in_headers = true;
    for line in raw.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if in_headers {
            if line.is_empty() {
                in_headers = false;
                continue;
            }
            if line.len() < CONTENT_TYPE.len()
                || !line[..CONTENT_TYPE.len()].eq_ignore_ascii_case(CONTENT_TYPE)
            {
                continue;
            }
            let value = line[CONTENT_TYPE.len()..].trim_ascii_start();
            if value.len() >= MULTIPART.len()
                && value[..MULTIPART.len()].eq_ignore_ascii_case(MULTIPART)
            {
                declarations += 1;
                if declarations > MAX_MULTIPART_DECLARATIONS {
                    return Err("This message has too many nested MIME containers.".into());
                }
            }
        } else if line.starts_with(b"--") {
            in_headers = true;
        }
    }
    Ok(())
}

pub(crate) fn parsed_addresses(value: Option<&mail_parser::Address<'_>>) -> Vec<String> {
    value
        .into_iter()
        .flat_map(|addresses| addresses.iter())
        .filter_map(|address| address.address.as_deref())
        .filter(|address| address.contains('@'))
        .map(ToOwned::to_owned)
        .collect()
}

pub(crate) fn attachment_id(
    filename: &str,
    content_id: Option<&str>,
    size: usize,
    index: usize,
) -> String {
    let digest = Sha256::digest(format!(
        "{}|{}|{size}|{index}",
        filename.to_ascii_lowercase(),
        content_id.unwrap_or_default().to_ascii_lowercase()
    ));
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn legacy_attachment_id(index: usize, filename: &str) -> String {
    let digest = Sha256::digest(format!("{index}:{filename}"));
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn normalize_rfc_message_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let inner = trimmed
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix('>'))
        .unwrap_or(trimmed)
        .trim();
    if inner.is_empty() {
        None
    } else {
        Some(format!("<{inner}>"))
    }
}
