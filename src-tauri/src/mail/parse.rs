use chrono::{DateTime, SecondsFormat, Utc};
use lettre::message::Mailbox;
use mail_parser::{MessageParser, MessagePart, MimeHeaders, PartType};
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
    let bcc = imap_addresses(envelope.bcc.as_deref());
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
        bcc,
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
        is_answered: false,
        is_forwarded: false,
        has_calendar: false,
        calendar_json: None,
        list_unsubscribe: None,
        list_unsubscribe_post: None,
        importance: importance_from_headers(
            &fetch.header().map(header_block_text).unwrap_or_default(),
        ),
        disposition_to: disposition_notification_address(
            &fetch.header().map(header_block_text).unwrap_or_default(),
        ),
    })
}

/// Attachment hint for the message list from the top-level Content-Type,
/// used instead of BODYSTRUCTURE: a hostile, deeply nested structure can make
/// the whole envelope batch unparseable. The downloaded body corrects it.
fn header_suggests_attachments(fetch: &async_imap::types::Fetch) -> bool {
    fetch.header().is_some_and(header_bytes_suggest_attachments)
}

pub(crate) fn header_bytes_top_media_type(raw: &[u8]) -> Option<String> {
    let text = header_block_text(raw);
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
    if media.is_empty() {
        None
    } else {
        Some(media)
    }
}

/// Signed/related/encrypted multiparts may hide attachments until the body is cached.
pub(crate) fn header_attachment_uncertain_for_search(
    header_media: Option<&str>,
    body_cached: bool,
) -> bool {
    !body_cached
        && header_media.is_some_and(|media| {
            matches!(
                media,
                "multipart/signed" | "multipart/related" | "multipart/encrypted"
            )
        })
}

fn header_bytes_suggest_attachments(raw: &[u8]) -> bool {
    let text = header_block_text(raw);
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
    thread_parent_from_header(fetch.header()?)
}

fn thread_parent_from_header(raw: &[u8]) -> Option<String> {
    let text = header_block_text(raw);
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

/// `\Answered` and `$Forwarded` (keywords are case-insensitive atoms).
pub(crate) fn reply_flags(item: &async_imap::types::Fetch) -> (bool, bool) {
    item.flags()
        .fold((false, false), |(answered, forwarded), flag| match flag {
            async_imap::types::Flag::Answered => (true, forwarded),
            async_imap::types::Flag::Custom(name) if name.eq_ignore_ascii_case("$Forwarded") => {
                (answered, true)
            }
            _ => (answered, forwarded),
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
    check_mime_limits(&message)?;
    let invite = calendar_invite(&message);
    let stored = Stored {
        text_body: message
            .body_text(0)
            .map(|body| body.into_owned())
            .unwrap_or_default(),
        html_body: message
            .body_html(0)
            .map(|body| crate::html_sanitize::sanitize_received_html(&body).html),
        preview: message
            .body_preview(180)
            .map(|body| body.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default(),
        attachments: message
            .attachments()
            .take(MAX_ATTACHMENTS)
            .enumerate()
            .map(|(index, part)| attachment_from_part(part, index, part.len() as u64))
            .collect(),
        has_calendar: invite.is_some() || has_calendar_part(&message),
        calendar_json: invite.and_then(|invite| serde_json::to_string(&invite).ok()),
        raw_message: raw.to_vec(),
        size: raw.len() as u64,
    };
    Ok(cached_message(
        uid,
        &message,
        raw,
        is_read,
        is_starred,
        fallback_received_at,
        stored,
    ))
}

/// Recreate full and prefix IDs from the exact full MIME message.
/// Prefix parsing uses the sender-declared size, or zero when it is absent.
pub(crate) fn attachment_id_variants(
    raw: &[u8],
) -> Result<(Vec<Attachment>, Vec<Attachment>), String> {
    validate_mime_resource_shape(raw)?;
    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| "A malformed message was skipped.".to_string())?;
    check_mime_limits(&message)?;
    let mut aliases = Vec::new();
    let mut current = Vec::new();
    for (index, part) in message.attachments().take(MAX_ATTACHMENTS).enumerate() {
        aliases.push(attachment_from_part(
            part,
            index,
            declared_attachment_size(part),
        ));
        current.push(attachment_from_part(part, index, part.len() as u64));
    }
    Ok((aliases, current))
}

/// Parse the first bytes of a large message. Returns `Ok(None)` when the
/// prefix cannot stand alone, so the caller fetches the whole message. Only
/// text and HTML parts that end inside the prefix are kept; attachments are
/// listed as metadata and never decoded, since a cut-off body is not a file.
pub(crate) fn parse_partial_message(
    uid: u32,
    prefix: &[u8],
    declared_size: u64,
    is_read: bool,
    is_starred: bool,
    fallback_received_at: Option<&str>,
) -> Result<Option<CachedMessage>, String> {
    validate_mime_resource_shape(prefix)?;
    if !has_blank_line(prefix) {
        return Ok(None);
    }
    let Some(message) = MessageParser::default().parse(prefix) else {
        return Ok(None);
    };
    check_mime_limits(&message)?;
    let top_is_mixed = message
        .part(0)
        .and_then(|part| part.content_type())
        .is_some_and(|value| {
            value.ctype().eq_ignore_ascii_case("multipart")
                && value
                    .subtype()
                    .is_some_and(|subtype| subtype.eq_ignore_ascii_case("mixed"))
        });
    if !top_is_mixed {
        return Ok(None);
    }
    let complete = |id: u32| {
        message
            .part(id)
            .is_some_and(|part| part_ends_inside(prefix, part))
    };
    let text = message
        .text_body
        .iter()
        .copied()
        .filter(|&id| complete(id))
        .find_map(|id| match &message.part(id)?.body {
            PartType::Text(text) => Some(text.to_string()),
            _ => None,
        });
    let html = message
        .html_body
        .iter()
        .copied()
        .filter(|&id| complete(id))
        .find_map(|id| match &message.part(id)?.body {
            PartType::Html(html) => Some(crate::html_sanitize::sanitize_received_html(html).html),
            _ => None,
        });
    if text.is_none() && html.is_none() {
        return Ok(None);
    }
    let invite = message
        .parts
        .iter()
        .enumerate()
        .filter(|(id, part)| is_calendar_part(part) && complete(*id as u32))
        .find_map(|(_, part)| super::ics::parse_invite(part.contents()));
    let has_calendar = message
        .parts
        .iter()
        .enumerate()
        .any(|(id, part)| is_calendar_part(part) && complete(id as u32));
    let attachments = message
        .attachments()
        .take(MAX_ATTACHMENTS)
        .enumerate()
        .map(|(index, part)| attachment_from_part(part, index, declared_attachment_size(part)))
        .collect();
    let stored = Stored {
        preview: text.as_deref().map(preview_of).unwrap_or_default(),
        text_body: text.unwrap_or_default(),
        html_body: html,
        attachments,
        has_calendar,
        calendar_json: invite.and_then(|invite| serde_json::to_string(&invite).ok()),
        raw_message: Vec::new(),
        size: declared_size,
    };
    Ok(Some(cached_message(
        uid,
        &message,
        prefix,
        is_read,
        is_starred,
        fallback_received_at,
        stored,
    )))
}

/// Body-derived fields from one parse, whether of a full message or a prefix.
struct Stored {
    text_body: String,
    html_body: Option<String>,
    preview: String,
    attachments: Vec<Attachment>,
    has_calendar: bool,
    calendar_json: Option<String>,
    raw_message: Vec<u8>,
    size: u64,
}

fn cached_message(
    uid: u32,
    message: &mail_parser::Message<'_>,
    headers_from: &[u8],
    is_read: bool,
    is_starred: bool,
    fallback_received_at: Option<&str>,
    stored: Stored,
) -> CachedMessage {
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
    let bcc = parsed_addresses(message.bcc());
    let reply_to = parsed_addresses(message.reply_to()).into_iter().next();
    let received_at = message
        .date()
        .and_then(|date| DateTime::<Utc>::from_timestamp(date.to_timestamp(), 0))
        .map(canonical_time)
        .or_else(|| fallback_received_at.map(ToOwned::to_owned))
        .unwrap_or_else(|| canonical_time(Utc::now()));
    let recipients = to
        .iter()
        .chain(cc.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let (list_unsubscribe, list_unsubscribe_post) = unsubscribe_headers(message);
    CachedMessage {
        internal_at: None,
        uid,
        message_id: message.message_id().and_then(normalize_rfc_message_id),
        subject: message.subject().unwrap_or_default().to_string(),
        sender_name,
        sender_address,
        recipients,
        received_at,
        preview: stored.preview,
        is_read,
        is_starred,
        size: stored.size,
        to,
        cc,
        bcc,
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
        text_body: stored.text_body,
        html_body: stored.html_body,
        has_attachments: !stored.attachments.is_empty(),
        attachments: stored.attachments,
        raw_message: stored.raw_message,
        is_answered: false,
        is_forwarded: false,
        has_calendar: stored.has_calendar,
        calendar_json: stored.calendar_json,
        list_unsubscribe,
        list_unsubscribe_post,
        importance: importance_from_headers(&header_block_text(headers_from)),
        disposition_to: disposition_notification_address(&header_block_text(headers_from)),
    }
}

fn check_mime_limits(message: &mail_parser::Message<'_>) -> Result<(), String> {
    if message.parts.len() > MAX_MIME_PARTS || message.attachment_count() > MAX_ATTACHMENTS {
        return Err("A message exceeded safe MIME limits and was skipped.".into());
    }
    Ok(())
}

/// A blank line ends the header block; without one the headers are cut short.
fn has_blank_line(raw: &[u8]) -> bool {
    raw.windows(2).any(|pair| pair == b"\n\n") || raw.windows(3).any(|run| run == b"\n\r\n")
}

/// True when the part's body ends at a boundary line inside `prefix`. A part
/// that runs to the end of the prefix may be cut short.
fn part_ends_inside(prefix: &[u8], part: &MessagePart<'_>) -> bool {
    let end = part.offset_end as usize;
    if end >= prefix.len() {
        return false;
    }
    let rest = &prefix[end..];
    let rest = rest
        .strip_prefix(b"\r\n")
        .or_else(|| rest.strip_prefix(b"\n"))
        .unwrap_or(rest);
    rest.starts_with(b"--") && rest.contains(&b'\n')
}

/// Size the sender declared in Content-Disposition, or 0. Never measured
/// from a prefix, so a cut-off attachment cannot report a false size.
fn declared_attachment_size(part: &MessagePart<'_>) -> u64 {
    part.content_disposition()
        .and_then(|disposition| disposition.attribute("size"))
        .and_then(|size| size.parse::<u64>().ok())
        .unwrap_or(0)
        .min(MAX_MESSAGE_BYTES as u64)
}

fn attachment_from_part(part: &MessagePart<'_>, index: usize, size: u64) -> Attachment {
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
        id: attachment_id(&filename, part.content_id(), size as usize, index),
        filename,
        content_type,
        size,
        content_id: part.content_id().map(ToOwned::to_owned),
        inline: part_is_inline(part),
    }
}

/// Plain-text preview: whitespace collapsed, at most 180 characters.
fn preview_of(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}

fn is_calendar_part(part: &mail_parser::MessagePart<'_>) -> bool {
    part.content_type().is_some_and(|value| {
        value.ctype().eq_ignore_ascii_case("text")
            && value
                .subtype()
                .is_some_and(|subtype| subtype.eq_ignore_ascii_case("calendar"))
    })
}

/// Inline or attached `text/calendar`, even when it fails to parse.
fn has_calendar_part(message: &mail_parser::Message<'_>) -> bool {
    message.parts.iter().any(is_calendar_part)
}

fn calendar_invite(message: &mail_parser::Message<'_>) -> Option<super::ics::CalendarInvite> {
    message
        .parts
        .iter()
        .filter(|part| is_calendar_part(part))
        .find_map(|part| super::ics::parse_invite(part.contents()))
}

/// Header block only (up to the first blank line, bounded), decoded lossily
/// so one stray non-UTF-8 byte in a body cannot drop header values.
pub(crate) fn header_block_text(raw: &[u8]) -> String {
    const HEADER_SCAN_LIMIT: usize = 64 * 1024;
    let head = &raw[..raw.len().min(HEADER_SCAN_LIMIT)];
    let end = [&b"\n\n"[..], &b"\n\r\n"[..]]
        .iter()
        .filter_map(|needle| {
            head.windows(needle.len())
                .position(|window| window == *needle)
        })
        .min()
        .map_or(head.len(), |pos| pos + 1);
    String::from_utf8_lossy(&head[..end]).into_owned()
}

/// `high`, `low`, or empty. Importance wins when it names one of those.
/// X-Priority, X-MSMail-Priority, and Priority fill in when it does not.
/// A value that is not exactly those words is ignored, including a folded
/// continuation that would smuggle another header.
pub(crate) fn importance_from_headers(raw: &str) -> String {
    let mut named = String::new();
    let mut priority = String::new();
    let mut current_name = String::new();
    let mut current_value = String::new();
    for line in raw.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.starts_with(' ') || line.starts_with('\t') {
            if !current_name.is_empty() {
                current_value.push(' ');
                current_value.push_str(line.trim());
            }
            continue;
        }
        if !current_name.is_empty() {
            note_importance(&current_name, &current_value, &mut named, &mut priority);
        }
        if line.is_empty() {
            current_name.clear();
            current_value.clear();
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            current_name.clear();
            current_value.clear();
            continue;
        };
        current_name = name.trim().to_string();
        current_value = value.trim().to_string();
    }
    if !current_name.is_empty() {
        note_importance(&current_name, &current_value, &mut named, &mut priority);
    }
    if named == "high" || named == "low" {
        named
    } else if priority == "high" || priority == "low" {
        priority
    } else {
        String::new()
    }
}

fn note_importance(name: &str, value: &str, named: &mut String, priority: &mut String) {
    if named.is_empty() && name.eq_ignore_ascii_case("importance") {
        *named = crate::models::canonical_importance(value).to_string();
    } else if priority.is_empty() && name.eq_ignore_ascii_case("x-priority") {
        *priority = x_priority_importance(value).to_string();
    } else if priority.is_empty() && name.eq_ignore_ascii_case("x-msmail-priority") {
        *priority = crate::models::canonical_importance(value).to_string();
    } else if priority.is_empty() && name.eq_ignore_ascii_case("priority") {
        *priority = priority_word_importance(value).to_string();
    }
}

/// One Disposition-Notification-To mailbox, or empty.
pub(crate) fn disposition_notification_address(raw: &str) -> String {
    let Some(value) = first_header_value(raw, "disposition-notification-to") else {
        return String::new();
    };
    if value.contains(',') {
        return String::new();
    }
    parse_mailbox(value.trim())
        .ok()
        .and_then(|mailbox| crate::models::receipt_mailbox(mailbox.email.as_ref()))
        .unwrap_or_default()
}

fn first_header_value(raw: &str, field: &str) -> Option<String> {
    let mut current_name = String::new();
    let mut current_value = String::new();
    let mut found = None;
    for line in raw.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.starts_with(' ') || line.starts_with('\t') {
            if !current_name.is_empty() {
                current_value.push(' ');
                current_value.push_str(line.trim());
            }
            continue;
        }
        if found.is_none() && current_name.eq_ignore_ascii_case(field) {
            found = Some(std::mem::take(&mut current_value));
        }
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            current_name.clear();
            current_value.clear();
            continue;
        };
        current_name = name.trim().to_string();
        current_value = value.trim().to_string();
    }
    if found.is_none() && current_name.eq_ignore_ascii_case(field) {
        found = Some(current_value);
    }
    found
}

fn x_priority_importance(value: &str) -> &'static str {
    match value.trim().chars().next() {
        Some('1' | '2') => "high",
        Some('4' | '5') => "low",
        _ => "",
    }
}

fn priority_word_importance(value: &str) -> &'static str {
    let word = value.trim().to_ascii_lowercase();
    if word == "non-urgent" {
        "low"
    } else if word == "urgent" {
        "high"
    } else {
        ""
    }
}

/// Bounded List-Unsubscribe headers; see `list_unsubscribe`.
fn unsubscribe_headers(message: &mail_parser::Message<'_>) -> (Option<String>, Option<String>) {
    let mut list = None;
    let mut post = None;
    for (name, value) in message.headers_raw() {
        if list.is_none() && name.eq_ignore_ascii_case("list-unsubscribe") {
            list = super::list_unsubscribe::normalize_list_unsubscribe(value);
        } else if post.is_none() && name.eq_ignore_ascii_case("list-unsubscribe-post") {
            post = super::list_unsubscribe::normalize_post(value);
        }
    }
    (list, post)
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

/// Normalizes a Message-ID to `<id>`, or None when it is unsafe for IMAP.
pub(crate) fn normalize_rfc_message_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() > 998 {
        return None;
    }
    let inner = trimmed
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix('>'))
        .unwrap_or(trimmed)
        .trim();
    if inner.is_empty()
        || inner.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '<' | '>' | '"')
        })
    {
        None
    } else {
        Some(format!("<{inner}>"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        importance_from_headers, normalize_rfc_message_id, parse_message, parse_partial_message,
    };
    use crate::db::CachedMessage;

    // Failure modes for normalize_rfc_message_id:
    // 1. CR or LF inside the id would inject IMAP/SMTP lines.
    // 2. Whitespace inside the id breaks the single-token header value.
    // 3. Other control characters (NUL, tab) reach raw IMAP SEARCH.
    // 4. Inner `<` or `>` produce a malformed msg-id.
    // 5. A double quote would break the quoted IMAP SEARCH string.
    // 6. Ids over 998 bytes exceed the RFC 5322 line limit.
    // 7. Empty or bracket-only input must not yield "<>".
    // 8. Normal ids, bracketed or bare, must keep working.
    #[test]
    fn normalize_rejects_unsafe_message_ids() {
        let long = format!("<{}@example.com>", "a".repeat(999));
        for bad in [
            "<one@example.com>\r\nA1 LOGOUT",
            "<one@example.com>\nX",
            "<one\r@example.com>",
            "<one @example.com>",
            "one two@example.com",
            "<one\u{0}@example.com>",
            "<one\t@example.com>",
            "<one<x>@example.com>",
            "<one\"@example.com>",
            long.as_str(),
            "",
            "<>",
        ] {
            assert_eq!(normalize_rfc_message_id(bad), None, "accepted {bad:?}");
        }
    }

    #[test]
    fn normalize_keeps_normal_message_ids() {
        assert_eq!(
            normalize_rfc_message_id("<abc.123@mail.example.com>").as_deref(),
            Some("<abc.123@mail.example.com>")
        );
        assert_eq!(
            normalize_rfc_message_id("  abc@example.com  ").as_deref(),
            Some("<abc@example.com>")
        );
        let edge = format!("<{}@example.com>", "a".repeat(900));
        assert_eq!(
            normalize_rfc_message_id(&edge).as_deref(),
            Some(edge.as_str())
        );
    }

    #[test]
    fn importance_reads_standard_and_priority_headers() {
        assert_eq!(
            importance_from_headers("Importance: high\r\n\r\nHi"),
            "high"
        );
        assert_eq!(
            importance_from_headers("X-Priority: 5 (Lowest)\r\n\r\nHi"),
            "low"
        );
        assert_eq!(
            importance_from_headers("X-MSMail-Priority: High\r\n\r\nHi"),
            "high"
        );
        assert_eq!(
            importance_from_headers("Priority: urgent\r\n\r\nHi"),
            "high"
        );
        assert_eq!(
            importance_from_headers("Priority: non-urgent\r\n\r\nHi"),
            "low"
        );
        assert_eq!(
            importance_from_headers("Importance: normal\r\nX-Priority: 3\r\n\r\nHi"),
            ""
        );
        assert_eq!(
            importance_from_headers("Importance: low\r\nX-Priority: 1\r\n\r\nHi"),
            "low"
        );
        assert_eq!(
            importance_from_headers("Importance: high\r\n Bcc: evil@example.com\r\n\r\nHi"),
            ""
        );
        assert_eq!(importance_from_headers("Subject: Hello\r\n\r\nHi"), "");
    }

    #[test]
    fn disposition_notification_keeps_one_mailbox() {
        assert_eq!(
            super::disposition_notification_address(
                "Disposition-Notification-To: Jane <Jane@Example.com>\r\n\r\nHi"
            ),
            "jane@example.com"
        );
        assert_eq!(
            super::disposition_notification_address(
                "Disposition-Notification-To: jane@example.com, lee@example.com\r\n\r\nHi"
            ),
            ""
        );
        assert_eq!(
            super::disposition_notification_address(
                "Disposition-Notification-To: jane@example.com\r\n Bcc: evil@example.com\r\n\r\nHi"
            ),
            ""
        );
        assert_eq!(
            super::disposition_notification_address("Subject: Hello\r\n\r\nHi"),
            ""
        );
    }

    #[test]
    fn header_flags_survive_non_utf8_bytes() {
        // Ways this can fail: a body byte drops importance or receipts, a non-UTF-8
        // byte in an earlier header hides a later one, or a folded line adds a header.
        let body = b"From: Jane <jane@example.com>\r\nSubject: Picnic\r\nImportance: high\r\nDisposition-Notification-To: jane@example.com\r\n\r\nHi \xff\xfe body";
        let message = parse_message(1, body, false, false, None).unwrap();
        assert_eq!(message.importance, "high");
        assert_eq!(message.disposition_to, "jane@example.com");

        let header = b"Subject: caf\xe9\r\nImportance: low\r\nDisposition-Notification-To: jane@example.com\r\n\r\nHi";
        let text = super::header_block_text(header);
        assert_eq!(importance_from_headers(&text), "low");
        assert_eq!(
            super::disposition_notification_address(&text),
            "jane@example.com"
        );

        let smuggled = b"Subject: caf\xe9\r\nImportance: high\r\n Bcc: evil@example.com\r\n\r\nHi";
        assert_eq!(
            importance_from_headers(&super::header_block_text(smuggled)),
            ""
        );
    }

    #[test]
    fn threading_and_attachment_hints_survive_non_utf8_headers() {
        // Ways this can fail: a stray byte drops In-Reply-To or References, the
        // attachment hint is lost, or an invalid byte turns into a fake parent.
        let raw = b"Subject: caf\xe9\r\nIn-Reply-To: <parent@example.com>\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n";
        assert_eq!(
            super::thread_parent_from_header(raw).as_deref(),
            Some("<parent@example.com>")
        );
        assert!(super::header_bytes_suggest_attachments(raw));
        let plain = b"Subject: caf\xe9\r\nContent-Type: text/plain\r\n\r\n";
        assert!(!super::header_bytes_suggest_attachments(plain));
        assert_eq!(super::thread_parent_from_header(plain), None);
        let signed = b"Content-Type: multipart/signed; boundary=x\r\n\r\n";
        assert!(!super::header_bytes_suggest_attachments(signed));
        assert_eq!(
            super::header_bytes_top_media_type(signed).as_deref(),
            Some("multipart/signed")
        );
        assert!(super::header_attachment_uncertain_for_search(
            Some("multipart/signed"),
            false
        ));
        assert!(!super::header_attachment_uncertain_for_search(
            Some("multipart/signed"),
            true
        ));
    }

    #[test]
    fn bcc_stays_out_of_the_visible_recipient_list() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: sam@example.com\r\nCc: copy@example.com\r\nBcc: hidden@example.com\r\nSubject: Picnic\r\n\r\nHi\r\n";
        let message = parse_message(1, raw, false, false, None).unwrap();
        assert_eq!(message.to, vec!["sam@example.com"]);
        assert_eq!(message.cc, vec!["copy@example.com"]);
        assert_eq!(message.bcc, vec!["hidden@example.com"]);
        assert!(!message.recipients.contains("hidden@example.com"));
    }

    const PARTIAL_HEAD: &str = "From: Jane <jane@example.com>\r\nTo: sam@example.com\r\nSubject: Big picnic\r\nMessage-ID: <big@example.com>\r\nDate: Tue, 04 Aug 2026 10:00:00 +0000\r\n";
    const DECLARED: u64 = 2_000_000;

    fn mixed_message(parts: &str) -> Vec<u8> {
        format!("{PARTIAL_HEAD}Content-Type: multipart/mixed; boundary=\"bnd\"\r\n\r\n{parts}")
            .into_bytes()
    }

    fn partial(prefix: &[u8]) -> Result<Option<CachedMessage>, String> {
        parse_partial_message(7, prefix, DECLARED, true, false, None)
    }

    fn text_part(body: &str) -> String {
        format!("--bnd\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n")
    }

    fn html_part(body: &str) -> String {
        format!("--bnd\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{body}\r\n")
    }

    fn attachment_part(data: &str) -> String {
        format!(
            "--bnd\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{data}\r\n"
        )
    }

    /// Index just past the first occurrence of `marker`.
    fn cut_after(raw: &[u8], marker: &[u8]) -> usize {
        raw.windows(marker.len())
            .position(|window| window == marker)
            .expect("marker present")
            + marker.len()
    }

    // Failure modes for partial bodies (a prefix of a large message):
    // 1. A half-downloaded base64 attachment is decoded or stored.
    // 2. A cut-off attachment disappears from the list instead of showing as metadata.
    #[test]
    fn partial_keeps_text_and_lists_truncated_attachment_as_metadata() {
        let data = "QUJD\r\n".repeat(4000);
        let raw = mixed_message(&format!(
            "{}{}--bnd--\r\n",
            text_part("Hello Jane"),
            attachment_part(&data)
        ));
        let cut = cut_after(&raw, b"QUJD\r\nQUJD\r\n");
        let message = partial(&raw[..cut]).unwrap().unwrap();
        assert_eq!(message.text_body, "Hello Jane");
        assert_eq!(message.html_body, None);
        assert!(message.raw_message.is_empty());
        assert_eq!(message.size, DECLARED);
        assert_eq!(message.attachments.len(), 1);
        assert_eq!(message.attachments[0].filename, "report.pdf");
        assert_eq!(message.attachments[0].content_type, "application/pdf");
        assert_eq!(message.attachments[0].size, 0);
    }

    // Failure modes for header truncation:
    // 1. A prefix ending inside the header block stores missing headers.
    // 2. A prefix that ends right before the blank line is accepted.
    #[test]
    fn partial_header_block_cut_short_falls_back() {
        let raw = mixed_message(&format!("{}--bnd--\r\n", text_part("Hello")));
        assert!(partial(&raw[..PARTIAL_HEAD.len() / 2]).unwrap().is_none());
        let end_of_headers = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        assert!(partial(&raw[..end_of_headers]).unwrap().is_none());
    }

    // Failure modes for UTF-8 splits:
    // 1. A prefix ending inside a multibyte sequence decodes to U+FFFD.
    // 2. A truncated text part is stored as if it were complete.
    #[test]
    fn prefix_inside_a_multibyte_character_never_yields_replacement_characters() {
        let raw = mixed_message(&format!(
            "{}{}--bnd--\r\n",
            text_part("Grüße aus München"),
            html_part("<p>Grüße aus München</p>")
        ));
        let cut = cut_after(&raw, "<p>Grü".as_bytes()) + 1;
        let message = partial(&raw[..cut]).unwrap().unwrap();
        assert_eq!(message.text_body, "Grüße aus München");
        assert_eq!(message.html_body, None);
        assert!(!message.text_body.contains('\u{FFFD}'));

        let cut = cut_after(&raw, "Grü".as_bytes()) + 1;
        assert!(partial(&raw[..cut]).unwrap().is_none());
    }

    // Failure modes for truncated HTML:
    // 1. A cut-off HTML part is rendered in place of the complete text part.
    // 2. A cut-off HTML part with no complete text is stored instead of a full fetch.
    #[test]
    fn truncated_html_is_dropped_and_complete_text_is_kept() {
        let raw = mixed_message(&format!(
            "{}{}--bnd--\r\n",
            text_part("Plain copy"),
            html_part(&"<p>long</p>".repeat(100))
        ));
        let cut = cut_after(&raw, b"<p>long</p><p>lo");
        let message = partial(&raw[..cut]).unwrap().unwrap();
        assert_eq!(message.text_body, "Plain copy");
        assert_eq!(message.html_body, None);

        let html_only = mixed_message(&format!("{}--bnd--\r\n", html_part(&"<p>x</p>".repeat(50))));
        let cut = cut_after(&html_only, b"<p>x</p><p>x</p>");
        assert!(partial(&html_only[..cut]).unwrap().is_none());
    }

    #[test]
    fn complete_html_part_is_kept_sanitized() {
        let raw = mixed_message(&format!(
            "{}{}--bnd--\r\n",
            text_part("Plain"),
            html_part("<p onclick=\"x()\">Hi</p><script>bad()</script>")
        ));
        let message = partial(&raw).unwrap().unwrap();
        let html = message.html_body.expect("complete html kept");
        assert!(html.contains("Hi"));
        assert!(!html.contains("script"));
        assert!(!html.contains("onclick"));
    }

    // Failure modes for the top-level shape:
    // 1. A multipart/alternative or plain prefix is stored with an unknown tail.
    #[test]
    fn only_multipart_mixed_is_accepted_for_partial_bodies() {
        let alternative = format!(
            "{PARTIAL_HEAD}Content-Type: multipart/alternative; boundary=\"bnd\"\r\n\r\n{}{}--bnd--\r\n",
            text_part("Plain"),
            html_part("<p>Hi</p>")
        );
        assert!(partial(alternative.as_bytes()).unwrap().is_none());
        let plain =
            format!("{PARTIAL_HEAD}Content-Type: text/plain\r\n\r\nHello there, a long body.\r\n");
        assert!(partial(plain.as_bytes()).unwrap().is_none());
    }

    // Failure modes for the nesting limit:
    // 1. A partial prefix with a hostile container tree skips the cap.
    #[test]
    fn partial_bodies_keep_the_nesting_limit() {
        let nested = "--bnd\r\nContent-Type: multipart/mixed; boundary=\"bnd\"\r\n\r\n".repeat(70);
        assert!(partial(&mixed_message(&nested)).is_err());
    }

    // Attachments without a declared size change IDs when full parsing learns
    // the decoded length; command tests cover resolution against that part.
    #[test]
    fn partial_attachment_id_changes_after_full_fetch_without_declared_size() {
        let data = "QUJD\r\n".repeat(4000);
        let raw = mixed_message(&format!(
            "{}{}--bnd--\r\n",
            text_part("Hello Jane"),
            attachment_part(&data)
        ));
        let cut = cut_after(&raw, b"QUJD\r\nQUJD\r\n");
        let partial = partial(&raw[..cut]).unwrap().unwrap();
        let full = parse_message(7, &raw, true, false, None).unwrap();
        assert_eq!(
            partial.attachments[0].filename,
            full.attachments[0].filename
        );
        assert_ne!(
            partial.attachments[0].id, full.attachments[0].id,
            "decoded size participates in the full attachment ID"
        );
    }
}
