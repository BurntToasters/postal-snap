use std::{path::Path, time::Duration};

use async_imap::{extensions::idle::IdleResponse, Session};
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lettre::{
    address::Envelope,
    message::{
        header::ContentType, Attachment as LettreAttachment, Mailbox, MultiPart, SinglePart,
    },
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use mail_parser::{MessageParser, MimeHeaders};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_native_tls::TlsStream;

use crate::{
    db::{CachedMessage, Database},
    models::{
        mailbox_role, AccountRecord, AccountSetupRequest, Attachment, CachePolicy, ComposeDraft,
        MessageSummary, ProviderKind, SearchQuery, ServerConfig, TlsMode,
    },
    security::{redact_error, safe_filename},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
pub const MAX_MESSAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_MIME_PARTS: usize = 500;
const MAX_MULTIPART_DECLARATIONS: usize = 64;
const MAX_ATTACHMENTS: usize = 100;
pub const MAX_OUTGOING_BYTES: usize = 100 * 1024 * 1024;
const INITIAL_MESSAGE_BATCH: u32 = 150;
const BACKFILL_MESSAGE_BATCH: u32 = 75;

type ImapSession = Session<TlsStream<TcpStream>>;

pub struct PreparedMessage {
    pub message_id: String,
    pub bytes: Vec<u8>,
}

pub struct RemoteDraftLocation {
    pub uid: u32,
    pub uid_validity: Option<u32>,
}

pub struct RemoteDraftAttachment {
    pub filename: String,
    pub content_type: String,
    pub inline: bool,
    pub content_id: Option<String>,
    pub bytes: Vec<u8>,
}

pub struct RemoteDraftData {
    pub uid: u32,
    pub message_id: Option<String>,
    pub updated_at: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html_body: String,
    pub text_body: String,
    pub in_reply_to: Option<String>,
    pub references: Option<Vec<String>>,
    pub attachments: Vec<RemoteDraftAttachment>,
}

pub struct RemoteDraftSnapshot {
    pub uid_validity: Option<u32>,
    pub uids: Vec<u32>,
    pub drafts: Vec<RemoteDraftData>,
}

pub async fn test_account(
    request: &AccountSetupRequest,
    imap: &ServerConfig,
    smtp: &ServerConfig,
    password: &str,
) -> Result<(ServerConfig, ServerConfig), String> {
    let tested_imap = test_imap_with_icloud_fallback(request, imap, password).await?;
    test_smtp(smtp, &request.email, password).await?;
    Ok((tested_imap, smtp.clone()))
}

async fn test_imap_with_icloud_fallback(
    request: &AccountSetupRequest,
    imap: &ServerConfig,
    password: &str,
) -> Result<ServerConfig, String> {
    match connect_imap(imap, password).await {
        Ok(mut session) => {
            let _ = session.logout().await;
            Ok(imap.clone())
        }
        Err(first_error)
            if request.provider == ProviderKind::Icloud && imap.username != request.email =>
        {
            let mut fallback = imap.clone();
            fallback.username = request.email.to_lowercase();
            match connect_imap(&fallback, password).await {
                Ok(mut session) => {
                    let _ = session.logout().await;
                    Ok(fallback)
                }
                Err(_) => Err(first_error),
            }
        }
        Err(error) => Err(error),
    }
}

pub async fn sync_account(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let cutoff = (policy.mode == "recent")
        .then(|| Utc::now() - chrono::Duration::days(i64::from(policy.days)));
    let names = session
        .list(None, Some("*"))
        .await
        .map_err(|error| redact_error(&error, "Mailbox discovery"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|error| redact_error(&error, "Mailbox discovery"))?;
    let mut server_mailboxes = std::collections::HashSet::new();

    for name in names {
        let mailbox_name = name.name().to_string();
        let attributes = name
            .attributes()
            .iter()
            .map(|attribute| format!("{attribute:?}"))
            .collect::<Vec<_>>();
        if attributes
            .iter()
            .any(|attribute| attribute.eq_ignore_ascii_case("NoSelect"))
        {
            continue;
        }
        server_mailboxes.insert(mailbox_name.clone());
        let role = mailbox_role(&mailbox_name, &attributes);
        let status = session
            .status(&mailbox_name, "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)")
            .await
            .map_err(|error| redact_error(&error, "Mailbox status"))?;
        let selected = session
            .examine(&mailbox_name)
            .await
            .map_err(|error| redact_error(&error, "Mailbox sync"))?;
        let mailbox_id = db.upsert_mailbox(
            &account.summary.id,
            &mailbox_name,
            &role,
            selected.uid_validity,
            selected.uid_next,
            status.unseen,
            status.exists,
        )?;
        let max_uid = db.max_uid(mailbox_id)?;
        let newest_uid = newest_uid(&mut session, selected.exists).await?;
        if let Some(newest_uid) = newest_uid {
            if max_uid == 0 {
                let start = newest_uid
                    .saturating_sub(INITIAL_MESSAGE_BATCH.saturating_sub(1))
                    .max(1);
                cache_uid_range(
                    &mut session,
                    db,
                    &account.summary.id,
                    mailbox_id,
                    &format!("{start}:*"),
                    cutoff.as_ref(),
                )
                .await?;
                db.set_backfill_cursor(mailbox_id, start.saturating_sub(1))?;
            } else if newest_uid > max_uid {
                cache_uid_range(
                    &mut session,
                    db,
                    &account.summary.id,
                    mailbox_id,
                    &format!("{}:*", max_uid.saturating_add(1)),
                    cutoff.as_ref(),
                )
                .await?;
            }
        } else {
            db.set_backfill_cursor(mailbox_id, 0)?;
        }

        let cursor = match db.backfill_cursor(mailbox_id)? {
            Some(cursor) => cursor,
            None => db
                .min_uid(mailbox_id)?
                .map(|uid| uid.saturating_sub(1))
                .unwrap_or(0),
        };
        if cursor > 0 {
            let start = cursor
                .saturating_sub(BACKFILL_MESSAGE_BATCH.saturating_sub(1))
                .max(1);
            let outcome = cache_uid_range(
                &mut session,
                db,
                &account.summary.id,
                mailbox_id,
                &format!("{start}:{cursor}"),
                cutoff.as_ref(),
            )
            .await?;
            let next_cursor = if start == 1 || outcome.older_than_cutoff {
                0
            } else {
                start - 1
            };
            db.set_backfill_cursor(mailbox_id, next_cursor)?;
        }
        for chunk in db.cached_uids(mailbox_id)?.chunks(250) {
            if chunk.is_empty() {
                continue;
            }
            let requested = chunk.to_vec();
            let set = chunk
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let flag_rows = session
                .uid_fetch(set, "(UID FLAGS)")
                .await
                .map_err(|error| redact_error(&error, "Flag sync"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Flag sync"))?;
            let seen = flag_rows
                .into_iter()
                .filter_map(|item| {
                    item.uid.map(|uid| {
                        let flags = item
                            .flags()
                            .map(|flag| format!("{flag:?}"))
                            .collect::<Vec<_>>()
                            .join(" ")
                            .to_ascii_lowercase();
                        (uid, flags.contains("seen"), flags.contains("flagged"))
                    })
                })
                .collect::<Vec<_>>();
            db.reconcile_flags(mailbox_id, &seen, &requested)?;
        }
    }
    db.reconcile_mailboxes(&account.summary.id, &server_mailboxes)?;
    let _ = session.logout().await;
    db.evict_to_policy(policy)?;
    Ok(())
}

struct FetchOutcome {
    older_than_cutoff: bool,
}

async fn newest_uid(session: &mut ImapSession, exists: u32) -> Result<Option<u32>, String> {
    if exists == 0 {
        return Ok(None);
    }
    let rows = session
        .fetch(exists.to_string(), "(UID)")
        .await
        .map_err(|error| redact_error(&error, "Mailbox cursor"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|error| redact_error(&error, "Mailbox cursor"))?;
    Ok(rows.into_iter().find_map(|item| item.uid))
}

async fn cache_uid_range(
    session: &mut ImapSession,
    db: &Database,
    account_id: &str,
    mailbox_id: i64,
    range: &str,
    cutoff: Option<&DateTime<Utc>>,
) -> Result<FetchOutcome, String> {
    let mut fetched = session
        .uid_fetch(range, "(UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE)")
        .await
        .map_err(|error| redact_error(&error, "Message list download"))?;
    let mut older_than_cutoff = false;
    while let Some(item) = fetched
        .try_next()
        .await
        .map_err(|error| redact_error(&error, "Message list download"))?
    {
        let flags = item
            .flags()
            .map(|flag| format!("{flag:?}"))
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        let Ok(parsed) = parse_envelope(&item, flags.contains("seen"), flags.contains("flagged"))
        else {
            continue;
        };
        older_than_cutoff |= cutoff.is_some_and(|cutoff| {
            DateTime::parse_from_rfc3339(&parsed.received_at)
                .map(|received| received.with_timezone(&Utc) < *cutoff)
                .unwrap_or(false)
        });
        db.upsert_envelope(account_id, mailbox_id, &parsed)?;
    }
    Ok(FetchOutcome { older_than_cutoff })
}

pub async fn idle_inbox(
    account: &AccountRecord,
    password: &str,
    wake: &Notify,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let capabilities = session
        .capabilities()
        .await
        .map_err(|error| redact_error(&error, "IMAP capability check"))?;
    if !capabilities.has_str("IDLE") {
        let _ = session.logout().await;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(120)) => {},
            _ = wake.notified() => {},
        }
        return Ok(());
    }
    session
        .select("INBOX")
        .await
        .map_err(|error| redact_error(&error, "Inbox monitoring"))?;
    let mut idle = session.idle();
    idle.init()
        .await
        .map_err(|error| redact_error(&error, "Inbox monitoring"))?;
    let response = {
        let (wait, interrupt) = idle.wait_with_timeout(Duration::from_secs(120));
        tokio::pin!(wait);
        tokio::select! {
            result = &mut wait => result.map_err(|error| redact_error(&error, "Inbox monitoring"))?,
            _ = wake.notified() => {
                drop(interrupt);
                wait.as_mut().await.map_err(|error| redact_error(&error, "Inbox monitoring"))?
            },
        }
    };
    let mut session = idle
        .done()
        .await
        .map_err(|error| redact_error(&error, "Inbox monitoring"))?;
    let _ = session.logout().await;
    match response {
        IdleResponse::ManualInterrupt | IdleResponse::Timeout | IdleResponse::NewData(_) => Ok(()),
    }
}

pub async fn server_search(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    query: &SearchQuery,
) -> Result<Vec<MessageSummary>, String> {
    let mailboxes = if query.all_folders {
        db.list_mailboxes(&account.summary.id)?
            .into_iter()
            .map(|mailbox| (mailbox.id, mailbox.name))
            .collect::<Vec<_>>()
    } else if let Some(id) = query.mailbox_id {
        let (account_id, name) = db.mailbox(id)?;
        if account_id != account.summary.id {
            return Err("Mailbox does not belong to this account.".into());
        }
        vec![(id, name)]
    } else {
        Vec::new()
    };
    let search_text = query
        .text
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    if search_text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut session = connect_imap(&account.imap, password).await?;
    let mut results = Vec::new();
    for (mailbox_id, name) in mailboxes {
        session
            .examine(&name)
            .await
            .map_err(|error| redact_error(&error, "Server search"))?;
        let mut uids = session
            .uid_search(format!("TEXT \"{search_text}\""))
            .await
            .map_err(|error| redact_error(&error, "Server search"))?
            .into_iter()
            .collect::<Vec<_>>();
        uids.sort_unstable_by(|left, right| right.cmp(left));
        uids.truncate(query.limit.min(500) as usize);
        if uids.is_empty() {
            continue;
        }
        let set = uids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let fetched = session
            .uid_fetch(set, "(UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE)")
            .await
            .map_err(|error| redact_error(&error, "Server search"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Server search"))?;
        for item in fetched {
            let flags = item
                .flags()
                .map(|flag| format!("{flag:?}"))
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_lowercase();
            let Ok(parsed) =
                parse_envelope(&item, flags.contains("seen"), flags.contains("flagged"))
            else {
                continue;
            };
            db.upsert_envelope(&account.summary.id, mailbox_id, &parsed)?;
            if let Some(summary) = db.message_summary_by_uid(mailbox_id, parsed.uid)? {
                results.push(summary);
            }
        }
    }
    let _ = session.logout().await;
    results.sort_by(|left, right| {
        right
            .received_at
            .cmp(&left.received_at)
            .then_with(|| right.uid.cmp(&left.uid))
    });
    results.dedup_by_key(|message| (message.mailbox_id, message.uid));
    results.truncate(query.limit.min(500) as usize);
    Ok(results)
}

pub async fn download_message(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    expected_size: u64,
) -> Result<CachedMessage, String> {
    if expected_size > MAX_MESSAGE_BYTES as u64 {
        return Err("This message is too large to download safely.".into());
    }
    let mut session = connect_imap(&account.imap, password).await?;
    session
        .examine(mailbox)
        .await
        .map_err(|error| redact_error(&error, "Message download"))?;
    let mut rows = session
        .uid_fetch(uid.to_string(), "(UID FLAGS RFC822.SIZE BODY.PEEK[])")
        .await
        .map_err(|error| redact_error(&error, "Message download"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|error| redact_error(&error, "Message download"))?;
    let item = rows
        .pop()
        .ok_or_else(|| "This message is no longer available on the server.".to_string())?;
    let raw = item
        .body()
        .ok_or_else(|| "The mail server did not return this message.".to_string())?;
    if raw.len() > MAX_MESSAGE_BYTES {
        return Err("This message is too large to download safely.".into());
    }
    let flags = item
        .flags()
        .map(|flag| format!("{flag:?}"))
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let parsed = parse_message(uid, raw, flags.contains("seen"), flags.contains("flagged"))?;
    let _ = session.logout().await;
    Ok(parsed)
}

pub async fn set_remote_flags(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    is_read: Option<bool>,
    is_starred: Option<bool>,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    session
        .select(mailbox)
        .await
        .map_err(|error| redact_error(&error, "Message update"))?;
    if let Some(value) = is_read {
        let operation = if value {
            "+FLAGS.SILENT (\\Seen)"
        } else {
            "-FLAGS.SILENT (\\Seen)"
        };
        session
            .uid_store(uid.to_string(), operation)
            .await
            .map_err(|error| redact_error(&error, "Message update"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Message update"))?;
    }
    if let Some(value) = is_starred {
        let operation = if value {
            "+FLAGS.SILENT (\\Flagged)"
        } else {
            "-FLAGS.SILENT (\\Flagged)"
        };
        session
            .uid_store(uid.to_string(), operation)
            .await
            .map_err(|error| redact_error(&error, "Message update"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Message update"))?;
    }
    let _ = session.logout().await;
    Ok(())
}

pub async fn move_remote(
    account: &AccountRecord,
    password: &str,
    source: &str,
    destination: &str,
    uid: u32,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    session
        .select(source)
        .await
        .map_err(|error| redact_error(&error, "Move"))?;
    let capabilities = session
        .capabilities()
        .await
        .map_err(|error| redact_error(&error, "Move capability check"))?;
    if capabilities.has_str("MOVE") {
        session
            .uid_mv(uid.to_string(), destination)
            .await
            .map_err(|error| redact_error(&error, "Move"))?;
    } else if capabilities.has_str("UIDPLUS") {
        session
            .uid_copy(uid.to_string(), destination)
            .await
            .map_err(|error| redact_error(&error, "Move"))?;
        session
            .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
            .await
            .map_err(|error| redact_error(&error, "Move"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Move"))?;
        session
            .uid_expunge(uid.to_string())
            .await
            .map_err(|error| redact_error(&error, "Move"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Move"))?;
    } else {
        return Err("This mail server cannot safely move messages.".into());
    }
    let _ = session.logout().await;
    Ok(())
}

pub async fn prepare_message(
    account: &AccountRecord,
    draft: &ComposeDraft,
) -> Result<PreparedMessage, String> {
    let message_id = format!("<{}@run.rosie.snap>", uuid::Uuid::new_v4());
    let message = build_message_with_id(account, draft, &message_id, false).await?;
    Ok(PreparedMessage {
        message_id,
        bytes: message.formatted(),
    })
}

pub async fn prepare_draft_message(
    account: &AccountRecord,
    draft: &ComposeDraft,
    message_id: &str,
) -> Result<Vec<u8>, String> {
    Ok(build_message_with_id(account, draft, message_id, true)
        .await?
        .formatted())
}

pub async fn send_prepared(
    account: &AccountRecord,
    password: &str,
    draft: &ComposeDraft,
    bytes: &[u8],
) -> Result<(), String> {
    let envelope = message_envelope(account, draft)?;
    let transport = smtp_transport(&account.smtp, password)?;
    transport
        .send_raw(&envelope, bytes)
        .await
        .map_err(|error| redact_error(&error, "Send"))?;
    Ok(())
}

pub async fn ensure_sent_copy(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    message_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    session
        .select(mailbox)
        .await
        .map_err(|error| redact_error(&error, "Sent folder"))?;
    let existing = search_message_id(&mut session, message_id, "Sent folder").await?;
    if existing.is_empty() {
        session
            .append(mailbox, Some("(\\Seen)"), None, bytes)
            .await
            .map_err(|error| redact_error(&error, "Save Sent copy"))?;
        session
            .select(mailbox)
            .await
            .map_err(|error| redact_error(&error, "Sent folder"))?;
        if search_message_id(&mut session, message_id, "Sent folder")
            .await?
            .is_empty()
        {
            return Err("The message was sent, but its Sent copy could not be confirmed.".into());
        }
    }
    let _ = session.logout().await;
    Ok(())
}

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
    let selected = session
        .select(mailbox)
        .await
        .map_err(|error| redact_error(&error, "Draft synchronization"))?;
    let capabilities = session
        .capabilities()
        .await
        .map_err(|error| redact_error(&error, "Draft synchronization"))?;
    if previous_uid.is_some() && !capabilities.has_str("UIDPLUS") {
        return Err("This mail server cannot safely replace synchronized drafts.".into());
    }
    let mut matching = search_message_id(&mut session, message_id, "Draft synchronization").await?;
    if matching.is_empty() {
        session
            .append(mailbox, Some("(\\Draft)"), None, bytes)
            .await
            .map_err(|error| redact_error(&error, "Draft upload"))?;
        session
            .select(mailbox)
            .await
            .map_err(|error| redact_error(&error, "Draft synchronization"))?;
        matching = search_message_id(&mut session, message_id, "Draft synchronization").await?;
    }
    let uid = matching
        .into_iter()
        .max()
        .ok_or_else(|| "The uploaded draft could not be confirmed.".to_string())?;
    if previous_uid_validity == selected.uid_validity {
        if let Some(previous_uid) = previous_uid.filter(|previous_uid| *previous_uid != uid) {
            session
                .uid_store(previous_uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
                .await
                .map_err(|error| redact_error(&error, "Draft replacement"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Draft replacement"))?;
            session
                .uid_expunge(previous_uid.to_string())
                .await
                .map_err(|error| redact_error(&error, "Draft replacement"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|error| redact_error(&error, "Draft replacement"))?;
        }
    }
    let _ = session.logout().await;
    Ok(RemoteDraftLocation {
        uid,
        uid_validity: selected.uid_validity,
    })
}

pub async fn delete_remote_draft(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    expected_uid_validity: Option<u32>,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = session
        .select(mailbox)
        .await
        .map_err(|error| redact_error(&error, "Draft deletion"))?;
    if expected_uid_validity.is_some() && selected.uid_validity != expected_uid_validity {
        return Err("The Drafts folder changed; Postal Snap kept the local draft safely.".into());
    }
    let capabilities = session
        .capabilities()
        .await
        .map_err(|error| redact_error(&error, "Draft deletion"))?;
    if !capabilities.has_str("UIDPLUS") {
        return Err("This mail server cannot safely delete synchronized drafts.".into());
    }
    session
        .uid_store(uid.to_string(), "+FLAGS.SILENT (\\Deleted)")
        .await
        .map_err(|error| redact_error(&error, "Draft deletion"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|error| redact_error(&error, "Draft deletion"))?;
    session
        .uid_expunge(uid.to_string())
        .await
        .map_err(|error| redact_error(&error, "Draft deletion"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|error| redact_error(&error, "Draft deletion"))?;
    let _ = session.logout().await;
    Ok(())
}

pub async fn fetch_remote_drafts(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    known_uids: &std::collections::HashSet<u32>,
) -> Result<RemoteDraftSnapshot, String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = session
        .examine(mailbox)
        .await
        .map_err(|error| redact_error(&error, "Draft download"))?;
    let mut uids = session
        .uid_search("ALL")
        .await
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
    for chunk in unknown.chunks(100) {
        let set = chunk
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let sizes = session
            .uid_fetch(&set, "(UID RFC822.SIZE)")
            .await
            .map_err(|error| redact_error(&error, "Draft download"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Draft download"))?;
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
        let rows = session
            .uid_fetch(safe_set, "(UID INTERNALDATE BODY.PEEK[])")
            .await
            .map_err(|error| redact_error(&error, "Draft download"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Draft download"))?;
        for row in rows {
            let Some(uid) = row.uid else { continue };
            let Some(raw) = row.body() else { continue };
            let updated_at = row
                .internal_date()
                .map(|date| date.with_timezone(&Utc).to_rfc3339())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            if let Ok(draft) = parse_remote_draft(uid, raw, updated_at) {
                drafts.push(draft);
            }
        }
    }
    let _ = session.logout().await;
    Ok(RemoteDraftSnapshot {
        uid_validity: selected.uid_validity,
        uids,
        drafts,
    })
}

fn parse_remote_draft(uid: u32, raw: &[u8], updated_at: String) -> Result<RemoteDraftData, String> {
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
        message_id: message.message_id().map(ToOwned::to_owned),
        updated_at,
        to: parsed_addresses(message.to()),
        cc: parsed_addresses(message.cc()),
        bcc: parsed_addresses(message.bcc()),
        subject: message.subject().unwrap_or_default().to_string(),
        html_body: message
            .body_html(0)
            .map(|body| body.into_owned())
            .unwrap_or_default(),
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

async fn search_message_id(
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
    let mut matches = session
        .uid_search(format!("HEADER Message-ID \"{value}\""))
        .await
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
        if attachment_id(index, &filename) == requested_id {
            return Ok((filename, part.contents().to_vec()));
        }
    }
    Err("Attachment not found.".into())
}

async fn connect_imap(server: &ServerConfig, password: &str) -> Result<ImapSession, String> {
    let address = (server.host.as_str(), server.port);
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| "Incoming server timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Incoming connection"))?;
    let native_connector = tokio_native_tls::native_tls::TlsConnector::builder();
    #[cfg(test)]
    let native_connector = add_test_imap_root(native_connector)?;
    let native_connector = native_connector
        .build()
        .map_err(|error| redact_error(&error, "Incoming TLS setup"))?;
    let connector = tokio_native_tls::TlsConnector::from(native_connector);
    let client = match server.tls_mode {
        TlsMode::Tls => {
            let tls = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(&server.host, tcp))
                .await
                .map_err(|_| "Incoming TLS negotiation timed out.".to_string())?
                .map_err(|error| redact_error(&error, "Incoming TLS negotiation"))?;
            let mut client = async_imap::Client::new(tls);
            client
                .read_response()
                .await
                .map_err(|error| redact_error(&error, "Incoming greeting"))?
                .ok_or_else(|| "The incoming server closed the secure connection.".to_string())?;
            client
        }
        TlsMode::StartTls => {
            let mut plain = async_imap::Client::new(tcp);
            plain
                .read_response()
                .await
                .map_err(|error| redact_error(&error, "Incoming greeting"))?
                .ok_or_else(|| "The incoming server closed the connection.".to_string())?;
            plain
                .run_command_and_check_ok("STARTTLS", None)
                .await
                .map_err(|error| redact_error(&error, "Required incoming STARTTLS"))?;
            let tls = tokio::time::timeout(
                CONNECT_TIMEOUT,
                connector.connect(&server.host, plain.into_inner()),
            )
            .await
            .map_err(|_| "Incoming STARTTLS timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Incoming STARTTLS"))?;
            async_imap::Client::new(tls)
        }
    };
    tokio::time::timeout(CONNECT_TIMEOUT, client.login(&server.username, password))
        .await
        .map_err(|_| "Incoming sign-in timed out.".to_string())?
        .map_err(|(error, _)| redact_error(&error, "Incoming sign-in"))
}

#[cfg(test)]
fn add_test_imap_root(
    mut builder: tokio_native_tls::native_tls::TlsConnectorBuilder,
) -> Result<tokio_native_tls::native_tls::TlsConnectorBuilder, String> {
    if let Ok(path) = std::env::var("POSTAL_SNAP_MAIL_TEST_CA_CERT") {
        let pem = std::fs::read(path)
            .map_err(|_| "Incoming test certificate could not be read.".to_string())?;
        let certificate = tokio_native_tls::native_tls::Certificate::from_pem(&pem)
            .map_err(|_| "Incoming test certificate is invalid.".to_string())?;
        builder.add_root_certificate(certificate);
    }
    Ok(builder)
}

async fn test_smtp(server: &ServerConfig, email: &str, password: &str) -> Result<(), String> {
    let transport = smtp_transport(server, password)?;
    let connected = tokio::time::timeout(CONNECT_TIMEOUT, transport.test_connection())
        .await
        .map_err(|_| "Outgoing server timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Outgoing connection"))?;
    if !connected {
        return Err("The outgoing server declined the secure connection.".into());
    }
    let _: Mailbox = email
        .parse()
        .map_err(|_| "Enter a valid sender address.".to_string())?;
    Ok(())
}

fn smtp_transport(
    server: &ServerConfig,
    password: &str,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let credentials = Credentials::new(server.username.clone(), password.to_string());
    #[cfg(test)]
    if let Ok(path) = std::env::var("POSTAL_SNAP_MAIL_TEST_CA_CERT") {
        use lettre::transport::smtp::client::{Certificate, Tls, TlsParameters};
        let pem = std::fs::read(path)
            .map_err(|_| "Outgoing test certificate could not be read.".to_string())?;
        let certificate = Certificate::from_pem(&pem)
            .map_err(|error| redact_error(&error, "Outgoing test certificate"))?;
        let parameters = TlsParameters::builder(server.host.clone())
            .add_root_certificate(certificate)
            .build()
            .map_err(|error| redact_error(&error, "Outgoing TLS setup"))?;
        let tls = match server.tls_mode {
            TlsMode::Tls => Tls::Wrapper(parameters),
            TlsMode::StartTls => Tls::Required(parameters),
        };
        return Ok(
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&server.host)
                .port(server.port)
                .tls(tls)
                .credentials(credentials)
                .timeout(Some(CONNECT_TIMEOUT))
                .build(),
        );
    }
    let builder = match server.tls_mode {
        TlsMode::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&server.host),
        TlsMode::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&server.host),
    }
    .map_err(|error| redact_error(&error, "Outgoing TLS setup"))?;
    Ok(builder
        .port(server.port)
        .credentials(credentials)
        .timeout(Some(CONNECT_TIMEOUT))
        .build())
}

#[cfg(test)]
async fn build_message(account: &AccountRecord, draft: &ComposeDraft) -> Result<Message, String> {
    let message_id = format!("<{}@run.rosie.snap>", uuid::Uuid::new_v4());
    build_message_with_id(account, draft, &message_id, false).await
}

async fn build_message_with_id(
    account: &AccountRecord,
    draft: &ComposeDraft,
    message_id: &str,
    keep_bcc: bool,
) -> Result<Message, String> {
    if !keep_bcc && draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err("Add at least one recipient.".into());
    }
    if draft.html_body.len() + draft.text_body.len() > MAX_MESSAGE_BYTES {
        return Err("This message is too large to send.".into());
    }
    if draft.attachments.len() > MAX_ATTACHMENTS {
        return Err("This message has too many attachments.".into());
    }

    let from: Mailbox = format!(
        "{} <{}>",
        account.summary.display_name, account.summary.email
    )
    .parse()
    .or_else(|_| account.summary.email.parse())
    .map_err(|_| "The sender address is invalid.".to_string())?;
    let mut builder = Message::builder()
        .from(from)
        .subject(draft.subject.clone())
        .message_id(Some(message_id.to_string()));
    for value in &draft.to {
        builder = builder.to(parse_mailbox(value)?);
    }
    for value in &draft.cc {
        builder = builder.cc(parse_mailbox(value)?);
    }
    for value in &draft.bcc {
        builder = builder.bcc(parse_mailbox(value)?);
    }
    if keep_bcc {
        builder = builder.keep_bcc();
    }
    if let Some(in_reply_to) = &draft.in_reply_to {
        builder = builder.in_reply_to(safe_thread_header(in_reply_to));
    }
    if let Some(references) = &draft.references {
        let references = references
            .iter()
            .map(|value| safe_thread_header(value))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !references.is_empty() {
            builder = builder.references(references);
        }
    }

    let alternative = MultiPart::alternative()
        .singlepart(SinglePart::plain(draft.text_body.clone()))
        .singlepart(SinglePart::html(draft.html_body.clone()));
    let mut mixed = MultiPart::mixed().multipart(alternative);
    let mut total_bytes = draft.html_body.len() + draft.text_body.len();
    for item in &draft.attachments {
        let path = Path::new(&item.token);
        if !path.is_file() {
            return Err(format!(
                "Attachment '{}' is unavailable.",
                safe_filename(&item.filename)
            ));
        }
        let bytes = tokio::fs::read(path).await.map_err(|_| {
            format!(
                "Could not read attachment '{}'.",
                safe_filename(&item.filename)
            )
        })?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(format!(
                "Attachment '{}' is too large.",
                safe_filename(&item.filename)
            ));
        }
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > MAX_OUTGOING_BYTES {
            return Err("The message and its attachments are too large to send safely.".into());
        }
        let content_type = item.content_type.clone().unwrap_or_else(|| {
            mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string()
        });
        let content_type = ContentType::parse(&content_type).unwrap_or_else(|_| {
            ContentType::parse("application/octet-stream").expect("static MIME type is valid")
        });
        let filename = safe_filename(&item.filename);
        let part = if item.inline {
            LettreAttachment::new_inline(
                item.content_id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            )
            .body(bytes, content_type)
        } else {
            LettreAttachment::new(filename).body(bytes, content_type)
        };
        mixed = mixed.singlepart(part);
    }
    builder
        .multipart(mixed)
        .map_err(|error| redact_error(&error, "Message construction"))
}

fn message_envelope(account: &AccountRecord, draft: &ComposeDraft) -> Result<Envelope, String> {
    let from = account
        .summary
        .email
        .parse()
        .map_err(|_| "The sender address is invalid.".to_string())?;
    let recipients = draft
        .to
        .iter()
        .chain(&draft.cc)
        .chain(&draft.bcc)
        .map(|value| {
            value
                .parse::<Mailbox>()
                .map(|mailbox| mailbox.email)
                .map_err(|_| "One of the recipient addresses is invalid.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Envelope::new(Some(from), recipients)
        .map_err(|_| "The message envelope is invalid.".to_string())
}

fn safe_thread_header(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(998)
        .collect()
}

fn parse_mailbox(value: &str) -> Result<Mailbox, String> {
    value
        .parse()
        .map_err(|_| "One of the recipient addresses is invalid.".into())
}

fn parse_envelope(
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
        .map(|date| date.with_timezone(&Utc).to_rfc3339())
        .or_else(|| {
            fetch
                .internal_date()
                .map(|date| date.with_timezone(&Utc).to_rfc3339())
        })
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let recipients = to
        .iter()
        .chain(cc.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    Ok(CachedMessage {
        uid,
        message_id: envelope.message_id.as_deref().map(decode_imap_text),
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
        text_body: String::new(),
        html_body: None,
        attachments: Vec::new(),
        raw_message: Vec::new(),
    })
}

fn decode_imap_text(value: &[u8]) -> String {
    String::from_utf8_lossy(value).trim().to_string()
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

fn parse_message(
    uid: u32,
    raw: &[u8],
    is_read: bool,
    is_starred: bool,
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
    let html_body = message.body_html(0).map(|body| body.into_owned());
    let preview = message
        .body_preview(180)
        .map(|body| body.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    let received_at = message
        .date()
        .and_then(|date| DateTime::<Utc>::from_timestamp(date.to_timestamp(), 0))
        .map(|date| date.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
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
                id: attachment_id(index, &filename),
                filename,
                content_type,
                size: part.len() as u64,
                content_id: part.content_id().map(ToOwned::to_owned),
                inline: part.content_id().is_some(),
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
        uid,
        message_id: message.message_id().map(ToOwned::to_owned),
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
        text_body,
        html_body,
        attachments,
        raw_message: raw.to_vec(),
    })
}

fn validate_mime_resource_shape(raw: &[u8]) -> Result<(), String> {
    if raw.len() > MAX_MESSAGE_BYTES {
        return Err("This message is too large to process safely.".into());
    }
    let multipart_count = raw
        .windows(b"multipart/".len())
        .filter(|window| window.eq_ignore_ascii_case(b"multipart/"))
        .take(MAX_MULTIPART_DECLARATIONS + 1)
        .count();
    if multipart_count > MAX_MULTIPART_DECLARATIONS {
        return Err("This message has too many nested MIME containers.".into());
    }
    Ok(())
}

fn parsed_addresses(value: Option<&mail_parser::Address<'_>>) -> Vec<String> {
    value
        .into_iter()
        .flat_map(|addresses| addresses.iter())
        .filter_map(|address| address.address.as_deref())
        .filter(|address| address.contains('@'))
        .map(ToOwned::to_owned)
        .collect()
}

fn attachment_id(index: usize, filename: &str) -> String {
    let digest = Sha256::digest(format!("{index}:{filename}"));
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AccountSummary, ComposeAttachment};

    #[test]
    fn parses_and_decodes_mime_message() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Hello\r\nMessage-ID: <one@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from Postal Snap";
        let parsed = parse_message(7, raw, false, true).unwrap();
        assert_eq!(parsed.uid, 7);
        assert_eq!(parsed.sender_address, "jane@example.com");
        assert_eq!(parsed.subject, "Hello");
        assert!(parsed.text_body.contains("Hello from Postal Snap"));
    }

    #[test]
    fn builds_stable_opaque_attachment_ids() {
        assert_eq!(attachment_id(0, "photo.jpg"), attachment_id(0, "photo.jpg"));
        assert_ne!(attachment_id(0, "photo.jpg"), attachment_id(1, "photo.jpg"));
    }

    #[test]
    fn preserves_inline_part_content_type_and_content_id() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Photo\r\nContent-Type: multipart/related; boundary=postal\r\n\r\n--postal\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Photo</p><img src=\"cid:family-photo@example.com\">\r\n--postal\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename=\"family\"\r\nContent-ID: <family-photo@example.com>\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--postal--\r\n";
        let parsed = parse_message(8, raw, true, false).unwrap();
        let inline = parsed.attachments.first().unwrap();
        assert_eq!(inline.content_type, "image/png");
        assert_eq!(
            inline.content_id.as_deref(),
            Some("family-photo@example.com")
        );
        assert!(inline.inline);
        let (_, bytes) = extract_attachment(raw, &inline.id).unwrap();
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn rejects_excessive_multipart_nesting_before_parsing() {
        let raw = "multipart/".repeat(MAX_MULTIPART_DECLARATIONS + 1);
        assert!(validate_mime_resource_shape(raw.as_bytes()).is_err());
    }

    #[tokio::test]
    async fn builds_multipart_plain_and_html_mail() {
        let account = AccountRecord {
            summary: AccountSummary {
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
            },
            imap: ServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam".into(),
            },
            smtp: ServerConfig {
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam".into(),
            },
        };
        let draft = ComposeDraft {
            id: None,
            account_id: account.summary.id.clone(),
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            html_body: "<p>Hello Jane</p>".into(),
            text_body: "Hello Jane".into(),
            attachments: Vec::<ComposeAttachment>::new(),
            in_reply_to: None,
            references: None,
        };

        let rendered =
            String::from_utf8(build_message(&account, &draft).await.unwrap().formatted()).unwrap();
        assert!(rendered.contains("multipart/alternative"));
        assert!(rendered.contains("text/plain"));
        assert!(rendered.contains("text/html"));
    }

    #[tokio::test]
    async fn outgoing_mime_hides_bcc_but_envelope_keeps_recipient() {
        let account = AccountRecord {
            summary: AccountSummary {
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
            },
            imap: ServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
            smtp: ServerConfig {
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
            },
        };
        let draft = ComposeDraft {
            id: None,
            account_id: account.summary.id.clone(),
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec!["hidden@example.com".into()],
            subject: "Private copy".into(),
            html_body: "<p>Hello</p>".into(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
        };
        let prepared = prepare_message(&account, &draft).await.unwrap();
        let rendered = String::from_utf8(prepared.bytes).unwrap();
        assert!(!rendered.to_ascii_lowercase().contains("bcc:"));
        assert!(!rendered.contains("hidden@example.com"));
        let envelope = message_envelope(&account, &draft).unwrap();
        assert!(envelope
            .to()
            .iter()
            .any(|address| address.to_string() == "hidden@example.com"));
    }

    #[tokio::test]
    #[ignore = "requires npm run test:mail-integration"]
    async fn greenmail_protocol_integration() {
        assert_eq!(
            std::env::var("POSTAL_SNAP_MAIL_INTEGRATION").as_deref(),
            Ok("1")
        );
        let password = "mail-test-password";
        let account = AccountRecord {
            summary: AccountSummary {
                id: "11111111-1111-4111-8111-111111111111".into(),
                provider: ProviderKind::Manual,
                email: "senior@example.test".into(),
                display_name: "Postal Snap Test".into(),
                sync_state: "idle".into(),
                error: None,
            },
            imap: ServerConfig {
                host: "localhost".into(),
                port: 3993,
                tls_mode: TlsMode::Tls,
                username: "senior@example.test".into(),
            },
            smtp: ServerConfig {
                host: "localhost".into(),
                port: 3025,
                tls_mode: TlsMode::StartTls,
                username: "senior@example.test".into(),
            },
        };
        let setup = AccountSetupRequest {
            provider: ProviderKind::Manual,
            email: account.summary.email.clone(),
            display_name: account.summary.display_name.clone(),
            password: password.into(),
            imap: Some(account.imap.clone()),
            smtp: Some(account.smtp.clone()),
        };
        test_account(&setup, &account.imap, &account.smtp, password)
            .await
            .unwrap();
        assert!(connect_imap(&account.imap, "wrong-password").await.is_err());

        let mut session = connect_imap(&account.imap, password).await.unwrap();
        for mailbox in ["Drafts", "Sent", "Archive", "Trash", "Junk"] {
            let _ = session.create(mailbox).await;
        }
        session.logout().await.unwrap();

        let attachment_dir = tempfile::tempdir().unwrap();
        let attachment_path = attachment_dir.path().join("family-note.txt");
        std::fs::write(&attachment_path, b"attachment body").unwrap();
        let draft = ComposeDraft {
            id: None,
            account_id: account.summary.id.clone(),
            to: vec![account.summary.email.clone()],
            cc: vec![],
            bcc: vec![],
            subject: "GreenMail protocol check".into(),
            html_body: "<p>Protocol integration body</p>".into(),
            text_body: "Protocol integration body".into(),
            attachments: vec![ComposeAttachment {
                token: attachment_path.to_string_lossy().into(),
                filename: "family-note.txt".into(),
                content_type: Some("text/plain".into()),
                inline: false,
                content_id: None,
            }],
            in_reply_to: None,
            references: None,
        };
        let prepared = prepare_message(&account, &draft).await.unwrap();
        send_prepared(&account, password, &draft, &prepared.bytes)
            .await
            .unwrap();

        let db = Database::memory();
        db.insert_account(&account).unwrap();
        let mut inbox_message = None;
        let mut inbox_counts = None;
        for _ in 0..20 {
            sync_account(&db, &account, password, &CachePolicy::default())
                .await
                .unwrap();
            let inbox = db
                .list_mailboxes(&account.summary.id)
                .unwrap()
                .into_iter()
                .find(|mailbox| mailbox.role == crate::models::MailboxRole::Inbox)
                .unwrap();
            inbox_message = db.list_messages(inbox.id, None, 10).unwrap().items.pop();
            inbox_counts = Some((inbox.total_count, inbox.unread_count));
            if inbox_message.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let summary = inbox_message.expect("SMTP delivery reached Inbox");
        assert_eq!(inbox_counts, Some((1, 1)));
        let downloaded = download_message(&account, password, "INBOX", summary.uid, summary.size)
            .await
            .unwrap();
        assert!(downloaded.text_body.contains("Protocol integration body"));
        let attachment = downloaded.attachments.first().unwrap();
        let (_, bytes) = extract_attachment(&downloaded.raw_message, &attachment.id).unwrap();
        assert_eq!(bytes, b"attachment body");

        set_remote_flags(
            &account,
            password,
            "INBOX",
            summary.uid,
            Some(true),
            Some(true),
        )
        .await
        .unwrap();
        sync_account(&db, &account, password, &CachePolicy::default())
            .await
            .unwrap();
        let inbox = db
            .list_mailboxes(&account.summary.id)
            .unwrap()
            .into_iter()
            .find(|mailbox| mailbox.role == crate::models::MailboxRole::Inbox)
            .unwrap();
        assert_eq!((inbox.total_count, inbox.unread_count), (1, 0));
        let search = server_search(
            &db,
            &account,
            password,
            &SearchQuery {
                account_id: account.summary.id.clone(),
                mailbox_id: Some(summary.mailbox_id),
                text: "protocol check".into(),
                all_folders: false,
                limit: 25,
            },
        )
        .await
        .unwrap();
        assert!(!search.is_empty());

        let draft_message_id = "<draft-22222222-2222-4222-8222-222222222222-1@run.rosie.snap>";
        let draft_bytes = prepare_draft_message(&account, &draft, draft_message_id)
            .await
            .unwrap();
        let remote = upsert_remote_draft(
            &account,
            password,
            "Drafts",
            draft_message_id,
            &draft_bytes,
            None,
            None,
        )
        .await
        .unwrap();
        let snapshot = fetch_remote_drafts(
            &account,
            password,
            "Drafts",
            &std::collections::HashSet::new(),
        )
        .await
        .unwrap();
        assert!(snapshot.uids.contains(&remote.uid));
        assert!(snapshot
            .drafts
            .iter()
            .any(|item| item.message_id.as_deref() == Some(draft_message_id)));

        ensure_sent_copy(
            &account,
            password,
            "Sent",
            &prepared.message_id,
            &prepared.bytes,
        )
        .await
        .unwrap();
        ensure_sent_copy(
            &account,
            password,
            "Sent",
            &prepared.message_id,
            &prepared.bytes,
        )
        .await
        .unwrap();

        let mut session = connect_imap(&account.imap, password).await.unwrap();
        let sent_status = session.status("Sent", "(MESSAGES)").await.unwrap();
        assert_eq!(sent_status.exists, 1);
        session.logout().await.unwrap();

        let wake = Notify::new();
        wake.notify_one();
        tokio::time::timeout(
            Duration::from_secs(5),
            idle_inbox(&account, password, &wake),
        )
        .await
        .expect("IDLE interruption timed out")
        .unwrap();
        move_remote(&account, password, "INBOX", "Archive", summary.uid)
            .await
            .unwrap();
        let mut reconnected = connect_imap(&account.imap, password).await.unwrap();
        let inbox_status = reconnected.status("INBOX", "(MESSAGES)").await.unwrap();
        let archive_status = reconnected.status("Archive", "(MESSAGES)").await.unwrap();
        assert_eq!(inbox_status.exists, 0);
        assert_eq!(archive_status.exists, 1);
        reconnected.logout().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires POSTAL_SNAP_TEST_ICLOUD_EMAIL and POSTAL_SNAP_TEST_ICLOUD_PASSWORD"]
    async fn icloud_live_connection_smoke() {
        let email = std::env::var("POSTAL_SNAP_TEST_ICLOUD_EMAIL")
            .expect("set POSTAL_SNAP_TEST_ICLOUD_EMAIL outside the repository");
        let password = std::env::var("POSTAL_SNAP_TEST_ICLOUD_PASSWORD")
            .expect("set POSTAL_SNAP_TEST_ICLOUD_PASSWORD outside the repository");
        let request = AccountSetupRequest {
            provider: ProviderKind::Icloud,
            email,
            display_name: "Postal Snap Test".into(),
            password,
            imap: None,
            smtp: None,
        };
        let (imap, smtp) = crate::models::validated_setup(&request).unwrap();
        test_account(&request, &imap, &smtp, &request.password)
            .await
            .unwrap();
    }
}
