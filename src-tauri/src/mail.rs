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
        MailboxRole, MessageSummary, ProviderKind, SearchQuery, ServerConfig, TlsMode,
    },
    security::{redact_error, safe_filename},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const IMAP_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
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
    pub from: Option<String>,
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
    let list_stream = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.list(None, Some("*")))
        .await
        .map_err(|_| "Mailbox discovery timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox discovery"))?;
    let names = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, list_stream.try_collect::<Vec<_>>())
        .await
        .map_err(|_| "Mailbox discovery timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox discovery"))?;
    let mut server_mailboxes = std::collections::HashSet::new();

    for name in names {
        let mailbox_name = name.name().to_string();
        let attributes = name
            .attributes()
            .iter()
            .map(|attribute| match attribute {
                async_imap::types::NameAttribute::NoSelect => "NoSelect".to_string(),
                async_imap::types::NameAttribute::NoInferiors => "NoInferiors".to_string(),
                async_imap::types::NameAttribute::Marked => "Marked".to_string(),
                async_imap::types::NameAttribute::Unmarked => "Unmarked".to_string(),
                async_imap::types::NameAttribute::Extension(val) => val.to_string(),
                _ => format!("{attribute:?}"),
            })
            .collect::<Vec<_>>();
        if attributes
            .iter()
            .any(|attribute| attribute.eq_ignore_ascii_case("NoSelect"))
        {
            continue;
        }
        server_mailboxes.insert(mailbox_name.clone());
        let role = mailbox_role(&mailbox_name, &attributes);
        let previous_state = db.mailbox_sync_state(&account.summary.id, &mailbox_name)?;
        let status = tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.status(&mailbox_name, "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)"),
        )
        .await
        .map_err(|_| "Mailbox status timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox status"))?;
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.examine(&mailbox_name))
            .await
            .map_err(|_| "Mailbox sync timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Mailbox sync"))?;
        let unchanged = previous_state.is_some_and(|(validity, next, total, unread)| {
            validity == selected.uid_validity
                && next == selected.uid_next
                && total == status.exists
                && unread == status.unseen
        });
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
        if !unchanged {
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
                let flag_stream = tokio::time::timeout(
                    IMAP_COMMAND_TIMEOUT,
                    session.uid_fetch(set, "(UID FLAGS)"),
                )
                .await
                .map_err(|_| "Flag sync timed out.".to_string())?
                .map_err(|error| redact_error(&error, "Flag sync"))?;
                let flag_rows =
                    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, flag_stream.try_collect::<Vec<_>>())
                        .await
                        .map_err(|_| "Flag sync timed out.".to_string())?
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
        let should_download_bodies = role == MailboxRole::Inbox || policy.mode == "full";
        if should_download_bodies {
            let limit = if policy.mode == "full" { 50 } else { 25 };
            let _ =
                download_uncached_bodies(&mut session, db, &account.summary.id, mailbox_id, limit)
                    .await;
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
    let fetch_stream = tokio::time::timeout(
        IMAP_COMMAND_TIMEOUT,
        session.fetch(exists.to_string(), "(UID)"),
    )
    .await
    .map_err(|_| "Mailbox cursor timed out.".to_string())?
    .map_err(|error| redact_error(&error, "Mailbox cursor"))?;
    let rows = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, fetch_stream.try_collect::<Vec<_>>())
        .await
        .map_err(|_| "Mailbox cursor timed out.".to_string())?
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
    let mut fetched = tokio::time::timeout(
        IMAP_COMMAND_TIMEOUT,
        session.uid_fetch(range, "(UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])"),
    )
    .await
    .map_err(|_| "Message list download timed out.".to_string())?
    .map_err(|error| redact_error(&error, "Message list download"))?;
    let mut age_marks: Vec<(u32, bool)> = Vec::new();
    let mut threaded: Vec<String> = Vec::new();
    loop {
        let next = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, fetched.try_next())
            .await
            .map_err(|_| "Message list download timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Message list download"))?;
        let Some(item) = next else {
            break;
        };
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
        let is_old = cutoff.is_some_and(|cutoff| {
            item.internal_date()
                .map(|date| date.with_timezone(&Utc) < *cutoff)
                .unwrap_or_else(|| {
                    DateTime::parse_from_rfc3339(&parsed.received_at)
                        .map(|received| received.with_timezone(&Utc) < *cutoff)
                        .unwrap_or(false)
                })
        });
        if let Some(uid) = item.uid {
            age_marks.push((uid, is_old));
        }
        db.upsert_envelope(account_id, mailbox_id, &parsed)?;
        threaded.push(
            parsed
                .message_id
                .clone()
                .unwrap_or_else(|| crate::db::synthetic_thread_id(mailbox_id, parsed.uid)),
        );
    }
    let _ = db.repair_thread_roots(account_id, &threaded);
    age_marks.sort_unstable_by_key(|(uid, _)| *uid);
    let mut consecutive_old = 0u32;
    for (_, is_old) in age_marks {
        if is_old {
            consecutive_old += 1;
            if consecutive_old >= 3 {
                break;
            }
        } else {
            break;
        }
    }
    Ok(FetchOutcome {
        older_than_cutoff: consecutive_old >= 3,
    })
}

pub async fn idle_inbox(
    account: &AccountRecord,
    password: &str,
    wake: &Notify,
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let capabilities = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.capabilities())
        .await
        .map_err(|_| "IMAP capability check timed out.".to_string())?
        .map_err(|error| redact_error(&error, "IMAP capability check"))?;
    if !capabilities.has_str("IDLE") {
        let _ = session.logout().await;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(120)) => {},
            _ = wake.notified() => {},
        }
        return Ok(());
    }
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select("INBOX"))
        .await
        .map_err(|_| "Inbox monitoring timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Inbox monitoring"))?;
    let mut idle = session.idle();
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, idle.init())
        .await
        .map_err(|_| "Inbox monitoring initialization timed out.".to_string())?
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
    let mut session = match tokio::time::timeout(Duration::from_secs(5), idle.done()).await {
        Ok(Ok(session)) => session,
        _ => return Ok(()),
    };
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
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.examine(&name))
            .await
            .map_err(|_| "Server search timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Server search"))?;
        if let Some(expected_uid_validity) = db.mailbox_uid_validity(&account.summary.id, &name)? {
            if selected.uid_validity != Some(expected_uid_validity) {
                // The cached generation is stale; caching new-generation UIDs
                // against it would corrupt the mailbox. Purge and let the
                // next sync repopulate instead.
                let _ = db.purge_stale_mailbox(&account.summary.id, &name, mailbox_id);
                continue;
            }
        }
        let search_cmd = if search_text.is_ascii() {
            format!("TEXT \"{search_text}\"")
        } else {
            format!("CHARSET UTF-8 TEXT \"{search_text}\"")
        };
        let mut uids = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_search(&search_cmd))
            .await
            .map_err(|_| "Server search timed out.".to_string())?
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
        let fetched = tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session
                .uid_fetch(set, "(UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])")
                .await
                .map_err(|error| redact_error(&error, "Server search"))?
                .try_collect::<Vec<_>>(),
        )
        .await
        .map_err(|_| "Server search timed out.".to_string())?
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
        let threaded: Vec<String> = results
            .iter()
            .filter(|summary| summary.mailbox_id == mailbox_id)
            .map(|summary| {
                summary
                    .message_id
                    .clone()
                    .unwrap_or_else(|| crate::db::synthetic_thread_id(mailbox_id, summary.uid))
            })
            .collect();
        let _ = db.repair_thread_roots(&account.summary.id, &threaded);
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
    expected_uid_validity: Option<u32>,
) -> Result<CachedMessage, String> {
    if expected_size > MAX_MESSAGE_BYTES as u64 {
        return Err("This message is too large to download safely.".into());
    }
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.examine(mailbox))
        .await
        .map_err(|_| "Message download timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Message download"))?;
    if expected_uid_validity.is_some() && selected.uid_validity != expected_uid_validity {
        return Err("This mailbox changed; refresh mail and try again.".into());
    }
    let mut rows = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_fetch(uid.to_string(), "(UID FLAGS RFC822.SIZE BODY.PEEK[])")
            .await
            .map_err(|error| redact_error(&error, "Message download"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Message download"))
    })
    .await
    .map_err(|_| "Message download timed out.".to_string())??;
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

async fn download_uncached_bodies(
    session: &mut ImapSession,
    db: &Database,
    account_id: &str,
    mailbox_id: i64,
    limit: u32,
) -> Result<(), String> {
    let uncached = db.uncached_message_uids(mailbox_id, limit, MAX_MESSAGE_BYTES as u64)?;
    if uncached.is_empty() {
        return Ok(());
    }
    let range = uncached
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let fetch_result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_fetch(range, "(UID FLAGS RFC822.SIZE BODY.PEEK[])")
            .await
            .map_err(|error| redact_error(&error, "Message prefetch"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Message prefetch"))
    })
    .await;

    let rows = match fetch_result {
        Ok(Ok(rows)) => rows,
        Ok(Err(error)) => return Err(error),
        Err(_) => return Err("Message prefetch timed out.".into()),
    };

    for item in rows {
        let (Some(uid), Some(raw)) = (item.uid, item.body()) else {
            continue;
        };
        if raw.len() > MAX_MESSAGE_BYTES {
            continue;
        }
        let flags = item
            .flags()
            .map(|flag| format!("{flag:?}"))
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        if let Ok(parsed) =
            parse_message(uid, raw, flags.contains("seen"), flags.contains("flagged"))
        {
            let _ = db.upsert_message(account_id, mailbox_id, &parsed);
            let id = parsed
                .message_id
                .clone()
                .unwrap_or_else(|| crate::db::synthetic_thread_id(mailbox_id, parsed.uid));
            let _ = db.repair_thread_roots(account_id, &[id]);
        }
    }
    Ok(())
}

pub async fn discover_icloud_aliases(email: &str, password: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not connect to iCloud alias service.".to_string())?;

    let auth = format!(
        "Basic {}",
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            format!("{email}:{password}")
        )
    );

    let propfind_principal = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal/>
  </D:prop>
</D:propfind>"#;

    let response = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            "https://caldav.icloud.com/",
        )
        .header("Authorization", &auth)
        .header("Depth", "0")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(propfind_principal)
        .send()
        .await
        .map_err(|error| redact_error(&error, "iCloud alias discovery"))?;

    let status = response.status();
    if status.is_redirection() {
        return Ok(Vec::new());
    }
    if !status.is_success() && status.as_u16() != 207 {
        return Ok(Vec::new());
    }

    let final_url = response.url().clone();
    let text = response
        .text()
        .await
        .map_err(|error| redact_error(&error, "iCloud alias discovery"))?;

    let principal_href = extract_tag_value(&text, "current-user-principal")
        .and_then(|tag| extract_tag_value(&tag, "href"))
        .or_else(|| extract_tag_value(&text, "href"));

    let Some(href) = principal_href else {
        return Ok(Vec::new());
    };

    let principal_url = if href.starts_with("http") {
        href
    } else {
        let base = format!(
            "{}://{}",
            final_url.scheme(),
            final_url.host_str().unwrap_or("caldav.icloud.com")
        );
        format!(
            "{base}{}",
            if href.starts_with('/') {
                href
            } else {
                format!("/{href}")
            }
        )
    };

    let Ok(parsed_principal) = reqwest::Url::parse(&principal_url) else {
        return Ok(Vec::new());
    };
    let Some(principal_host) = parsed_principal.host_str() else {
        return Ok(Vec::new());
    };
    if !is_allowed_icloud_principal_host(principal_host) {
        return Ok(Vec::new());
    }

    let address_set_prop = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-user-address-set/>
  </D:prop>
</D:propfind>"#;

    let address_res = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            &principal_url,
        )
        .header("Authorization", &auth)
        .header("Depth", "0")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(address_set_prop)
        .send()
        .await
        .map_err(|error| redact_error(&error, "iCloud alias discovery"))?;

    let addr_status = address_res.status();
    if addr_status.is_redirection() {
        return Ok(Vec::new());
    }
    if !addr_status.is_success() && addr_status.as_u16() != 207 {
        return Ok(Vec::new());
    }

    let address_xml = address_res
        .text()
        .await
        .map_err(|error| redact_error(&error, "iCloud alias discovery"))?;

    let mut aliases = Vec::new();
    let primary_lower = email.trim().to_lowercase();

    for part in address_xml.split("mailto:") {
        if let Some(end) = part.find(['<', '"', ' ', '\n', '\r', '\t', '&']) {
            let addr = part[..end].trim().to_lowercase();
            if addr.contains('@')
                && !addr.contains('/')
                && addr != primary_lower
                && addr.len() <= 320
                && !addr.contains(char::is_control)
                && addr.parse::<lettre::message::Mailbox>().is_ok()
                && !aliases.contains(&addr)
            {
                aliases.push(addr);
            }
        }
    }

    Ok(aliases)
}

pub fn is_allowed_icloud_principal_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "caldav.icloud.com"
        || host.ends_with(".icloud.com")
        || host == "caldav.apple.com"
        || host.ends_with(".apple.com")
}

pub fn extract_tag_value(xml: &str, tag_name: &str) -> Option<String> {
    let mut search_from = 0;
    while let Some(start_bracket) = xml[search_from..].find('<') {
        let idx = search_from + start_bracket;
        let tag_start = idx + 1;
        if let Some(close_bracket) = xml[tag_start..].find('>') {
            let tag_head = &xml[tag_start..tag_start + close_bracket];
            let tag_ident = tag_head
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_end_matches('/');
            let matches_tag = if let Some(local) = tag_ident.split(':').nth(1) {
                local.eq_ignore_ascii_case(tag_name)
            } else {
                tag_ident.eq_ignore_ascii_case(tag_name)
            };
            if matches_tag && !tag_ident.starts_with('/') {
                let content_start = tag_start + close_bracket + 1;
                let after = &xml[content_start..];
                for (close_idx, _) in after.match_indices("</") {
                    let after_close = &after[close_idx + 2..];
                    if let Some(gt) = after_close.find('>') {
                        let close_ident = after_close[..gt].trim();
                        let close_matches = if let Some(local) = close_ident.split(':').nth(1) {
                            local.eq_ignore_ascii_case(tag_name)
                        } else {
                            close_ident.eq_ignore_ascii_case(tag_name)
                        };
                        if close_matches {
                            return Some(after[..close_idx].trim().to_string());
                        }
                    }
                }
            }
            search_from = tag_start + close_bracket + 1;
        } else {
            break;
        }
    }
    None
}

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
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
        .await
        .map_err(|_| "Message update timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Message update"))?;
    if expected_uid_validity.is_some() && selected.uid_validity != expected_uid_validity {
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
    let _ = session.logout().await;
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
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(source))
        .await
        .map_err(|_| "Move timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Move"))?;
    if expected_uid_validity.is_some() && selected.uid_validity != expected_uid_validity {
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
    let _ = session.logout().await;
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
    let _ = session.logout().await;
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
    let _ = session.logout().await;
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
    let _ = session.logout().await;
    result
}

pub async fn empty_folder(
    account: &AccountRecord,
    password: &str,
    name: &str,
    expected_uid_validity: Option<u32>,
    protected_uids: &[u32],
) -> Result<(), String> {
    let mut session = connect_imap(&account.imap, password).await?;
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(name))
        .await
        .map_err(|_| "Emptying the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder empty"))?;
    if expected_uid_validity.is_some() && selected.uid_validity != expected_uid_validity {
        return Err("This mailbox changed; refresh mail and try again.".into());
    }
    if selected.exists == 0 {
        let _ = session.logout().await;
        return Ok(());
    }
    let all_uids: Vec<u32> = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_search("ALL"))
        .await
        .map_err(|_| "Emptying the folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Folder empty"))?
        .into_iter()
        .collect();
    if all_uids.is_empty() {
        let _ = session.logout().await;
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
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_expunge(set)
            .await
            .map_err(|error| redact_error(&error, "Folder empty"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Folder empty"))
    })
    .await
    .map_err(|_| "Emptying the folder timed out.".to_string())??;
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
        let stable = attachment_id(&filename, part.content_id(), part.len(), index);
        if stable == requested_id || legacy_attachment_id(index, &filename) == requested_id {
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
            tokio::time::timeout(CONNECT_TIMEOUT, client.read_response())
                .await
                .map_err(|_| "Incoming greeting timed out.".to_string())?
                .map_err(|error| redact_error(&error, "Incoming greeting"))?
                .ok_or_else(|| "The incoming server closed the secure connection.".to_string())?;
            client
        }
        TlsMode::StartTls => {
            let mut plain = async_imap::Client::new(tcp);
            tokio::time::timeout(CONNECT_TIMEOUT, plain.read_response())
                .await
                .map_err(|_| "Incoming greeting timed out.".to_string())?
                .map_err(|error| redact_error(&error, "Incoming greeting"))?
                .ok_or_else(|| "The incoming server closed the connection.".to_string())?;
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                plain.run_command_and_check_ok("STARTTLS", None),
            )
            .await
            .map_err(|_| "Incoming STARTTLS timed out.".to_string())?
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

    let sender_email = draft
        .from
        .as_deref()
        .map(str::trim)
        .filter(|addr| !addr.is_empty())
        .unwrap_or(&account.summary.email);
    let from: Mailbox = format!("{} <{}>", account.summary.display_name, sender_email)
        .parse()
        .or_else(|_| sender_email.parse())
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
            return Err("An attachment file is no longer available.".into());
        }
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|_| "Could not read an attachment file.".to_string())?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err("An attachment exceeds the maximum allowed size.".into());
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
    let sender_email = draft
        .from
        .as_deref()
        .map(str::trim)
        .filter(|addr| !addr.is_empty())
        .unwrap_or(&account.summary.email);
    let from = sender_email
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

fn escape_signature_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Append the account signature once, with the conventional `-- ` marker.
/// Retries reuse the queued draft, so the contains-check keeps it singular.
pub fn apply_signature(mut draft: ComposeDraft, signature: &str) -> ComposeDraft {
    let signature = signature.trim();
    if signature.is_empty() || draft.text_body.contains(signature) {
        return draft;
    }
    draft.text_body = format!("{}\n\n-- \n{signature}", draft.text_body.trim_end());
    let html_lines = escape_signature_html(signature).replace('\n', "<br>");
    if draft.html_body.trim().is_empty() {
        draft.html_body = format!("<p>-- </p><p>{html_lines}</p>");
    } else {
        draft.html_body = format!("{}<br><br>-- <br>{html_lines}", draft.html_body);
    }
    draft
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
    })
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

fn decode_imap_text(value: &[u8]) -> String {
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
                id: attachment_id(&filename, part.content_id(), part.len(), index),
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

fn attachment_id(filename: &str, content_id: Option<&str>, size: usize, index: usize) -> String {
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

fn legacy_attachment_id(index: usize, filename: &str) -> String {
    let digest = Sha256::digest(format!("{index}:{filename}"));
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn normalize_rfc_message_id(value: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AccountSummary, ComposeAttachment, ComposeDraft};

    #[test]
    fn parses_and_decodes_mime_message() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Hello\r\nMessage-ID: <one@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from Postal Snap";
        let parsed = parse_message(7, raw, false, true).unwrap();
        assert_eq!(parsed.uid, 7);
        assert_eq!(parsed.sender_address, "jane@example.com");
        assert_eq!(parsed.subject, "Hello");
        assert!(parsed.text_body.contains("Hello from Postal Snap"));
        assert_eq!(parsed.message_id.as_deref(), Some("<one@example.com>"));
    }

    #[test]
    fn normalizes_message_ids_with_or_without_brackets() {
        assert_eq!(
            normalize_rfc_message_id("<one@example.com>").as_deref(),
            Some("<one@example.com>")
        );
        assert_eq!(
            normalize_rfc_message_id("one@example.com").as_deref(),
            Some("<one@example.com>")
        );
        assert_eq!(normalize_rfc_message_id("  "), None);
    }

    #[tokio::test]
    async fn parsed_drafts_keep_the_prepared_message_id() {
        let account = AccountRecord {
            summary: AccountSummary {
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
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
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Draft identity".into(),
            html_body: "<p>Draft</p>".into(),
            text_body: "Draft".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
        };
        let message_id = "<draft-22222222-2222-4222-8222-222222222222-1@run.rosie.snap>";
        let bytes = prepare_draft_message(&account, &draft, message_id)
            .await
            .unwrap();
        let parsed = parse_remote_draft(1, &bytes, "2026-08-27T00:00:00Z".into()).unwrap();
        assert_eq!(parsed.message_id.as_deref(), Some(message_id));
        assert_eq!(parsed.from.as_deref(), Some("sam@example.com"));
    }

    #[test]
    fn builds_stable_opaque_attachment_ids() {
        let first = attachment_id("photo.jpg", None, 1024, 0);
        assert_eq!(first, attachment_id("photo.jpg", None, 1024, 0));
        assert_ne!(first, attachment_id("photo.jpg", None, 1024, 1));
        assert_ne!(
            first,
            attachment_id("photo.jpg", Some("cid@example.com"), 1024, 0)
        );
        assert_ne!(first, attachment_id("photo.jpg", None, 2048, 0));
    }

    fn blank_draft() -> ComposeDraft {
        ComposeDraft {
            id: None,
            account_id: "account-1".into(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            html_body: "<p>Hello</p>".into(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
        }
    }

    #[test]
    fn signatures_append_once_with_escaping() {
        let plain = apply_signature(blank_draft(), "");
        assert_eq!(plain.text_body, "Hello");
        let signed = apply_signature(blank_draft(), "Best,\nSam <sam>");
        assert!(signed.text_body.ends_with("\n\n-- \nBest,\nSam <sam>"));
        assert!(signed.html_body.contains("-- <br>Best,<br>Sam &lt;sam&gt;"));
        let twice = apply_signature(signed.clone(), "Best,\nSam <sam>");
        assert_eq!(twice.text_body, signed.text_body);
        assert_eq!(twice.html_body, signed.html_body);
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
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
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
            from: None,
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
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
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
            from: None,
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
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
            },
            imap: ServerConfig {
                host: "localhost".into(),
                port: 3993,
                tls_mode: TlsMode::Tls,
                username: "senior@example.test".into(),
            },
            smtp: ServerConfig {
                host: "localhost".into(),
                port: 3465,
                tls_mode: TlsMode::Tls,
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
            from: None,
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
                size: None,
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
        let downloaded = download_message(
            &account,
            password,
            "INBOX",
            summary.uid,
            summary.size,
            db.mailbox_uid_validity(&account.summary.id, "INBOX")
                .unwrap(),
        )
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
            db.mailbox_uid_validity(&account.summary.id, "INBOX")
                .unwrap(),
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
        move_remote(
            &account,
            password,
            "INBOX",
            "Archive",
            summary.uid,
            db.mailbox_uid_validity(&account.summary.id, "INBOX")
                .unwrap(),
        )
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

    #[test]
    fn extracts_xml_tag_values_with_namespaces() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:propstat>
      <D:prop>
        <D:current-user-principal>
          <D:href>/12345/principal/</D:href>
        </D:current-user-principal>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let principal = extract_tag_value(xml, "current-user-principal").unwrap();
        assert!(principal.contains("/12345/principal/"));
        let href = extract_tag_value(&principal, "href").unwrap();
        assert_eq!(href, "/12345/principal/");
    }

    #[test]
    fn decodes_rfc2047_encoded_imap_text() {
        // "Hello World" encoded in Base64 UTF-8
        let encoded = b"=?UTF-8?B?SGVsbG8gV29ybGQ=?=";
        assert_eq!(decode_imap_text(encoded), "Hello World");

        // Plain text passes through untouched
        let plain = b"Standard English Subject";
        assert_eq!(decode_imap_text(plain), "Standard English Subject");
    }

    #[test]
    fn icloud_principal_host_allowlist_blocks_redirect_targets() {
        assert!(is_allowed_icloud_principal_host("caldav.icloud.com"));
        assert!(is_allowed_icloud_principal_host("p123-caldav.icloud.com"));
        assert!(is_allowed_icloud_principal_host("caldav.apple.com"));
        assert!(!is_allowed_icloud_principal_host("evil.example.com"));
        assert!(!is_allowed_icloud_principal_host(
            "icloud.com.evil.example.com"
        ));
        assert!(!is_allowed_icloud_principal_host(""));
    }
}
