use std::{collections::HashSet, future::Future, time::Duration};

use async_imap::extensions::idle::IdleResponse;
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use tokio::sync::Notify;

use super::parse::{
    internal_date, parse_envelope, parse_message, received_at_fallback, system_flags,
};
use super::pool::{self, Lease};
use super::send::{connect_imap, test_smtp};
use super::{
    BodyBudget, BACKFILL_MESSAGE_BATCH, IMAP_COMMAND_TIMEOUT, INITIAL_MESSAGE_BATCH,
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

/// Cumulative body bytes one sync pass may download across all folders. Each
/// item is also capped by `MAX_MESSAGE_BYTES`; the watcher runs further passes
/// while more work remains, yielding to user actions in between.
const PREFETCH_TOTAL_BYTES: u64 = MAX_MESSAGE_BYTES as u64;

/// Bodies requested per prefetch command, so each round trip stays short and
/// the pass can yield to waiting user actions between batches.
const PREFETCH_BATCH: u32 = 10;

/// Upper bound on new-mail chunks pulled in a single sync pass.
const MAX_NEW_MAIL_CHUNKS: u32 = 200;

/// Backfill batches per folder per pass before moving on to other folders.
const BACKFILL_BATCHES_PER_PASS: u32 = 4;

/// Without CONDSTORE, flag changes that do not move UNSEEN (stars) are only
/// visible to a full flag scan, so rescan at least this often.
const FLAG_SCAN_INTERVAL: chrono::Duration = chrono::Duration::minutes(15);

/// Hooks the account worker gives a sync pass: it lets user actions preempt
/// background work between folders and batches, and reports progress.
pub trait SyncHooks: Send {
    /// True when a user action is waiting for this account.
    fn contended(&self) -> bool;
    /// Hand the account to waiting callers, then take it back.
    fn yield_account(&mut self) -> impl Future<Output = ()> + Send;
    /// Called when the pass moves to a folder or finishes a batch.
    fn progress(&mut self, folder: &str);
    /// Password to reconnect with after a yield. Removal and password changes
    /// run under the account lock while we yielded, so re-read the vault.
    fn current_password(&self, account_id: &str) -> Result<zeroize::Zeroizing<String>, String> {
        crate::credentials::load(account_id)
            .map_err(|_| "This account is no longer available.".to_string())
    }
}

/// Hooks for passes run without a worker (integration tests).
#[cfg(test)]
pub struct Uncontended;

#[cfg(test)]
impl SyncHooks for Uncontended {
    fn contended(&self) -> bool {
        false
    }

    async fn yield_account(&mut self) {}

    fn progress(&mut self, _folder: &str) {}
}

#[derive(Debug, Default)]
pub struct SyncOutcome {
    /// Backfill or body downloads remain; the worker should run another pass
    /// soon instead of waiting in IDLE.
    pub more_work: bool,
    /// Folders that failed this pass. Their errors are stored per folder.
    pub folder_errors: u32,
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
            let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
            Ok(imap.clone())
        }
        Err(first_error)
            if request.provider == ProviderKind::Icloud && imap.username != request.email =>
        {
            let mut fallback = imap.clone();
            fallback.username = request.email.to_lowercase();
            match connect_imap(&fallback, password).await {
                Ok(mut session) => {
                    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
                    Ok(fallback)
                }
                Err(_) => Err(first_error),
            }
        }
        Err(error) => Err(error),
    }
}

struct ListedFolder {
    name: String,
    delimiter: Option<String>,
    role: MailboxRole,
    role_source: &'static str,
    /// Junk, Trash and `\All` bodies are never prefetched: they are either
    /// unwanted or duplicate every other folder (Gmail-style All Mail).
    skip_prefetch: bool,
}

fn folder_rank(role: &MailboxRole) -> u8 {
    match role {
        MailboxRole::Inbox => 0,
        MailboxRole::Sent => 1,
        MailboxRole::Drafts => 2,
        MailboxRole::Archive => 3,
        MailboxRole::Other => 4,
        MailboxRole::Junk => 5,
        MailboxRole::Trash => 6,
    }
}

async fn list_folders(lease: &mut Lease) -> Result<Vec<ListedFolder>, String> {
    let list_stream = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.list(None, Some("*")))
        .await
        .map_err(|_| "Mailbox discovery timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox discovery"))?;
    let names = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, list_stream.try_collect::<Vec<_>>())
        .await
        .map_err(|_| "Mailbox discovery timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox discovery"))?;
    let mut folders = Vec::new();
    for name in names {
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
        let has = |expected: &str| {
            attributes.iter().any(|attribute| {
                attribute
                    .trim_start_matches('\\')
                    .eq_ignore_ascii_case(expected)
            })
        };
        if has("NoSelect") || has("NonExistent") {
            continue;
        }
        let mailbox_name = name.name().to_string();
        let (role, role_source) = mailbox_role_assignment(&mailbox_name, &attributes);
        let skip_prefetch = matches!(role, MailboxRole::Junk | MailboxRole::Trash) || has("All");
        folders.push(ListedFolder {
            delimiter: name.delimiter().map(ToOwned::to_owned),
            name: mailbox_name,
            role,
            role_source,
            skip_prefetch,
        });
    }
    folders.sort_by_key(|folder| folder_rank(&folder.role));
    Ok(folders)
}

/// Park the session, let waiting user actions run, then take the account and
/// a session back.
async fn yield_point<H: SyncHooks>(
    lease: Lease,
    hooks: &mut H,
    account: &AccountRecord,
    _password: &str,
) -> Result<Lease, String> {
    if !hooks.contended() {
        return Ok(lease);
    }
    lease.release();
    hooks.yield_account().await;
    // Never reconnect with a password the user just deleted or replaced.
    let current = hooks.current_password(&account.summary.id)?;
    pool::checkout(account, &current).await
}

/// Per-pass download allowance shared by every folder.
struct PassBudget {
    remaining: u64,
    /// Bytes the account may still add before reaching 90% of its cap.
    cap_room: Option<u64>,
}

impl PassBudget {
    fn available(&self) -> u64 {
        self.cap_room
            .map_or(self.remaining, |room| self.remaining.min(room))
    }

    fn consume(&mut self, bytes: u64) {
        self.remaining = self.remaining.saturating_sub(bytes);
        if let Some(room) = self.cap_room.as_mut() {
            *room = room.saturating_sub(bytes);
        }
    }
}

/// One sync pass over every selectable folder. A folder that fails is
/// recorded and skipped; only losing the connection itself fails the pass.
pub async fn sync_account<H: SyncHooks>(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
    hooks: &mut H,
) -> Result<SyncOutcome, String> {
    let account_id = &account.summary.id;
    let mut lease = pool::checkout(account, password).await?;
    let folders = match list_folders(&mut lease).await {
        Ok(folders) => folders,
        Err(error) => {
            lease.discard();
            return Err(error);
        }
    };
    let usage = db.account_cache_usage(account_id, policy.max_bytes)?;
    let mut budget = PassBudget {
        remaining: PREFETCH_TOTAL_BYTES,
        cap_room: (policy.max_bytes > 0)
            .then(|| (policy.max_bytes / 10 * 9).saturating_sub(usage.bytes)),
    };
    let mut outcome = SyncOutcome::default();
    let mut server_mailboxes = HashSet::new();
    for folder in &folders {
        server_mailboxes.insert(folder.name.clone());
        lease = yield_point(lease, hooks, account, password).await?;
        hooks.progress(&folder.name);
        match sync_folder(&mut lease, db, account, policy, folder, &mut budget, hooks).await {
            Ok(more) => {
                outcome.more_work |= more;
                let _ = db.set_mailbox_sync_error(account_id, &folder.name, None);
            }
            Err(_) => {
                outcome.folder_errors += 1;
                let _ = db.set_mailbox_sync_error(
                    account_id,
                    &folder.name,
                    Some("This folder could not be checked. It will be retried automatically."),
                );
                // The failed command may have left unread data on the wire;
                // never reuse that session. A reconnect failure means the
                // connection itself is gone and ends the pass.
                lease.discard();
                lease = pool::checkout(account, password).await?;
            }
        }
    }
    db.reconcile_mailboxes(account_id, &server_mailboxes)?;
    lease.release();
    let db = db.clone();
    let account_id = account_id.clone();
    let policy = policy.clone();
    tokio::task::spawn_blocking(move || db.evict_account_to_policy(&account_id, &policy))
        .await
        .map_err(|_| "Local mail cleanup stopped unexpectedly.".to_string())??;
    Ok(outcome)
}

async fn sync_folder<H: SyncHooks>(
    lease: &mut Lease,
    db: &Database,
    account: &AccountRecord,
    policy: &CachePolicy,
    folder: &ListedFolder,
    budget: &mut PassBudget,
    hooks: &mut H,
) -> Result<bool, String> {
    let account_id = &account.summary.id;
    let condstore = lease.capabilities.condstore;
    let items = if condstore {
        "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ)"
    } else {
        "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)"
    };
    let status = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.status(&folder.name, items))
        .await
        .map_err(|_| "Mailbox status timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox status"))?;
    let previous = match db.mailbox_id_for_name(account_id, &folder.name)? {
        Some(id) => Some(db.mailbox_sync_meta(id)?),
        None => None,
    };
    let mailbox_id = db.upsert_mailbox_with_source(
        account_id,
        &folder.name,
        &folder.role,
        folder.role_source,
        status.uid_validity,
        status.uid_next,
        status.unseen,
        status.exists,
    )?;
    db.set_mailbox_listing(mailbox_id, folder.delimiter.as_deref())?;
    let purged = previous.as_ref().is_some_and(|meta| {
        meta.uid_validity.is_some() && meta.uid_validity != status.uid_validity
    });
    let meta = db.mailbox_sync_meta(mailbox_id)?;
    let cutoff = policy.cutoff();
    let backfill_active = meta.backfill_state == "active"
        || (meta.backfill_state == "cutoff" && policy.mode == "full");
    let flag_scan_due = !condstore
        && (previous
            .as_ref()
            .is_none_or(|meta| meta.server_unread != status.unseen)
            || meta
                .last_flag_scan_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_none_or(|last| Utc::now() - last.with_timezone(&Utc) > FLAG_SCAN_INTERVAL));
    let unchanged = !purged
        && previous.as_ref().is_some_and(|meta| {
            meta.uid_next == status.uid_next
                && meta.server_total == Some(status.exists)
                && meta.server_unread == status.unseen
                && (!condstore || meta.highest_modseq == status.highest_modseq)
        });
    let wants_prefetch = !folder.skip_prefetch
        && budget.available() > 0
        && !db
            .prefetch_candidates(mailbox_id, policy, 1, u64::MAX, MAX_MESSAGE_BYTES as u64)?
            .is_empty();
    if unchanged && !backfill_active && !flag_scan_due && !wants_prefetch {
        return Ok(false);
    }
    if status.exists == 0 {
        db.reconcile_expunged(mailbox_id, 0, u32::MAX, &HashSet::new())?;
        db.set_backfill(mailbox_id, None, "complete")?;
        db.set_highest_modseq(mailbox_id, status.highest_modseq)?;
        return Ok(false);
    }
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(&folder.name))
        .await
        .map_err(|_| "Mailbox sync timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox sync"))?;
    if selected.uid_validity != status.uid_validity {
        return Err("Mailbox changed during sync.".into());
    }
    let Some(uid_validity) = selected.uid_validity else {
        return Err("Mailbox identity is unavailable.".into());
    };

    let max_uid = db.max_uid(mailbox_id)?;
    let mut new_fetched = 0u32;
    if max_uid == 0 {
        let start = selected
            .exists
            .saturating_sub(INITIAL_MESSAGE_BATCH.saturating_sub(1))
            .max(1);
        let fetched = cache_envelopes(
            lease,
            db,
            account_id,
            mailbox_id,
            EnvelopeRange::Sequence(start, selected.exists),
            cutoff.as_ref(),
        )
        .await?;
        new_fetched = fetched.count;
        let state = if start == 1 {
            "complete"
        } else if fetched.older_than_cutoff && policy.mode == "recent" {
            "cutoff"
        } else {
            "active"
        };
        db.set_backfill(mailbox_id, db.min_uid(mailbox_id)?, state)?;
    } else if status
        .uid_next
        .is_none_or(|next| next > max_uid.saturating_add(1))
    {
        let newest = status.uid_next.map(|next| next.saturating_sub(1));
        let mut start = max_uid.saturating_add(1);
        for _ in 0..MAX_NEW_MAIL_CHUNKS {
            let end = start.saturating_add(INITIAL_MESSAGE_BATCH.saturating_sub(1));
            let range = match newest {
                Some(newest) => EnvelopeRange::Uid(start, end.min(newest)),
                None => EnvelopeRange::UidOpen(start),
            };
            let fetched =
                cache_envelopes(lease, db, account_id, mailbox_id, range, cutoff.as_ref()).await?;
            new_fetched = new_fetched.saturating_add(fetched.count);
            match newest {
                Some(newest) if end < newest => start = end.saturating_add(1),
                _ => break,
            }
        }
    }

    let expunge_suspected = !purged
        && previous.as_ref().is_some_and(|meta| {
            meta.server_total
                .is_some_and(|total| status.exists < total.saturating_add(new_fetched))
        });
    let modseq_before_fetch = status.highest_modseq;
    if condstore && !purged && meta.highest_modseq.is_some() {
        let known = meta.highest_modseq.unwrap_or_default();
        if modseq_before_fetch != Some(known) {
            if let Some(low) = db.min_uid(mailbox_id)? {
                sync_changed_flags(lease, db, mailbox_id, low, known).await?;
            }
        }
        if expunge_suspected {
            reconcile_expunges(lease, db, mailbox_id).await?;
        }
        db.set_highest_modseq(mailbox_id, modseq_before_fetch)?;
    } else if condstore {
        full_flag_scan(lease, db, mailbox_id).await?;
        db.set_highest_modseq(mailbox_id, modseq_before_fetch)?;
    } else if flag_scan_due || expunge_suspected {
        full_flag_scan(lease, db, mailbox_id).await?;
    }

    let mut more_work = false;
    if backfill_active {
        let mut state = "active";
        for _ in 0..BACKFILL_BATCHES_PER_PASS {
            if hooks.contended() {
                break;
            }
            let step = backfill_batch(lease, db, account_id, mailbox_id, cutoff.as_ref()).await?;
            state = match step {
                BackfillStep::Complete => "complete",
                BackfillStep::ReachedCutoff if policy.mode == "recent" => "cutoff",
                _ => "active",
            };
            db.set_backfill(mailbox_id, db.min_uid(mailbox_id)?, state)?;
            if state != "active" {
                break;
            }
        }
        more_work |= state == "active";
    }

    if !folder.skip_prefetch {
        more_work |=
            prefetch_bodies(lease, db, mailbox_id, uid_validity, policy, budget, hooks).await?;
    }
    Ok(more_work)
}

enum EnvelopeRange {
    Uid(u32, u32),
    UidOpen(u32),
    Sequence(u32, u32),
}

struct EnvelopeBatch {
    count: u32,
    older_than_cutoff: bool,
}

/// No BODYSTRUCTURE: one hostile, deeply nested message would make the whole
/// batch unparseable and stall the folder. The attachment hint comes from the
/// top-level Content-Type instead.
const ENVELOPE_QUERY_PREFIX: &str =
    "(UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE)]";

/// Fetch one chunk of envelopes and store it in a single transaction.
async fn cache_envelopes(
    lease: &mut Lease,
    db: &Database,
    account_id: &str,
    mailbox_id: i64,
    range: EnvelopeRange,
    cutoff: Option<&DateTime<Utc>>,
) -> Result<EnvelopeBatch, String> {
    let query = format!("{ENVELOPE_QUERY_PREFIX}<0.{}>)", MAX_MESSAGE_BYTES + 1);
    let mut fetched = match range {
        EnvelopeRange::Uid(start, end) => tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            lease.uid_fetch(format!("{start}:{end}"), &query),
        )
        .await
        .map(|result| result.map(futures_util::future::Either::Left)),
        EnvelopeRange::UidOpen(start) => tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            lease.uid_fetch(format!("{start}:*"), &query),
        )
        .await
        .map(|result| result.map(futures_util::future::Either::Left)),
        EnvelopeRange::Sequence(start, end) => tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            lease.fetch(format!("{start}:{end}"), &query),
        )
        .await
        .map(|result| result.map(futures_util::future::Either::Right)),
    }
    .map_err(|_| "Message list download timed out.".to_string())?
    .map_err(|error| redact_error(&error, "Message list download"))?;
    let mut parsed_rows = Vec::new();
    let mut age_marks: Vec<(u32, bool)> = Vec::new();
    loop {
        let next = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, fetched.try_next())
            .await
            .map_err(|_| "Message list download timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Message list download"))?;
        let Some(item) = next else {
            break;
        };
        let (seen, flagged) = system_flags(&item);
        let Ok(parsed) = parse_envelope(&item, seen, flagged) else {
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
        age_marks.push((parsed.uid, is_old));
        parsed_rows.push(parsed);
    }
    drop(fetched);
    let threaded = parsed_rows
        .iter()
        .map(|parsed| {
            parsed
                .message_id
                .clone()
                .unwrap_or_else(|| crate::db::synthetic_thread_id(mailbox_id, parsed.uid))
        })
        .collect::<Vec<_>>();
    let count = parsed_rows.len() as u32;
    let writer = db.clone();
    let owner = account_id.to_string();
    tokio::task::spawn_blocking(move || {
        writer.upsert_envelopes(&owner, mailbox_id, &parsed_rows)?;
        let _ = writer.repair_thread_roots(&owner, &threaded);
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "Saving the message list stopped unexpectedly.".to_string())??;
    Ok(EnvelopeBatch {
        count,
        older_than_cutoff: crossed_cutoff(age_marks),
    })
}

/// A batch crossed the Recent cutoff when its three lowest UIDs are all older
/// than the cutoff; a single misdated message does not end backfill.
fn crossed_cutoff(mut age_marks: Vec<(u32, bool)>) -> bool {
    age_marks.sort_unstable_by_key(|(uid, _)| *uid);
    let mut consecutive_old = 0u32;
    for (_, is_old) in age_marks {
        if !is_old {
            break;
        }
        consecutive_old += 1;
        if consecutive_old >= 3 {
            return true;
        }
    }
    false
}

enum BackfillStep {
    Continue,
    ReachedCutoff,
    Complete,
}

/// Fetch the batch of envelopes directly below the oldest cached message.
/// Sequence numbers make the step independent of UID gaps, so a mailbox whose
/// UIDs start in the millions still backfills in `BACKFILL_MESSAGE_BATCH`
/// messages per round trip.
async fn backfill_batch(
    lease: &mut Lease,
    db: &Database,
    account_id: &str,
    mailbox_id: i64,
    cutoff: Option<&DateTime<Utc>>,
) -> Result<BackfillStep, String> {
    let Some(oldest) = db.min_uid(mailbox_id)? else {
        return Ok(BackfillStep::Complete);
    };
    if oldest <= 1 {
        return Ok(BackfillStep::Complete);
    }
    let rows = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        lease
            .uid_fetch(oldest.to_string(), "(UID)")
            .await?
            .try_collect::<Vec<_>>()
            .await
    })
    .await
    .map_err(|_| "Older mail download timed out.".to_string())?
    .map_err(|error| redact_error(&error, "Older mail download"))?;
    let sequence = rows
        .iter()
        .find(|row| row.uid == Some(oldest))
        .map(|row| row.message);
    let batch = match sequence {
        Some(sequence) if sequence <= 1 => return Ok(BackfillStep::Complete),
        Some(sequence) => {
            let start = sequence.saturating_sub(BACKFILL_MESSAGE_BATCH).max(1);
            let batch = cache_envelopes(
                lease,
                db,
                account_id,
                mailbox_id,
                EnvelopeRange::Sequence(start, sequence - 1),
                cutoff,
            )
            .await?;
            if start == 1 {
                return Ok(BackfillStep::Complete);
            }
            batch
        }
        None => {
            // The oldest cached message was expunged; find what is below it.
            let mut below = tokio::time::timeout(
                IMAP_COMMAND_TIMEOUT,
                lease.uid_search(format!("UID 1:{}", oldest - 1)),
            )
            .await
            .map_err(|_| "Older mail download timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Older mail download"))?
            .into_iter()
            .collect::<Vec<_>>();
            if below.is_empty() {
                return Ok(BackfillStep::Complete);
            }
            below.sort_unstable();
            let start = below[below.len().saturating_sub(BACKFILL_MESSAGE_BATCH as usize)];
            cache_envelopes(
                lease,
                db,
                account_id,
                mailbox_id,
                EnvelopeRange::Uid(start, oldest - 1),
                cutoff,
            )
            .await?
        }
    };
    Ok(if batch.older_than_cutoff {
        BackfillStep::ReachedCutoff
    } else {
        BackfillStep::Continue
    })
}

async fn sync_changed_flags(
    lease: &mut Lease,
    db: &Database,
    mailbox_id: i64,
    low: u32,
    since: u64,
) -> Result<(), String> {
    let rows = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        lease
            .uid_fetch(
                format!("{low}:*"),
                format!("(UID FLAGS) (CHANGEDSINCE {since})"),
            )
            .await?
            .try_collect::<Vec<_>>()
            .await
    })
    .await
    .map_err(|_| "Flag sync timed out.".to_string())?
    .map_err(|error| redact_error(&error, "Flag sync"))?;
    let changed = rows
        .iter()
        .filter_map(|item| {
            let (seen, flagged) = system_flags(item);
            item.uid.map(|uid| (uid, seen, flagged))
        })
        .collect::<Vec<_>>();
    db.reconcile_flags(mailbox_id, &changed, &[])
}

/// Refresh flags for every cached UID and drop rows the server no longer has.
async fn full_flag_scan(lease: &mut Lease, db: &Database, mailbox_id: i64) -> Result<(), String> {
    for chunk in db.cached_uids(mailbox_id)?.chunks(250) {
        let (Some(low), Some(high)) = (chunk.first(), chunk.last()) else {
            continue;
        };
        let rows = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            lease
                .uid_fetch(format!("{low}:{high}"), "(UID FLAGS)")
                .await?
                .try_collect::<Vec<_>>()
                .await
        })
        .await
        .map_err(|_| "Flag sync timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Flag sync"))?;
        let seen = rows
            .iter()
            .filter_map(|item| {
                let (seen, flagged) = system_flags(item);
                item.uid.map(|uid| (uid, seen, flagged))
            })
            .collect::<Vec<_>>();
        db.reconcile_flags(mailbox_id, &seen, chunk)?;
    }
    db.mark_flag_scan(mailbox_id)
}

/// Remove cached rows that were expunged on the server, using the server's
/// UID list for the cached range rather than trusting message counts alone.
async fn reconcile_expunges(
    lease: &mut Lease,
    db: &Database,
    mailbox_id: i64,
) -> Result<(), String> {
    let (Some(low), high) = (db.min_uid(mailbox_id)?, db.max_uid(mailbox_id)?) else {
        return Ok(());
    };
    let server = tokio::time::timeout(
        IMAP_COMMAND_TIMEOUT,
        lease.uid_search(format!("UID {low}:{high}")),
    )
    .await
    .map_err(|_| "Mailbox check timed out.".to_string())?
    .map_err(|error| redact_error(&error, "Mailbox check"))?;
    db.reconcile_expunged(mailbox_id, low, high, &server)?;
    Ok(())
}

/// Download bodies for the next candidates in this folder. Returns whether
/// candidates remain after this pass.
async fn prefetch_bodies<H: SyncHooks>(
    lease: &mut Lease,
    db: &Database,
    mailbox_id: i64,
    uid_validity: u32,
    policy: &CachePolicy,
    budget: &mut PassBudget,
    hooks: &mut H,
) -> Result<bool, String> {
    loop {
        if hooks.contended() {
            return Ok(true);
        }
        let available = budget.available();
        if available == 0 {
            return Ok(!db
                .prefetch_candidates(mailbox_id, policy, 1, u64::MAX, MAX_MESSAGE_BYTES as u64)?
                .is_empty());
        }
        let candidates = db.prefetch_candidates(
            mailbox_id,
            policy,
            PREFETCH_BATCH,
            available,
            MAX_MESSAGE_BYTES as u64,
        )?;
        if candidates.is_empty() {
            return Ok(false);
        }
        let consumed =
            download_body_batch(lease, db, mailbox_id, uid_validity, &candidates).await?;
        budget.consume(consumed.max(1));
    }
}

async fn download_body_batch(
    lease: &mut Lease,
    db: &Database,
    mailbox_id: i64,
    uid_validity: u32,
    candidates: &[(u32, String)],
) -> Result<u64, String> {
    let cached_by_uid = candidates
        .iter()
        .cloned()
        .collect::<std::collections::HashMap<_, _>>();
    let range = candidates
        .iter()
        .map(|(uid, _)| uid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let body_query = body_fetch_query("UID FLAGS RFC822.SIZE INTERNALDATE");
    let mut fetched =
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.uid_fetch(range, body_query))
            .await
            .map_err(|_| "Message prefetch timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Message prefetch"))?;
    let mut budget = BodyBudget::default();
    let mut delivered = HashSet::new();
    let mut consumed = 0u64;
    loop {
        let next = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, fetched.try_next())
            .await
            .map_err(|_| "Message prefetch timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Message prefetch"))?;
        let Some(item) = next else {
            break;
        };
        let (Some(uid), Some(raw)) = (item.uid, item.body()) else {
            continue;
        };
        // The delivered length decides, never the declared RFC822.SIZE, and
        // the cumulative budget stops a hostile server from filling memory or
        // the database. Over-budget bodies are drained and dropped.
        if !budget.admit(raw.len(), MAX_MESSAGE_BYTES, PREFETCH_TOTAL_BYTES as usize) {
            continue;
        }
        let (seen, flagged) = system_flags(&item);
        let fallback = received_at_fallback(&item, cached_by_uid.get(&uid).map(String::as_str));
        match parse_message(uid, raw, seen, flagged, fallback.as_deref()) {
            Ok(mut parsed) => {
                parsed.internal_at = internal_date(&item);
                consumed = consumed.saturating_add(raw.len() as u64);
                delivered.insert(uid);
                if db.attach_body_if_current(mailbox_id, uid_validity, &parsed)? {
                    let id = parsed
                        .message_id
                        .clone()
                        .unwrap_or_else(|| crate::db::synthetic_thread_id(mailbox_id, parsed.uid));
                    let _ = db.repair_thread_roots(&parsed_account(db, mailbox_id)?, &[id]);
                }
            }
            Err(_) => {
                delivered.insert(uid);
                db.record_prefetch_failure(mailbox_id, uid)?;
            }
        }
    }
    for (uid, _) in candidates {
        if !delivered.contains(uid) {
            db.record_prefetch_failure(mailbox_id, *uid)?;
        }
    }
    Ok(consumed)
}

fn parsed_account(db: &Database, mailbox_id: i64) -> Result<String, String> {
    db.mailbox(mailbox_id).map(|(account_id, _)| account_id)
}

/// Fetch one batch of envelopes older than everything cached, ignoring the
/// Recent cutoff. Used by "Load older messages" in the message list.
pub async fn load_older_messages(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
) -> Result<(u32, bool), String> {
    let account_id = &account.summary.id;
    let Some(mailbox_id) = db.mailbox_id_for_name(account_id, mailbox)? else {
        return Err("That folder is no longer available.".into());
    };
    let mut lease = pool::checkout(account, password).await?;
    let result = async {
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(mailbox))
            .await
            .map_err(|_| "Older mail download timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Older mail download"))?;
        if selected.uid_validity != db.mailbox_uid_validity(account_id, mailbox)? {
            return Err("This mailbox changed; refresh mail and try again.".to_string());
        }
        let before = db.cached_message_count(mailbox_id)?;
        let step = backfill_batch(&mut lease, db, account_id, mailbox_id, None).await?;
        let after = db.cached_message_count(mailbox_id)?;
        let meta = db.mailbox_sync_meta(mailbox_id)?;
        let has_more = !matches!(step, BackfillStep::Complete);
        let state = if has_more {
            if meta.backfill_state == "active" {
                "active"
            } else {
                "cutoff"
            }
        } else {
            "complete"
        };
        db.set_backfill(mailbox_id, db.min_uid(mailbox_id)?, state)?;
        Ok((after.saturating_sub(before), has_more))
    }
    .await;
    match result {
        Ok(value) => {
            lease.release();
            Ok(value)
        }
        Err(error) => {
            lease.discard();
            Err(error)
        }
    }
}

/// Bring one folder's newest envelopes and counts up to date after a local
/// action (move destination, draft save).
pub async fn refresh_mailbox_envelopes(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    db: &Database,
    policy: &CachePolicy,
) -> Result<(), String> {
    let Some(mailbox_id) = db.mailbox_id_for_name(&account.summary.id, mailbox)? else {
        return Ok(());
    };
    let cutoff = policy.cutoff();
    let mut lease = pool::checkout(account, password).await?;
    let refresh = async {
        let status = tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            lease.status(mailbox, "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)"),
        )
        .await
        .map_err(|_| "Mailbox status timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox status"))?;
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(mailbox))
            .await
            .map_err(|_| "Mailbox sync timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Mailbox sync"))?;
        if let Some((previous_validity, ..)) =
            db.mailbox_sync_state(&account.summary.id, mailbox)?
        {
            if should_purge_stale_generation(previous_validity, selected.uid_validity) {
                db.purge_stale_mailbox(&account.summary.id, mailbox, mailbox_id)?;
            }
        }
        db.update_mailbox_status(
            mailbox_id,
            selected.uid_validity,
            selected.uid_next,
            status.unseen,
            status.exists,
        )?;
        let max_uid = db.max_uid(mailbox_id)?;
        if selected.exists == 0 {
            return Ok(());
        }
        if max_uid == 0 {
            // Treat a purged (or never synced) folder like an initial sync so
            // backfill does not resume against stale UIDs.
            let start = refresh_window_start(0, selected.exists, INITIAL_MESSAGE_BATCH);
            let fetched = cache_envelopes(
                &mut lease,
                db,
                &account.summary.id,
                mailbox_id,
                EnvelopeRange::Sequence(start, selected.exists),
                cutoff.as_ref(),
            )
            .await?;
            let state = if start == 1 {
                "complete"
            } else if fetched.older_than_cutoff && policy.mode == "recent" {
                "cutoff"
            } else {
                "active"
            };
            db.set_backfill(mailbox_id, db.min_uid(mailbox_id)?, state)?;
        } else if selected
            .uid_next
            .is_none_or(|next| next > max_uid.saturating_add(1))
        {
            let start = refresh_window_start(max_uid, 0, INITIAL_MESSAGE_BATCH);
            cache_envelopes(
                &mut lease,
                db,
                &account.summary.id,
                mailbox_id,
                EnvelopeRange::UidOpen(start),
                cutoff.as_ref(),
            )
            .await?;
        }
        Ok::<(), String>(())
    }
    .await;
    match refresh {
        Ok(()) => {
            lease.release();
            Ok(())
        }
        Err(error) => {
            lease.discard();
            Err(error)
        }
    }
}

/// Bound a post-refresh fetch the same way initial sync does: when nothing is
/// cached (including after a UIDVALIDITY purge) fetch only the newest
/// `INITIAL_MESSAGE_BATCH` messages, by sequence number, instead of `1:*`.
fn refresh_window_start(max_uid: u32, newest: u32, batch: u32) -> u32 {
    if max_uid == 0 {
        newest.saturating_sub(batch.saturating_sub(1)).max(1)
    } else {
        max_uid.saturating_add(1)
    }
}

/// Purge cached rows whenever a previously known UIDVALIDITY differs from the
/// currently selected one, including when the server stops reporting validity.
fn should_purge_stale_generation(previous: Option<u32>, selected: Option<u32>) -> bool {
    previous.is_some() && previous != selected
}

#[derive(Debug, PartialEq, Eq)]
pub enum IdleOutcome {
    /// The server reported a change in INBOX.
    Changed,
    /// Nothing happened before the refresh interval.
    Timeout,
    /// A local wake-up (user action, outbox timer, settings) ended the wait.
    Interrupted,
}

/// Wait in IDLE on INBOX using the account's pooled session. Servers without
/// IDLE are polled: the wait simply sleeps for `limit` (capped at two minutes).
pub async fn idle_inbox(
    account: &AccountRecord,
    password: &str,
    wake: &Notify,
    limit: Duration,
) -> Result<IdleOutcome, String> {
    let mut lease = pool::checkout(account, password).await?;
    if !lease.capabilities.idle {
        lease.release();
        return Ok(tokio::select! {
            _ = tokio::time::sleep(limit.min(Duration::from_secs(120))) => IdleOutcome::Timeout,
            _ = wake.notified() => IdleOutcome::Interrupted,
        });
    }
    if let Err(error) = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine("INBOX"))
        .await
        .map_err(|_| "Inbox monitoring timed out.".to_string())
        .and_then(|result| result.map_err(|error| redact_error(&error, "Inbox monitoring")))
    {
        lease.discard();
        return Err(error);
    }
    let Some(session) = lease.take_session() else {
        return Err("Inbox monitoring is unavailable.".into());
    };
    let mut idle = session.idle();
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, idle.init())
        .await
        .map_err(|_| "Inbox monitoring initialization timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Inbox monitoring"))?;
    let response = {
        let (wait, interrupt) = idle.wait_with_timeout(limit);
        tokio::pin!(wait);
        tokio::select! {
            result = &mut wait => result.map_err(|error| redact_error(&error, "Inbox monitoring"))?,
            _ = wake.notified() => {
                drop(interrupt);
                wait.as_mut().await.map_err(|error| redact_error(&error, "Inbox monitoring"))?
            },
        }
    };
    if let Ok(Ok(session)) = tokio::time::timeout(Duration::from_secs(5), idle.done()).await {
        lease.restore_session(session);
        lease.release();
    }
    Ok(match response {
        IdleResponse::NewData(_) => IdleOutcome::Changed,
        IdleResponse::Timeout => IdleOutcome::Timeout,
        IdleResponse::ManualInterrupt => IdleOutcome::Interrupted,
    })
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
        .take(200)
        .filter(|character| !character.is_control())
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    if search_text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut lease = pool::checkout(account, password).await?;
    match search_mailboxes(&mut lease, db, account, query, &search_text, mailboxes).await {
        Ok(results) => {
            lease.release();
            Ok(results)
        }
        Err(error) => {
            lease.discard();
            Err(error)
        }
    }
}

async fn search_mailboxes(
    lease: &mut Lease,
    db: &Database,
    account: &AccountRecord,
    query: &SearchQuery,
    search_text: &str,
    mailboxes: Vec<(i64, String)>,
) -> Result<Vec<MessageSummary>, String> {
    let mut results = Vec::new();
    // Bound all-folders searches so the account actor is not monopolized; a
    // later search resumes from fresh results.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    for (mailbox_id, name) in mailboxes {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(&name))
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
        let mut uids = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.uid_search(&search_cmd))
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
        let header_query = format!(
            "(UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE)]<0.{}>)",
            MAX_MESSAGE_BYTES + 1
        );
        let fetched = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
            lease
                .uid_fetch(set, header_query)
                .await?
                .try_collect::<Vec<_>>()
                .await
        })
        .await
        .map_err(|_| "Server search timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Server search"))?;
        let parsed = fetched
            .iter()
            .filter_map(|item| {
                let (seen, flagged) = system_flags(item);
                parse_envelope(item, seen, flagged).ok()
            })
            .collect::<Vec<_>>();
        db.upsert_envelopes(&account.summary.id, mailbox_id, &parsed)?;
        for message in &parsed {
            if let Some(summary) = db.message_summary_by_uid(mailbox_id, message.uid)? {
                results.push(summary);
            }
        }
        let threaded: Vec<String> = parsed
            .iter()
            .map(|message| {
                message
                    .message_id
                    .clone()
                    .unwrap_or_else(|| crate::db::synthetic_thread_id(mailbox_id, message.uid))
            })
            .collect();
        let _ = db.repair_thread_roots(&account.summary.id, &threaded);
    }
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

/// Time allowed to receive one on-demand message body: the normal command
/// timeout plus one second per 100 KB declared, at most ten minutes, so a
/// large message on a slow link can still open.
fn download_timeout(expected_size: u64) -> Duration {
    (IMAP_COMMAND_TIMEOUT + Duration::from_secs(expected_size / 100_000))
        .min(Duration::from_secs(600))
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
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        "Mailbox identity is unavailable; refresh mail and try again.".to_string()
    })?;
    let mut lease = pool::checkout(account, password).await?;
    let result = async {
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(mailbox))
            .await
            .map_err(|_| "Message download timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Message download"))?;
        if selected.uid_validity != Some(expected_uid_validity) {
            return Err("This mailbox changed; refresh mail and try again.".to_string());
        }
        let body_query = body_fetch_query("UID FLAGS RFC822.SIZE INTERNALDATE");
        let mut rows = tokio::time::timeout(download_timeout(expected_size), async {
            lease
                .uid_fetch(uid.to_string(), body_query)
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
        let (seen, flagged) = system_flags(&item);
        let fallback = received_at_fallback(&item, cached_received_at);
        let mut parsed = parse_message(uid, raw, seen, flagged, fallback.as_deref())?;
        parsed.internal_at = internal_date(&item);
        Ok(parsed)
    }
    .await;
    match result {
        Ok(parsed) => {
            lease.release();
            Ok(parsed)
        }
        Err(error) => {
            lease.discard();
            Err(error)
        }
    }
}

pub(crate) fn body_fetch_query(prefix: &str) -> String {
    #[cfg(test)]
    if std::env::var_os("POSTAL_SNAP_MAIL_INTEGRATION").is_some() {
        return format!("({prefix} BODY.PEEK[])");
    }
    format!("({prefix} BODY.PEEK[]<0.{}>)", MAX_MESSAGE_BYTES + 1)
}

#[cfg(test)]
mod tests {
    use super::{refresh_window_start, should_purge_stale_generation, INITIAL_MESSAGE_BATCH};

    #[test]
    fn refresh_window_bounds_post_purge_fetch_to_initial_batch() {
        assert_eq!(
            refresh_window_start(0, 10_000, INITIAL_MESSAGE_BATCH),
            9_851
        );
        assert_eq!(refresh_window_start(0, 1, INITIAL_MESSAGE_BATCH), 1);
        assert_eq!(refresh_window_start(0, 150, INITIAL_MESSAGE_BATCH), 1);
        assert_eq!(
            refresh_window_start(151, 10_000, INITIAL_MESSAGE_BATCH),
            152
        );
        assert_eq!(
            refresh_window_start(u32::MAX, u32::MAX, INITIAL_MESSAGE_BATCH),
            u32::MAX
        );
    }

    #[test]
    fn stale_generation_purge_covers_lost_uid_validity() {
        assert!(should_purge_stale_generation(Some(7), None));
        assert!(should_purge_stale_generation(Some(7), Some(8)));
        assert!(!should_purge_stale_generation(Some(7), Some(7)));
        assert!(!should_purge_stale_generation(None, Some(7)));
        assert!(!should_purge_stale_generation(None, None));
    }
}
