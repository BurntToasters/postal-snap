use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use tokio::sync::Notify;

use super::parse::{parse_envelope, parse_message, received_at_fallback};
use super::send::{connect_imap, test_smtp};
use super::{
    ImapSession, BACKFILL_MESSAGE_BATCH, IMAP_COMMAND_TIMEOUT, INITIAL_MESSAGE_BATCH,
    MAX_MESSAGE_BYTES,
};
use crate::{
    db::{CachedMessage, Database},
    models::{
        mailbox_role_assignment, AccountRecord, AccountSetupRequest, CachePolicy, MailboxRole,
        MessageSummary, ProviderKind, SearchQuery, ServerConfig,
    },
    security::redact_error,
};

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
        let (role, role_source) = mailbox_role_assignment(&mailbox_name, &attributes);
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
        let mailbox_id = db.upsert_mailbox_with_source(
            &account.summary.id,
            &mailbox_name,
            &role,
            role_source,
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
            let flag_stream =
                tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.uid_fetch(set, "(UID FLAGS)"))
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
        session.uid_fetch(range, "(UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])"),
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

pub async fn refresh_mailbox_envelopes(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    db: &Database,
) -> Result<(), String> {
    let Some(mailbox_id) = db.mailbox_id_for_name(&account.summary.id, mailbox)? else {
        return Ok(());
    };
    let mut session = connect_imap(&account.imap, password).await?;
    let status = tokio::time::timeout(
        IMAP_COMMAND_TIMEOUT,
        session.status(mailbox, "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)"),
    )
    .await
    .map_err(|_| "Mailbox status timed out.".to_string())
    .and_then(|result| result.map_err(|error| redact_error(&error, "Mailbox status")));
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            let _ = session.logout().await;
            return Err(error);
        }
    };
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.examine(mailbox))
        .await
        .map_err(|_| "Mailbox sync timed out.".to_string())
        .and_then(|result| result.map_err(|error| redact_error(&error, "Mailbox sync")));
    let selected = match selected {
        Ok(selected) => selected,
        Err(error) => {
            let _ = session.logout().await;
            return Err(error);
        }
    };
    if let Some((previous_validity, ..)) = db.mailbox_sync_state(&account.summary.id, mailbox)? {
        if previous_validity.is_some()
            && selected.uid_validity.is_some()
            && previous_validity != selected.uid_validity
        {
            db.purge_stale_mailbox(&account.summary.id, mailbox, mailbox_id)?;
        }
    }
    if let Err(error) = db.update_mailbox_status(
        mailbox_id,
        selected.uid_validity,
        selected.uid_next,
        status.unseen,
        status.exists,
    ) {
        let _ = session.logout().await;
        return Err(error);
    }
    let max_uid = db.max_uid(mailbox_id)?;
    let start = max_uid.saturating_add(1).max(1);
    let refresh = async {
        if let Some(newest_uid) = newest_uid(&mut session, selected.exists).await? {
            if newest_uid >= start {
                cache_uid_range(
                    &mut session,
                    db,
                    &account.summary.id,
                    mailbox_id,
                    &format!("{start}:*"),
                    None,
                )
                .await?;
            }
        }
        Ok::<(), String>(())
    }
    .await;
    let _ = session.logout().await;
    refresh
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
    cached_received_at: Option<&str>,
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
            .uid_fetch(
                uid.to_string(),
                "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])",
            )
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
    let fallback = received_at_fallback(&item, cached_received_at);
    let parsed = parse_message(
        uid,
        raw,
        flags.contains("seen"),
        flags.contains("flagged"),
        fallback.as_deref(),
    )?;
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
    let cached_by_uid = uncached
        .iter()
        .cloned()
        .collect::<std::collections::HashMap<_, _>>();
    let range = uncached
        .iter()
        .map(|(uid, _)| uid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let fetch_result = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        session
            .uid_fetch(range, "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])")
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
        let fallback = received_at_fallback(&item, cached_by_uid.get(&uid).map(String::as_str));
        if let Ok(parsed) = parse_message(
            uid,
            raw,
            flags.contains("seen"),
            flags.contains("flagged"),
            fallback.as_deref(),
        ) {
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
