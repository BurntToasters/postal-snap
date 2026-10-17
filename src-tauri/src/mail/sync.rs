use std::{
    collections::{HashMap, HashSet},
    future::Future,
    time::Duration,
};

use async_imap::extensions::idle::IdleResponse;
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use tokio::sync::Notify;

use async_imap::types::Mailbox;

use super::connect::connect_imap;
use super::failure::{FailureKind, MailError};
use super::list_status::{self, ListStatusError, ListedName};
use super::parse::{
    internal_date, parse_envelope, parse_message, parse_partial_message, received_at_fallback,
    reply_flags, system_flags,
};
use super::pool::{self, Lease};
use super::qresync::{
    decide_expunge_path, drain_vanished, plan_vanished, ExpungePath, VanishedPlan,
};
use super::send::test_smtp;
use super::{
    BodyBudget, BACKFILL_MESSAGE_BATCH, IMAP_COMMAND_TIMEOUT, INITIAL_MESSAGE_BATCH,
    MAX_MESSAGE_BYTES,
};
use crate::{
    db::{CachedMessage, Database},
    models::{
        mailbox_role_assignment, AccountRecord, AccountSetupRequest, CachePolicy, MailboxRole,
        MessageSummary, ProviderKind, SearchQuery, ServerConfig, ROLE_SOURCE_NAME,
        ROLE_SOURCE_SPECIAL_USE,
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

/// Messages above this size prefetch only their first bytes, unless the user
/// keeps attachments offline. The full body downloads when it is needed.
pub(crate) const PARTIAL_BODY_THRESHOLD: u64 = 1024 * 1024;

/// Bytes requested for a partial body.
pub(crate) const PARTIAL_BODY_BYTES: usize = 256 * 1024;

/// Whether a body request asks for the whole message or its first bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BodyFetch {
    Full,
    Partial,
}

pub(crate) fn body_fetch_for(size: u64, keep_attachments_offline: bool) -> BodyFetch {
    if keep_attachments_offline || size <= PARTIAL_BODY_THRESHOLD {
        BodyFetch::Full
    } else {
        BodyFetch::Partial
    }
}

/// A server that ignores the range sends the whole message, which is longer
/// than the prefix and must be handled as a full body.
pub(crate) fn response_is_partial(requested: BodyFetch, raw_len: usize) -> bool {
    requested == BodyFetch::Partial && raw_len <= PARTIAL_BODY_BYTES
}

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

    /// Get Mail: fetch new envelopes and flags only. Backfill and body
    /// downloads are left to the worker's next pass.
    fn quick(&self) -> bool {
        false
    }

    /// New envelopes were cached in one folder.
    fn folder_changed(&mut self) {}
    fn validate_connection(&self, _account: &AccountRecord) -> Result<(), String> {
        Ok(())
    }

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

pub async fn probe_mail_login(
    imap: &ServerConfig,
    smtp: &ServerConfig,
    email: &str,
    secret: &str,
    xoauth2: bool,
) -> Result<(), String> {
    let mut session = super::connect::connect_imap_auth(imap, secret, xoauth2)
        .await
        .map_err(|error| format!("IMAP connection test failed: {error}"))?;
    let _ = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.logout()).await;
    super::send::test_smtp_auth(smtp, email, secret, xoauth2)
        .await
        .map_err(|error| format!("SMTP connection test failed: {error}"))?;
    Ok(())
}

pub async fn test_account(
    request: &AccountSetupRequest,
    imap: &ServerConfig,
    smtp: &ServerConfig,
    password: &str,
) -> Result<(ServerConfig, ServerConfig), String> {
    let tested_imap = test_imap_with_icloud_fallback(request, imap, password)
        .await
        .map_err(|error| format!("IMAP connection test failed: {error}"))?;
    test_smtp(smtp, &request.email, password)
        .await
        .map_err(|error| format!("SMTP connection test failed: {error}"))?;
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
                Err(_) => Err(first_error.into()),
            }
        }
        Err(error) => Err(error.into()),
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
    /// STATUS from a LIST-STATUS reply; None means ask the server.
    prefetched: Option<Mailbox>,
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

async fn list_folders(
    lease: &mut Lease,
    provider: &ProviderKind,
) -> Result<Vec<ListedFolder>, String> {
    let list_stream = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.list(None, Some("*")))
        .await
        .map_err(|_| "Mailbox discovery timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox discovery"))?;
    let names = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, list_stream.try_collect::<Vec<_>>())
        .await
        .map_err(|_| "Mailbox discovery timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox discovery"))?;
    let listed: Vec<ListedName> = names
        .iter()
        .map(|name| ListedName {
            wire_name: name.name().to_string(),
            delimiter: name.delimiter().map(ToOwned::to_owned),
            attributes: list_status::attribute_names(name.attributes()),
        })
        .collect();
    Ok(folders_from_listing(&listed, HashMap::new(), provider))
}

/// Selectable folders from LIST entries. A STATUS from the same reply is
/// attached to the folder it names. Every STATUS is consumed here, so a
/// NoSelect or unknown name's STATUS is dropped.
fn folders_from_listing(
    names: &[ListedName],
    mut statuses: HashMap<String, Mailbox>,
    provider: &ProviderKind,
) -> Vec<ListedFolder> {
    let mut folders: Vec<ListedFolder> = names
        .iter()
        .filter_map(|listed| {
            let mut folder = build_folder(listed, provider)?;
            folder.prefetched = statuses.remove(&listed.wire_name);
            Some(folder)
        })
        .collect();
    folders.sort_by_key(|folder| folder_rank(&folder.role));
    folders
}

/// A folder from one LIST entry, or None for NoSelect and NonExistent names.
fn build_folder(listed: &ListedName, provider: &ProviderKind) -> Option<ListedFolder> {
    let attributes = &listed.attributes;
    let has = |expected: &str| {
        attributes.iter().any(|attribute| {
            attribute
                .trim_start_matches('\\')
                .eq_ignore_ascii_case(expected)
        })
    };
    if has("NoSelect") || has("NonExistent") {
        return None;
    }
    let mailbox_name = super::utf7::decode(&listed.wire_name);
    let lower_name = mailbox_name.to_ascii_lowercase();
    let delimiter = listed.delimiter.as_deref();
    let bridge_all = *provider == ProviderKind::ProtonBridge
        && (has("All") || matches!(lower_name.as_str(), "all mail" | "allmail" | "all"));
    let bridge_label = *provider == ProviderKind::ProtonBridge
        && (lower_name == "labels"
            || delimiter
                .filter(|delimiter| !delimiter.is_empty())
                .is_some_and(|delimiter| lower_name.starts_with(&format!("labels{delimiter}"))));
    // Bridge labels and All Mail retain their hierarchy and names.
    let (role, role_source) = if bridge_all || bridge_label {
        (MailboxRole::Other, ROLE_SOURCE_NAME)
    } else {
        mailbox_role_assignment(&mailbox_name, attributes)
    };
    let skip_prefetch =
        matches!(role, MailboxRole::Junk | MailboxRole::Trash) || has("All") || bridge_all;
    Some(ListedFolder {
        delimiter: listed.delimiter.clone(),
        name: mailbox_name,
        role,
        role_source,
        skip_prefetch,
        prefetched: None,
    })
}

/// STATUS items for a pass. HIGHESTMODSEQ only with CONDSTORE.
fn status_items(condstore: bool) -> &'static str {
    if condstore {
        "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ)"
    } else {
        "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)"
    }
}

/// Park the session, let waiting user actions run, then take the account and
/// a session back.
async fn yield_point<H: SyncHooks>(
    lease: Lease,
    hooks: &mut H,
    account: &AccountRecord,
    _password: &str,
) -> Result<Lease, MailError> {
    if !hooks.contended() {
        return Ok(lease);
    }
    lease.release();
    hooks.yield_account().await;
    // Never reconnect with a secret the user just deleted or replaced.
    hooks.validate_connection(account)?;
    let current = if account.summary.auth_method == "oauth" {
        crate::oauth::session_secret(account).await?
    } else {
        hooks.current_password(&account.summary.id)?
    };
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

/// Which folders a pass covers. `Folders` takes its list from the cache, so
/// it never reconciles the folder list or evicts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncScope {
    All,
    Folders(Vec<String>),
}

/// One full sync pass for tests. A folder that fails is recorded and skipped;
/// only losing the connection itself fails the pass.
#[cfg(test)]
pub async fn sync_account<H: SyncHooks>(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
    hooks: &mut H,
) -> Result<SyncOutcome, MailError> {
    sync_account_scoped(db, account, password, policy, SyncScope::All, hooks).await
}

/// A sync pass over `scope`. Folder-scoped passes skip LIST, folder
/// reconciliation and cache eviction; the full pass owns those.
pub async fn sync_account_scoped<H: SyncHooks>(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
    scope: SyncScope,
    hooks: &mut H,
) -> Result<SyncOutcome, MailError> {
    let account_id = &account.summary.id;
    let mut lease = pool::checkout(account, password).await?;
    let folders = match &scope {
        SyncScope::All => {
            // One LIST-STATUS round trip when offered. Any refusal or bad
            // reply uses the legacy LIST plus per-folder STATUS path.
            let condstore = lease.capabilities.condstore;
            let special_use = lease.capabilities.special_use;
            let answered = if lease.capabilities.list_status {
                match list_status::fetch(&mut lease, status_items(condstore), special_use).await {
                    Ok(reply) => Some(reply),
                    Err(ListStatusError::Broken) => {
                        lease.discard();
                        lease = pool::checkout(account, password).await?;
                        None
                    }
                    Err(ListStatusError::Refused | ListStatusError::Rejected) => None,
                }
            } else {
                None
            };
            match answered {
                Some(reply) => {
                    folders_from_listing(&reply.names, reply.statuses, &account.summary.provider)
                }
                None => match list_folders(&mut lease, &account.summary.provider).await {
                    Ok(folders) => folders,
                    Err(error) => {
                        lease.discard();
                        return Err(MailError::connection(error));
                    }
                },
            }
        }
        SyncScope::Folders(names) => folders_in_scope(db, account_id, names)?,
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
            Ok((more, changed)) => {
                outcome.more_work |= more;
                if changed {
                    hooks.folder_changed();
                }
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
    reconcile_scope(db, account_id, &scope, &server_mailboxes)?;
    lease.release();
    if scope == SyncScope::All {
        let db = db.clone();
        let account_id = account_id.clone();
        let policy = policy.clone();
        tokio::task::spawn_blocking(move || db.evict_account_to_policy(&account_id, &policy))
            .await
            .map_err(|_| "Local mail cleanup stopped unexpectedly.".to_string())??;
    }
    Ok(outcome)
}

/// Only a full pass saw every server folder, so only it may delete local
/// folders that the server no longer lists.
pub(crate) fn reconcile_scope(
    db: &Database,
    account_id: &str,
    scope: &SyncScope,
    server_names: &HashSet<String>,
) -> Result<(), String> {
    match scope {
        SyncScope::All => db.reconcile_mailboxes(account_id, server_names),
        SyncScope::Folders(_) => Ok(()),
    }
}

/// Folders named by a scoped pass, read from the cache. Unknown names are
/// skipped: the next full pass creates them. The stored role source is kept,
/// because the upsert writes it back.
fn folders_in_scope(
    db: &Database,
    account_id: &str,
    names: &[String],
) -> Result<Vec<ListedFolder>, String> {
    let cached = db.list_mailboxes(account_id)?;
    let sources: std::collections::HashMap<String, String> = {
        let conn = db.read_conn()?;
        let mut statement = conn
            .prepare("SELECT name, role_source FROM mailboxes WHERE account_id=?1")
            .map_err(|_| "Mail folders could not be read.".to_string())?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| "Mail folders could not be read.".to_string())?
            .collect::<Result<_, _>>()
            .map_err(|_| "Mail folders could not be read.".to_string())?;
        rows
    };
    Ok(cached
        .into_iter()
        .filter(|folder| names.contains(&folder.name))
        .map(|folder| {
            let role_source = match sources.get(&folder.name).map(String::as_str) {
                Some(ROLE_SOURCE_SPECIAL_USE) => ROLE_SOURCE_SPECIAL_USE,
                _ => ROLE_SOURCE_NAME,
            };
            ListedFolder {
                skip_prefetch: matches!(folder.role, MailboxRole::Junk | MailboxRole::Trash),
                name: folder.name,
                delimiter: folder.delimiter,
                role: folder.role,
                role_source,
                prefetched: None,
            }
        })
        .collect())
}

async fn sync_folder<H: SyncHooks>(
    lease: &mut Lease,
    db: &Database,
    account: &AccountRecord,
    policy: &CachePolicy,
    folder: &ListedFolder,
    budget: &mut PassBudget,
    hooks: &mut H,
) -> Result<(bool, bool), String> {
    let account_id = &account.summary.id;
    let quick = hooks.quick();
    let condstore = lease.capabilities.condstore;
    let wire_name = lease.mailbox_name(&folder.name);
    let status = match &folder.prefetched {
        Some(status) => status.clone(),
        None => tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            lease.status(&wire_name, status_items(condstore)),
        )
        .await
        .map_err(|_| "Mailbox status timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox status"))?,
    };
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
    // Work a quick pass leaves for the worker.
    let deferred = quick && (backfill_active || wants_prefetch);
    if unchanged && !flag_scan_due && (quick || (!backfill_active && !wants_prefetch)) {
        return Ok((deferred, false));
    }
    if status.exists == 0 {
        let changed = previous
            .as_ref()
            .is_some_and(|meta| meta.server_total.is_some_and(|total| total > 0));
        db.reconcile_expunged(mailbox_id, 0, u32::MAX, &HashSet::new())?;
        db.set_backfill(mailbox_id, None, "complete")?;
        db.set_highest_modseq(mailbox_id, status.highest_modseq)?;
        return Ok((false, changed));
    }
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(&wire_name))
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
    let mut catch_up_incomplete = false;
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
        // List the UIDs that exist, so a wide gap costs nothing.
        let found = tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            lease.uid_search(format!("UID {}:*", max_uid.saturating_add(1))),
        )
        .await
        .map_err(|_| "Message list download timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Message list download"))?
        .into_iter()
        .collect::<Vec<_>>();
        let (chunks, capped) = plan_new_uid_chunks(
            &found,
            max_uid,
            INITIAL_MESSAGE_BATCH as usize,
            MAX_NEW_MAIL_CHUNKS as usize,
        );
        catch_up_incomplete = capped;
        for (index, chunk) in chunks.iter().enumerate() {
            // Let user actions run; the next pass resumes from max_uid.
            if index > 0 && hooks.contended() {
                catch_up_incomplete = true;
                break;
            }
            let fetched = cache_envelopes(
                lease,
                db,
                account_id,
                mailbox_id,
                EnvelopeRange::UidSet(super::folders::uid_set(chunk)?),
                cutoff.as_ref(),
            )
            .await?;
            new_fetched = new_fetched.saturating_add(fetched.count);
        }
    }
    if catch_up_incomplete {
        // Without this the next pass sees an unchanged UIDNEXT and skips the gap.
        db.forget_uid_next(mailbox_id)?;
    }
    // This pass's envelopes are stored; land snoozes moved in from elsewhere.
    db.apply_pending_snooze_transfers(account_id, mailbox_id)?;

    let expunge_suspected = !purged
        && previous.as_ref().is_some_and(|meta| {
            meta.server_total
                .is_some_and(|total| status.exists < total.saturating_add(new_fetched))
        });
    let modseq_before_fetch = status.highest_modseq;
    if condstore && !purged && meta.highest_modseq.is_some() {
        let known = meta.highest_modseq.unwrap_or_default();
        let mut vanished = None;
        if modseq_before_fetch != Some(known) {
            if let Some(low) = db.min_uid(mailbox_id)? {
                vanished = sync_changed_flags(lease, db, mailbox_id, low, known).await?;
            }
        }
        if decide_expunge_path(vanished.as_ref(), expunge_suspected) == ExpungePath::Reconcile {
            reconcile_expunges(lease, db, mailbox_id).await?;
        }
        db.set_highest_modseq(mailbox_id, modseq_before_fetch)?;
    } else if condstore {
        full_flag_scan(lease, db, mailbox_id).await?;
        db.set_highest_modseq(mailbox_id, modseq_before_fetch)?;
    } else if flag_scan_due || expunge_suspected {
        full_flag_scan(lease, db, mailbox_id).await?;
    }

    let changed = new_fetched > 0 || !unchanged;
    if quick {
        return Ok((
            deferred || catch_up_incomplete || (new_fetched > 0 && !folder.skip_prefetch),
            changed,
        ));
    }
    let mut more_work = catch_up_incomplete;
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
    Ok((more_work, changed))
}

enum EnvelopeRange {
    Uid(u32, u32),
    UidOpen(u32),
    UidSet(String),
    Sequence(u32, u32),
}

/// New UIDs above `max_uid`, oldest first, in fetch chunks. True when the
/// per-pass chunk cap left some for the next pass.
pub(crate) fn plan_new_uid_chunks(
    found: &[u32],
    max_uid: u32,
    batch: usize,
    max_chunks: usize,
) -> (Vec<Vec<u32>>, bool) {
    let mut uids: Vec<u32> = found.iter().copied().filter(|uid| *uid > max_uid).collect();
    uids.sort_unstable();
    uids.dedup();
    let batch = batch.max(1);
    let chunks: Vec<Vec<u32>> = uids
        .chunks(batch)
        .take(max_chunks)
        .map(<[u32]>::to_vec)
        .collect();
    let capped = uids.len() > batch.saturating_mul(max_chunks);
    (chunks, capped)
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
        EnvelopeRange::UidSet(set) => {
            tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.uid_fetch(set, &query))
                .await
                .map(|result| result.map(futures_util::future::Either::Left))
        }
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
        let Ok(mut parsed) = parse_envelope(&item, seen, flagged) else {
            continue;
        };
        (parsed.is_answered, parsed.is_forwarded) = reply_flags(&item);
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

/// (uid, first flag, second flag) for `reconcile_flags` and `reconcile_reply_flags`.
type FlagRow = (u32, bool, bool);

/// Seen/flagged rows and answered/forwarded rows for one UID FLAGS batch.
fn flag_rows(rows: &[async_imap::types::Fetch]) -> (Vec<FlagRow>, Vec<FlagRow>) {
    let changed = rows
        .iter()
        .filter_map(|item| {
            let (seen, flagged) = system_flags(item);
            item.uid.map(|uid| (uid, seen, flagged))
        })
        .collect::<Vec<_>>();
    let replies = rows
        .iter()
        .filter_map(|item| {
            let (answered, forwarded) = reply_flags(item);
            item.uid.map(|uid| (uid, answered, forwarded))
        })
        .collect::<Vec<_>>();
    (changed, replies)
}

/// Fetch flag changes since `since`. With QRESYNC, the same command reports
/// expunged UIDs (VANISHED) and they are applied here; the returned plan tells
/// the caller whether `reconcile_expunges` can be skipped.
async fn sync_changed_flags(
    lease: &mut Lease,
    db: &Database,
    mailbox_id: i64,
    low: u32,
    since: u64,
) -> Result<Option<VanishedPlan>, String> {
    let qresync = lease.capabilities.qresync;
    let modifier = if qresync {
        format!("(CHANGEDSINCE {since} VANISHED)")
    } else {
        format!("(CHANGEDSINCE {since})")
    };
    if qresync {
        // Stale lines from earlier commands must not read as this fetch's.
        drain_vanished(lease);
    }
    let rows = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        lease
            .uid_fetch(format!("{low}:*"), format!("(UID FLAGS) {modifier}"))
            .await?
            .try_collect::<Vec<_>>()
            .await
    })
    .await
    .map_err(|_| "Flag sync timed out.".to_string())?
    .map_err(|error| redact_error(&error, "Flag sync"))?;
    let plan = qresync.then(|| {
        let (ranges, drained) = drain_vanished(lease);
        plan_vanished(&ranges, drained)
    });
    let (changed, replies) = flag_rows(&rows);
    db.reconcile_reply_flags(mailbox_id, &replies)?;
    db.reconcile_flags(mailbox_id, &changed, &[])?;
    if let Some(VanishedPlan::Apply(uids)) = &plan {
        db.apply_vanished(mailbox_id, uids)?;
    }
    Ok(plan)
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
        let (seen, replies) = flag_rows(&rows);
        db.reconcile_reply_flags(mailbox_id, &replies)?;
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
        let candidates = db.prefetch_candidate_rows(
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

/// Parse on the blocking pool so a hostile MIME body cannot stall a runtime
/// worker while the account lock is held.
async fn parse_full_off_runtime(
    uid: u32,
    raw: &[u8],
    seen: bool,
    flagged: bool,
    fallback: Option<String>,
) -> Result<CachedMessage, MailError> {
    let raw = raw.to_vec();
    // A panic in the parser is Unreadable: the message stays quarantined.
    tokio::task::spawn_blocking(move || {
        parse_message(uid, &raw, seen, flagged, fallback.as_deref())
    })
    .await
    .map_err(|_| MailError::new(FailureKind::Unreadable, "Message parsing was interrupted."))?
    .map_err(MailError::from)
}

/// Like `parse_full_off_runtime` for a prefix. `None` means the prefix cannot
/// stand alone and the whole message must be fetched.
async fn parse_partial_off_runtime(
    uid: u32,
    raw: &[u8],
    declared_size: u64,
    seen: bool,
    flagged: bool,
    fallback: Option<String>,
) -> Result<Option<CachedMessage>, MailError> {
    let raw = raw.to_vec();
    tokio::task::spawn_blocking(move || {
        parse_partial_message(uid, &raw, declared_size, seen, flagged, fallback.as_deref())
    })
    .await
    .map_err(|_| MailError::new(FailureKind::Unreadable, "Message parsing was interrupted."))?
    .map_err(MailError::from)
}

/// Runs one parse under the quarantine count. The attempt is counted before
/// the parser starts, so an attempt that never returns still counts.
pub(crate) async fn guard_parse<T>(
    db: &Database,
    mailbox_id: i64,
    uid: u32,
    parse: impl Future<Output = Result<T, MailError>>,
) -> Result<T, MailError> {
    db.begin_parse(mailbox_id, uid)
        .map_err(MailError::local_storage)?;
    let parsed = parse.await;
    if matches!(&parsed, Err(error) if error.kind == FailureKind::Unreadable) {
        db.quarantine_parse(mailbox_id, uid)
            .map_err(MailError::local_storage)?;
    } else {
        db.end_parse(mailbox_id, uid)
            .map_err(MailError::local_storage)?;
    }
    parsed
}

#[derive(Default)]
struct BatchState {
    budget: BodyBudget,
    delivered: HashSet<u32>,
    repair_ids: Vec<String>,
    consumed: u64,
}

/// Candidate rows for one prefetch batch, keyed by UID.
struct BatchRow {
    received_at: String,
    size: u64,
}

async fn download_body_batch(
    lease: &mut Lease,
    db: &Database,
    mailbox_id: i64,
    uid_validity: u32,
    candidates: &[(u32, String, u64)],
) -> Result<u64, String> {
    let keep_offline = db.keep_attachments_offline();
    let rows: HashMap<u32, BatchRow> = candidates
        .iter()
        .map(|(uid, received_at, size)| {
            (
                *uid,
                BatchRow {
                    received_at: received_at.clone(),
                    size: *size,
                },
            )
        })
        .collect();
    let (partial, full): (Vec<u32>, Vec<u32>) =
        candidates.iter().map(|(uid, _, _)| *uid).partition(|uid| {
            let size = rows.get(uid).map_or(0, |row| row.size);
            body_fetch_for(size, keep_offline) == BodyFetch::Partial
        });
    let mut state = BatchState::default();
    let mut whole = full;
    if !partial.is_empty() {
        // A rejected prefix is fetched whole in the same batch.
        whole.extend(
            fetch_body_group(
                lease,
                db,
                mailbox_id,
                uid_validity,
                &partial,
                BodyFetch::Partial,
                &rows,
                &mut state,
            )
            .await?,
        );
    }
    if !whole.is_empty() {
        fetch_body_group(
            lease,
            db,
            mailbox_id,
            uid_validity,
            &whole,
            BodyFetch::Full,
            &rows,
            &mut state,
        )
        .await?;
    }
    if !state.repair_ids.is_empty() {
        let _ = db.repair_thread_roots_batch(&parsed_account(db, mailbox_id)?, &state.repair_ids);
    }
    for (uid, _, _) in candidates {
        if !state.delivered.contains(uid) {
            db.record_prefetch_failure(mailbox_id, *uid)?;
        }
    }
    Ok(state.consumed)
}

/// Fetch and store one group of bodies. Returns the UIDs whose prefix was
/// rejected, which the caller must fetch whole.
#[allow(clippy::too_many_arguments)]
async fn fetch_body_group(
    lease: &mut Lease,
    db: &Database,
    mailbox_id: i64,
    uid_validity: u32,
    uids: &[u32],
    fetch: BodyFetch,
    rows: &HashMap<u32, BatchRow>,
    state: &mut BatchState,
) -> Result<Vec<u32>, String> {
    let range = uids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let body_query = body_fetch_query_for("UID FLAGS RFC822.SIZE INTERNALDATE", fetch);
    let mut fetched =
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.uid_fetch(range, body_query))
            .await
            .map_err(|_| "Message prefetch timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Message prefetch"))?;
    let mut rejected = Vec::new();
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
        if !state
            .budget
            .admit(raw.len(), MAX_MESSAGE_BYTES, PREFETCH_TOTAL_BYTES as usize)
        {
            continue;
        }
        let partial = response_is_partial(fetch, raw.len());
        let (seen, flagged) = system_flags(&item);
        let cached_received_at = rows.get(&uid).map(|row| row.received_at.as_str());
        let fallback = received_at_fallback(&item, cached_received_at);
        let internal_at = internal_date(&item);
        let declared_size = item
            .size
            .map(u64::from)
            .or_else(|| rows.get(&uid).map(|row| row.size))
            .unwrap_or(raw.len() as u64);
        let parsed = if partial {
            guard_parse(
                db,
                mailbox_id,
                uid,
                parse_partial_off_runtime(uid, raw, declared_size, seen, flagged, fallback),
            )
            .await
        } else {
            guard_parse(db, mailbox_id, uid, async {
                parse_full_off_runtime(uid, raw, seen, flagged, fallback)
                    .await
                    .map(Some)
            })
            .await
        };
        match parsed {
            Ok(Some(mut parsed)) => {
                parsed.internal_at = internal_at;
                state.consumed = state.consumed.saturating_add(raw.len() as u64);
                state.delivered.insert(uid);
                let stored = if partial {
                    db.attach_partial_body_if_current(mailbox_id, uid_validity, &parsed)?
                } else {
                    db.attach_body_if_current(mailbox_id, uid_validity, &parsed)?
                };
                if stored {
                    state.repair_ids.push(
                        parsed.message_id.clone().unwrap_or_else(|| {
                            crate::db::synthetic_thread_id(mailbox_id, parsed.uid)
                        }),
                    );
                }
            }
            Ok(None) => rejected.push(uid),
            Err(_) => {
                state.delivered.insert(uid);
                db.record_prefetch_failure(mailbox_id, uid)?;
            }
        }
    }
    Ok(rejected)
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
        let wire_mailbox = lease.mailbox_name(mailbox);
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(&wire_mailbox))
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
        let wire_mailbox = lease.mailbox_name(mailbox);
        let status = tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            lease.status(&wire_mailbox, "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)"),
        )
        .await
        .map_err(|_| "Mailbox status timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Mailbox status"))?;
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(&wire_mailbox))
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
            db.apply_pending_snooze_transfers(&account.summary.id, mailbox_id)
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

/// Search the server. Between mailboxes the account goes to any waiting user
/// action, so a slow search never blocks opening or flagging mail.
pub async fn server_search<H: SyncHooks>(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    query: &SearchQuery,
    hooks: &mut H,
) -> Result<Vec<MessageSummary>, String> {
    let parsed = crate::search_query::parse(&query.text);
    let mut mailboxes = if query.all_folders {
        db.list_mailboxes(&account.summary.id)?
    } else if let Some(id) = query.mailbox_id {
        let (account_id, _) = db.mailbox(id)?;
        if account_id != account.summary.id {
            return Err("Mailbox does not belong to this account.".into());
        }
        db.list_mailboxes(&account.summary.id)?
            .into_iter()
            .filter(|mailbox| mailbox.id == id)
            .collect()
    } else {
        Vec::new()
    };
    if !parsed.folders.is_empty() {
        mailboxes.retain(|mailbox| {
            parsed.folders.iter().any(|needle| {
                crate::search_query::folder_needle_matches(
                    needle,
                    mailbox.role.as_str(),
                    &mailbox.name,
                    &mailbox.display_name,
                    mailbox.delimiter.as_deref(),
                )
            })
        });
        if mailboxes.is_empty() {
            return Ok(Vec::new());
        }
    }
    let mailboxes = mailboxes
        .into_iter()
        .map(|mailbox| (mailbox.id, mailbox.name))
        .collect::<Vec<_>>();
    let identities =
        crate::search_query::search_identities(&account.summary.email, &account.summary.aliases);
    let Some(criteria) = parsed.imap_criteria_with(&identities) else {
        return Ok(Vec::new());
    };
    let mut lease = pool::checkout(account, password).await?;
    let filter = ServerHitFilter {
        require_attachment: parsed.has_attachment,
        filenames: parsed.filenames,
        larger_than: parsed.larger_than,
        smaller_than: parsed.smaller_than,
    };
    let mut results = Vec::new();
    // Bound all-folders searches; a later search resumes from fresh results.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    for (index, (mailbox_id, name)) in mailboxes.into_iter().enumerate() {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        if index > 0 {
            lease = yield_point(lease, hooks, account, password).await?;
        }
        match search_mailbox(
            &mut lease, db, account, query, &criteria, &filter, mailbox_id, &name,
        )
        .await
        {
            Ok(mut hits) => results.append(&mut hits),
            Err(error) => {
                lease.discard();
                return Err(error);
            }
        }
    }
    lease.release();
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

struct ServerHitFilter {
    require_attachment: bool,
    filenames: Vec<String>,
    larger_than: Option<i64>,
    smaller_than: Option<i64>,
}

impl ServerHitFilter {
    fn matches(&self, summary: &MessageSummary, names: &[String]) -> bool {
        if self.require_attachment && !summary.has_attachments {
            return false;
        }
        if self
            .larger_than
            .is_some_and(|min| summary.size <= min as u64)
        {
            return false;
        }
        if self
            .smaller_than
            .is_some_and(|max| summary.size >= max as u64)
        {
            return false;
        }
        // Names are empty when the body is not cached; keep the hit then.
        if names.is_empty() && summary.has_attachments {
            return true;
        }
        self.filenames.iter().all(|needle| {
            names
                .iter()
                .any(|name| crate::search_query::filename_matches(name, needle))
        })
    }
}

#[allow(clippy::too_many_arguments)]
async fn search_mailbox(
    lease: &mut Lease,
    db: &Database,
    account: &AccountRecord,
    query: &SearchQuery,
    criteria: &str,
    filter: &ServerHitFilter,
    mailbox_id: i64,
    name: &str,
) -> Result<Vec<MessageSummary>, String> {
    let mut results = Vec::new();
    let wire_name = lease.mailbox_name(name);
    let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(&wire_name))
        .await
        .map_err(|_| "Server search timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Server search"))?;
    if let Some(expected_uid_validity) = db.mailbox_uid_validity(&account.summary.id, name)? {
        if selected.uid_validity != Some(expected_uid_validity) {
            // The cached generation is stale; caching new-generation UIDs
            // against it would corrupt the mailbox. Purge and let the
            // next sync repopulate instead.
            let _ = db.purge_stale_mailbox(&account.summary.id, name, mailbox_id);
            return Ok(results);
        }
    }
    let mut uids = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.uid_search(criteria))
        .await
        .map_err(|_| "Server search timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Server search"))?
        .into_iter()
        .collect::<Vec<_>>();
    uids.sort_unstable_by(|left, right| right.cmp(left));
    uids.truncate(query.limit.min(500) as usize);
    if uids.is_empty() {
        return Ok(results);
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
            parse_envelope(item, seen, flagged).ok().map(|mut parsed| {
                (parsed.is_answered, parsed.is_forwarded) = reply_flags(item);
                parsed
            })
        })
        .collect::<Vec<_>>();
    db.upsert_envelopes(&account.summary.id, mailbox_id, &parsed)?;
    for message in &parsed {
        if let Some(summary) = db.message_summary_by_uid(mailbox_id, message.uid)? {
            // Attachment names are not an IMAP key. Size and the
            // envelope attachment hint are checked on the cached row.
            let names = if filter.filenames.is_empty() {
                Vec::new()
            } else {
                db.attachment_filenames(mailbox_id, message.uid)?
            };
            if filter.matches(&summary, &names) {
                results.push(summary);
            }
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
    Ok(results)
}

/// Time allowed to receive one on-demand message body: the normal command
/// timeout plus one second per 100 KB declared, at most ten minutes, so a
/// large message on a slow link can still open.
pub(crate) fn download_timeout(expected_size: u64) -> Duration {
    (IMAP_COMMAND_TIMEOUT + Duration::from_secs(expected_size / 100_000))
        .min(Duration::from_secs(600))
}

#[allow(clippy::too_many_arguments)]
pub async fn download_message(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    expected_size: u64,
    expected_uid_validity: Option<u32>,
    cached_received_at: Option<&str>,
    before_parse: impl FnOnce() -> Result<(), String>,
) -> Result<CachedMessage, MailError> {
    if expected_size > MAX_MESSAGE_BYTES as u64 {
        return Err(MailError::new(
            FailureKind::TooLarge,
            "This message is too large to download safely.",
        ));
    }
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        MailError::from("Mailbox identity is unavailable; refresh mail and try again.".to_string())
    })?;
    let mut lease = pool::checkout(account, password).await?;
    let result = async {
        let wire_mailbox = lease.mailbox_name(mailbox);
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(&wire_mailbox))
            .await
            .map_err(|_| MailError::connection("Message download timed out."))?
            .map_err(|error| MailError::from(redact_error(&error, "Message download")))?;
        if selected.uid_validity != Some(expected_uid_validity) {
            return Err(MailError::from(
                "This mailbox changed; refresh mail and try again.".to_string(),
            ));
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
        .map_err(|_| MailError::connection("Message download timed out."))?
        .map_err(MailError::from)?;
        // Unsolicited FETCH lines for other messages may share the response.
        let index = rows
            .iter()
            .rposition(|row| row.uid == Some(uid) && row.body().is_some())
            .ok_or_else(|| {
                MailError::from("This message is no longer available on the server.".to_string())
            })?;
        let item = rows.swap_remove(index);
        let raw = item.body().ok_or_else(|| {
            MailError::from("The mail server did not return this message.".to_string())
        })?;
        if raw.len() > MAX_MESSAGE_BYTES {
            return Err(MailError::new(
                FailureKind::TooLarge,
                "This message is too large to download safely.",
            ));
        }
        let (seen, flagged) = system_flags(&item);
        let fallback = received_at_fallback(&item, cached_received_at);
        // Only the parse itself is counted, never the network download.
        before_parse().map_err(MailError::local_storage)?;
        let mut parsed = parse_full_off_runtime(uid, raw, seen, flagged, fallback).await?;
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

/// Result of a prefix download. `Fallback` means the prefix cannot stand
/// alone, so the caller must fetch the whole message.
pub(crate) enum FetchedBody {
    Partial(CachedMessage),
    Full(CachedMessage),
    Fallback,
}

/// Download the first bytes of a large message. A server that ignores the
/// range and sends the whole message is parsed as a full body.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_partial_message(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    uid: u32,
    expected_size: u64,
    expected_uid_validity: Option<u32>,
    cached_received_at: Option<&str>,
    before_parse: impl FnOnce() -> Result<(), String>,
) -> Result<FetchedBody, MailError> {
    if expected_size > MAX_MESSAGE_BYTES as u64 {
        return Err(MailError::new(
            FailureKind::TooLarge,
            "This message is too large to download safely.",
        ));
    }
    let expected_uid_validity = expected_uid_validity.ok_or_else(|| {
        MailError::from("Mailbox identity is unavailable; refresh mail and try again.".to_string())
    })?;
    let mut lease = pool::checkout(account, password).await?;
    let result = async {
        let wire_mailbox = lease.mailbox_name(mailbox);
        let selected = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, lease.examine(&wire_mailbox))
            .await
            .map_err(|_| MailError::connection("Message download timed out."))?
            .map_err(|error| MailError::from(redact_error(&error, "Message download")))?;
        if selected.uid_validity != Some(expected_uid_validity) {
            return Err(MailError::from(
                "This mailbox changed; refresh mail and try again.".to_string(),
            ));
        }
        let query = body_fetch_query_for("UID FLAGS RFC822.SIZE INTERNALDATE", BodyFetch::Partial);
        let item = fetch_one_body(&mut lease, uid, query, expected_size).await?;
        let raw = item.body().ok_or_else(|| {
            MailError::from("The mail server did not return this message.".to_string())
        })?;
        let (seen, flagged) = system_flags(&item);
        let fallback = received_at_fallback(&item, cached_received_at);
        let internal_at = internal_date(&item);
        let declared_size = item.size.map_or(expected_size, u64::from);
        if !response_is_partial(BodyFetch::Partial, raw.len()) {
            if raw.len() > MAX_MESSAGE_BYTES {
                return Err(MailError::new(
                    FailureKind::TooLarge,
                    "This message is too large to download safely.",
                ));
            }
            before_parse().map_err(MailError::local_storage)?;
            let mut parsed = parse_full_off_runtime(uid, raw, seen, flagged, fallback).await?;
            parsed.internal_at = internal_at;
            return Ok(FetchedBody::Full(parsed));
        }
        before_parse().map_err(MailError::local_storage)?;
        let parsed =
            parse_partial_off_runtime(uid, raw, declared_size, seen, flagged, fallback).await?;
        Ok(match parsed {
            Some(mut parsed) => {
                parsed.internal_at = internal_at;
                FetchedBody::Partial(parsed)
            }
            None => FetchedBody::Fallback,
        })
    }
    .await;
    match result {
        Ok(fetched) => {
            lease.release();
            Ok(fetched)
        }
        Err(error) => {
            lease.discard();
            Err(error)
        }
    }
}

/// Fetch one message's body item on an open session, with the download timeout.
async fn fetch_one_body(
    lease: &mut Lease,
    uid: u32,
    query: String,
    expected_size: u64,
) -> Result<async_imap::types::Fetch, MailError> {
    let mut rows = tokio::time::timeout(download_timeout(expected_size), async {
        lease
            .uid_fetch(uid.to_string(), query)
            .await
            .map_err(|error| redact_error(&error, "Message download"))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|error| redact_error(&error, "Message download"))
    })
    .await
    .map_err(|_| MailError::connection("Message download timed out."))?
    .map_err(MailError::from)?;
    // Unsolicited FETCH lines for other messages may share the response.
    let index = rows
        .iter()
        .rposition(|row| row.uid == Some(uid) && row.body().is_some())
        .ok_or_else(|| {
            MailError::from("This message is no longer available on the server.".to_string())
        })?;
    Ok(rows.swap_remove(index))
}

/// Body request for a message. A partial request asks for the first
/// `PARTIAL_BODY_BYTES`; the integration override always asks for the whole message.
pub(crate) fn body_fetch_query_for(prefix: &str, fetch: BodyFetch) -> String {
    #[cfg(test)]
    if std::env::var_os("POSTAL_SNAP_MAIL_INTEGRATION").is_some() {
        return format!("({prefix} BODY.PEEK[])");
    }
    match fetch {
        BodyFetch::Full => format!("({prefix} BODY.PEEK[]<0.{}>)", MAX_MESSAGE_BYTES + 1),
        BodyFetch::Partial => format!("({prefix} BODY.PEEK[]<0.{PARTIAL_BODY_BYTES}>)"),
    }
}

pub(crate) fn body_fetch_query(prefix: &str) -> String {
    body_fetch_query_for(prefix, BodyFetch::Full)
}

#[cfg(test)]
mod tests {
    use super::{
        folders_from_listing, plan_new_uid_chunks, refresh_window_start,
        should_purge_stale_generation, ServerHitFilter, INITIAL_MESSAGE_BATCH,
    };
    use crate::mail::list_status::ListedName;
    use crate::models::ProviderKind;
    use async_imap::types::Mailbox;
    use std::collections::HashMap;

    fn listed(name: &str, attributes: &[&str]) -> ListedName {
        ListedName {
            wire_name: name.to_string(),
            delimiter: Some("/".to_string()),
            attributes: attributes.iter().map(|value| value.to_string()).collect(),
        }
    }

    fn status(uid_next: u32) -> Mailbox {
        Mailbox {
            exists: 1,
            unseen: Some(0),
            uid_next: Some(uid_next),
            uid_validity: Some(7),
            ..Default::default()
        }
    }

    #[test]
    fn listed_status_attaches_only_to_the_selectable_folder_it_names() {
        let names = [
            listed("INBOX", &[]),
            listed("Hidden", &["NoSelect"]),
            listed("Archive", &[]),
        ];
        let statuses = HashMap::from([
            ("INBOX".to_string(), status(2)),
            ("Hidden".to_string(), status(3)),
            ("Stray".to_string(), status(4)),
        ]);
        let folders = folders_from_listing(&names, statuses, &ProviderKind::Manual);
        let names: Vec<_> = folders.iter().map(|folder| folder.name.as_str()).collect();
        assert_eq!(names, ["INBOX", "Archive"]);
        assert_eq!(
            folders[0].prefetched.as_ref().map(|s| s.uid_next),
            Some(Some(2))
        );
        assert!(
            folders[1].prefetched.is_none(),
            "missing STATUS is asked for later"
        );
    }

    // New-mail catch-up failure modes:
    // 1. A wide UID gap costs one round trip per empty range.
    // 2. `UID n:*` answers with the newest UID even when it is not above n,
    //    so an already cached message is fetched again.
    // 3. Unsorted or repeated search results fetch a UID twice or out of order.
    // 4. Hitting the per-pass cap is not reported, so the rest is skipped.
    #[test]
    fn new_mail_chunks_skip_uid_gaps() {
        let found = [4_000_000, 10, 4_000_001, 12, 4_000_000, 9];
        let (chunks, incomplete) = plan_new_uid_chunks(&found, 10, 2, 10);
        assert_eq!(chunks, vec![vec![12, 4_000_000], vec![4_000_001]]);
        assert!(!incomplete);

        let many: Vec<u32> = (100..110).collect();
        let (chunks, incomplete) = plan_new_uid_chunks(&many, 99, 3, 2);
        assert_eq!(chunks, vec![vec![100, 101, 102], vec![103, 104, 105]]);
        assert!(incomplete);

        let (chunks, incomplete) = plan_new_uid_chunks(&[7], 7, 3, 2);
        assert!(chunks.is_empty());
        assert!(!incomplete);
    }

    fn summary(has_attachments: bool) -> crate::models::MessageSummary {
        crate::models::MessageSummary {
            id: 1,
            account_id: "account-1".into(),
            mailbox_id: 1,
            uid: 1,
            message_id: None,
            subject: "Invoice".into(),
            sender_name: String::new(),
            sender_address: "billing@example.test".into(),
            recipients: String::new(),
            received_at: "2026-08-18T12:00:00Z".into(),
            preview: String::new(),
            is_read: true,
            is_starred: false,
            has_attachments,
            size: 4096,
            thread_root: None,
            has_calendar: false,
            is_answered: false,
            is_forwarded: false,
            conversation_muted: false,
            importance: String::new(),
            pinned: false,
            to_me: false,
            arrived_at: String::new(),
            attachment_count: 0,
        }
    }

    #[test]
    fn server_filename_hits_keep_uncached_names_and_drop_mismatches() {
        // Ways this can fail: an uncached attachment hit is dropped, a cached
        // mismatch is kept, or a matching name is dropped.
        let filter = ServerHitFilter {
            require_attachment: false,
            filenames: vec!["invoice".into()],
            larger_than: None,
            smaller_than: None,
        };
        assert!(filter.matches(&summary(true), &[]));
        assert!(!filter.matches(&summary(true), &["notes.txt".into()]));
        assert!(filter.matches(&summary(true), &["Invoice-2026.pdf".into()]));
    }

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

#[cfg(test)]
mod scope_tests {
    use super::{folders_in_scope, reconcile_scope, SyncScope};
    use crate::db::Database;
    use crate::models::{
        AccountRecord, AccountSummary, BodyFormat, MailboxRole, ProviderKind, ServerConfig,
        TlsMode, ROLE_SOURCE_NAME,
    };
    use std::collections::HashSet;

    fn account() -> AccountRecord {
        let server = ServerConfig {
            trusted_certificate: None,
            host: "imap.example.test".into(),
            port: 993,
            tls_mode: TlsMode::Tls,
            username: "sam@example.test".into(),
        };
        AccountRecord {
            summary: AccountSummary {
                default_body_format: BodyFormat::Html,
                id: "scope-account".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.test".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                signature_html: String::new(),
                reply_to: String::new(),
                color: None,
            },
            imap: server.clone(),
            smtp: server,
        }
    }

    // Scoped-pass failure modes (D6):
    // 1. A pass over INBOX alone deletes every other folder from the local list.
    // 2. A scoped pass reads its folder list from the server instead of the cache.
    // 3. A full pass stops reconciling, so folders removed on the server linger.
    #[test]
    fn folder_scoped_pass_never_reconciles_mailboxes() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let id = account.summary.id.clone();
        db.upsert_mailbox_with_source(
            &id,
            "INBOX",
            &MailboxRole::Inbox,
            ROLE_SOURCE_NAME,
            Some(1),
            Some(1),
            Some(0),
            0,
        )
        .unwrap();
        db.upsert_mailbox_with_source(
            &id,
            "Archive",
            &MailboxRole::Archive,
            ROLE_SOURCE_NAME,
            Some(1),
            Some(1),
            Some(0),
            0,
        )
        .unwrap();
        let server: HashSet<String> = ["INBOX".to_string()].into();

        reconcile_scope(&db, &id, &SyncScope::Folders(vec!["INBOX".into()]), &server).unwrap();
        assert_eq!(db.list_mailboxes(&id).unwrap().len(), 2);

        reconcile_scope(&db, &id, &SyncScope::All, &server).unwrap();
        assert_eq!(db.list_mailboxes(&id).unwrap().len(), 1);
    }

    #[test]
    fn scoped_folders_come_from_the_cache_and_skip_unknown_names() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let id = account.summary.id.clone();
        db.upsert_mailbox_with_source(
            &id,
            "Archive",
            &MailboxRole::Archive,
            ROLE_SOURCE_NAME,
            Some(1),
            Some(1),
            Some(0),
            0,
        )
        .unwrap();
        let folders = folders_in_scope(&db, &id, &["Archive".into(), "Missing".into()]).unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "Archive");
        assert_eq!(folders[0].role, MailboxRole::Archive);
    }

    // Failure modes for the prefetch rule:
    // 1. A message just over 1 MiB is fetched whole instead of as a prefix.
    // 2. "Keep attachments offline" still fetches prefixes.
    // 3. A server that ignores the prefix request is parsed as partial (E5).
    #[test]
    fn partial_fetch_applies_only_above_one_mib_and_only_when_not_kept_offline() {
        use super::{body_fetch_for, response_is_partial, BodyFetch, PARTIAL_BODY_BYTES};
        const MIB: u64 = 1024 * 1024;
        assert_eq!(PARTIAL_BODY_BYTES, 256 * 1024);
        assert_eq!(body_fetch_for(MIB, false), BodyFetch::Full);
        assert_eq!(body_fetch_for(MIB + 1, false), BodyFetch::Partial);
        assert_eq!(body_fetch_for(MIB + 1, true), BodyFetch::Full);
        assert!(response_is_partial(BodyFetch::Partial, PARTIAL_BODY_BYTES));
        assert!(!response_is_partial(
            BodyFetch::Partial,
            PARTIAL_BODY_BYTES + 1
        ));
        assert!(!response_is_partial(BodyFetch::Full, 100));
    }

    // Failure modes for the body request:
    // 1. A partial request asks for the whole message.
    // 2. A full request is truncated below the message limit.
    #[test]
    fn body_query_requests_the_prefix_or_the_whole_message() {
        use super::{body_fetch_query_for, BodyFetch};
        assert_eq!(
            body_fetch_query_for("UID", BodyFetch::Partial),
            "(UID BODY.PEEK[]<0.262144>)"
        );
        assert_eq!(
            body_fetch_query_for("UID", BodyFetch::Full),
            format!(
                "(UID BODY.PEEK[]<0.{}>)",
                crate::mail::MAX_MESSAGE_BYTES + 1
            )
        );
    }
}
