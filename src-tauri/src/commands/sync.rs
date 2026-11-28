use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::OwnedMutexGuard;

use super::messages::{FlagOperation, MoveOperation};
use super::outbox::{deliver_outbox_locked, retry_sent_copy_locked};
use super::{
    cleanup_unreferenced_attachments, command_result, emit_draft_change, emit_folder_counts,
    emit_message_change, emit_outbox_change, emit_sync, managed_account_dir,
    release_attachment_tokens, replay_offline_operations, resolve_draft_files, wake, AccountActor,
    AppState, CommandResult,
};
use crate::mail::keywords::ColorChange;
use crate::{
    db::Database,
    mail::{self, failure::FailureKind},
    models::{
        validate_filter_rule, AccountRecord, CachePolicy, ComposeAttachment, ComposeDraft,
        MailboxSummary, RuleAction, MAX_FLAG_COLOR,
    },
};

#[tauri::command]
pub async fn list_all_mailboxes(state: State<'_, AppState>) -> CommandResult<Vec<MailboxSummary>> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || db.list_all_mailboxes())
        .await
        .map_err(|_| "Postal Snap could not list folders.".to_string())?;
    command_result(result)
}

#[tauri::command]
pub async fn list_mailboxes(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MailboxSummary>> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || db.list_mailboxes(&account_id))
        .await
        .map_err(|_| "Postal Snap could not list folders.".to_string())?;
    command_result(result)
}

#[tauri::command]
pub async fn sync_account(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    command_result(sync_one(&account_id, &app, &state).await)
}

#[tauri::command]
pub async fn sync_all_accounts(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    use futures_util::StreamExt;

    let accounts = state.db.list_accounts()?;
    let account_ids: Vec<String> = accounts.iter().map(|account| account.id.clone()).collect();
    let results = futures_util::stream::iter(account_ids)
        .map(|account_id| async {
            let result = sync_one(&account_id, &app, &state).await;
            (account_id, result)
        })
        .buffer_unordered(3)
        .collect::<Vec<_>>()
        .await;
    let synced = results
        .into_iter()
        .filter_map(|(account_id, result)| result.ok().map(|()| account_id))
        .collect::<std::collections::HashSet<_>>();
    let synced_ids = accounts
        .iter()
        .filter(|account| synced.contains(&account.id))
        .map(|account| account.id.clone())
        .collect();
    Ok(synced_ids)
}

pub(crate) struct SyncPassOutcome {
    pub more_work: bool,
}

pub(crate) struct SyncPassOptions {
    pub quick: bool,
    pub scope: mail::sync::SyncScope,
    pub allow_rule_notices: bool,
}

/// Get Mail: run a full pass now, ahead of the background worker.
pub async fn sync_one(account_id: &str, app: &AppHandle, state: &AppState) -> Result<(), String> {
    let actor = state.actor(account_id)?;
    actor.request(wake::OPERATION);
    let guard = actor.acquire().await;
    match run_sync_pass(
        account_id,
        app,
        state,
        &actor,
        guard,
        SyncPassOptions {
            quick: true,
            scope: mail::sync::SyncScope::All,
            allow_rule_notices: true,
        },
    )
    .await
    {
        Ok(outcome) => {
            // A successful manual pass proves the credentials work again.
            // Skipped backfill and bodies continue in the background.
            let more = if outcome.more_work { wake::SYNC } else { 0 };
            actor.request(wake::RESUME | more);
            Ok(())
        }
        Err(PassError::AuthenticationFailed(error) | PassError::Other(error)) => Err(error),
    }
}

pub(crate) enum PassError {
    /// The server rejected the saved credentials; the worker pauses until the
    /// password changes or the user asks for mail.
    AuthenticationFailed(String),
    Other(String),
}

/// Lets user actions preempt a background pass and reports progress.
struct WorkerHooks<'a> {
    actor: Arc<AccountActor>,
    guard: Option<OwnedMutexGuard<()>>,
    app: &'a AppHandle,
    db: Database,
    account_id: String,
    policy: CachePolicy,
    last_progress: Option<Instant>,
    quick: bool,
    explicit: bool,
}

pub(crate) fn validate_connection_identity(
    db: &Database,
    account_id: &str,
    previous: &crate::models::AccountRecord,
) -> Result<(), String> {
    let current = db.account(account_id)?;
    if current.summary.id != previous.summary.id
        || current.summary.provider != previous.summary.provider
        || current.summary.email != previous.summary.email
        || current.summary.auth_method != previous.summary.auth_method
        || current.imap != previous.imap
        || current.smtp != previous.smtp
    {
        return Err("Account connection changed. Restart the operation.".into());
    }
    Ok(())
}

impl mail::SyncHooks for WorkerHooks<'_> {
    fn validate_connection(&self, previous: &crate::models::AccountRecord) -> Result<(), String> {
        validate_connection_identity(&self.db, &self.account_id, previous)
    }

    fn contended(&self) -> bool {
        self.actor.contended()
    }

    async fn yield_account(&mut self) {
        // tokio's Mutex is FIFO: the waiting action runs before we get the
        // account back.
        self.guard.take();
        tokio::task::yield_now().await;
        // If the worker took the account meanwhile and went into IDLE, wake it
        // so this pass is not stuck until the IDLE refresh.
        self.actor.request(wake::OPERATION);
        self.guard = Some(self.actor.acquire().await);
    }

    fn progress(&mut self, folder: &str) {
        if self
            .last_progress
            .is_some_and(|last| last.elapsed() < Duration::from_millis(500))
        {
            return;
        }
        self.last_progress = Some(Instant::now());
        emit_progress(
            self.app,
            &self.db,
            &self.account_id,
            &self.policy,
            Some(folder),
        );
    }

    fn quick(&self) -> bool {
        self.quick
    }

    fn explicit_refresh(&self) -> bool {
        self.explicit
    }

    fn folder_changed(&mut self) {
        // Get Mail shows new mail per folder; background passes report once
        // at the end so a first sync does not reload the list per folder.
        if !self.quick {
            return;
        }
        emit_folder_counts(self.app, &self.account_id);
        emit_message_change(self.app, &self.account_id, None, "synced");
    }
}

pub(crate) fn emit_progress(
    app: &AppHandle,
    db: &Database,
    account_id: &str,
    policy: &CachePolicy,
    folder: Option<&str>,
) {
    if let Ok(mut progress) = db.account_sync_progress(account_id, policy) {
        progress.folder = folder.map(ToOwned::to_owned);
        let _ = app.emit("sync-progress", progress);
    }
}

pub(crate) fn account_policy(state: &AppState, account_id: &str) -> Result<CachePolicy, String> {
    let default = state.settings.get()?.cache_policy;
    state.db.account_cache_policy(account_id, &default)
}

/// One full sync pass plus the jobs that depend on fresh server state: rules,
/// queued offline changes, drafts and the outbox. Takes the account guard and
/// may hand it to waiting user actions between folders.
pub(crate) async fn run_sync_pass(
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
    actor: &Arc<AccountActor>,
    guard: OwnedMutexGuard<()>,
    options: SyncPassOptions,
) -> Result<SyncPassOutcome, PassError> {
    let SyncPassOptions {
        quick,
        scope,
        allow_rule_notices,
    } = options;
    let account = state.db.account(account_id).map_err(PassError::Other)?;
    let password = match crate::oauth::session_secret(&account).await {
        Ok(password) => password,
        Err(error) => {
            if account.summary.auth_method == "password" && error.contains("is missing") {
                let detail = "Sign-in failed. Update the account password in Settings > Accounts.";
                let _ = state
                    .db
                    .set_account_state(account_id, "authFailed", Some(detail));
                emit_sync(app, account_id, "authFailed", Some("Sign-in failed"), None);
                return Err(PassError::AuthenticationFailed(error));
            }
            let _ = state
                .db
                .set_account_state(account_id, "offline", Some(&error));
            emit_sync(app, account_id, "offline", Some(&error), None);
            return Err(PassError::Other(error));
        }
    };
    let policy = account_policy(state, account_id).map_err(PassError::Other)?;
    emit_sync(
        app,
        account_id,
        "connecting",
        Some("Connecting securely…"),
        None,
    );
    let _ = state.db.set_account_state(account_id, "syncing", None);
    emit_sync(app, account_id, "syncing", Some("Checking mail…"), None);
    let filter_watermark = begin_rule_window(&state.db, account_id);
    // Only Get Mail runs a quick full pass; background passes are never quick
    // with the full scope.
    let explicit = quick && scope == mail::sync::SyncScope::All;
    let mut hooks = WorkerHooks {
        actor: actor.clone(),
        guard: Some(guard),
        app,
        db: state.db.clone(),
        account_id: account_id.to_string(),
        policy: policy.clone(),
        last_progress: None,
        quick,
        explicit,
    };
    let result =
        mail::sync::sync_account_scoped(&state.db, &account, &password, &policy, scope, &mut hooks)
            .await;
    // Everything below needs the account; the hooks hold it again after any
    // yield.
    let _guard = hooks.guard.take();
    let mut pending_rule_notice: Option<i64> = None;
    finish_sync_rule_window(
        &state.db,
        &account,
        filter_watermark,
        result.is_ok(),
        allow_rule_notices,
        &mut |message_id| {
            pending_rule_notice = Some(message_id);
            true
        },
    );
    let pending_rule_header = pending_rule_notice.and_then(|id| {
        state
            .db
            .message_detail(id, account_id)
            .ok()
            .and_then(|detail| detail.summary.message_id)
    });
    match result {
        Ok(outcome) => {
            let _ = state.db.file_muted_inbox(account_id);
            let pending_changes =
                replay_offline_operations(app, &state.db, &account, &password, &policy)
                    .await
                    .unwrap_or(true);
            if let Some(id) = pending_rule_notice
                .filter(|&id| state.db.message_meta(id, account_id).is_ok())
                .or_else(|| {
                    pending_rule_header.as_deref().and_then(|hdr| {
                        state
                            .db
                            .find_message_by_header_id(account_id, hdr)
                            .ok()
                            .flatten()
                            .map(|m| m.id)
                    })
                })
            {
                crate::notify::rule_notice(app, &state.db, account_id, id);
            }
            sync_drafts_locked(state, &account, &password).await;
            replay_outbox_locked(account_id, app, state).await;
            let now = crate::date_time::format_rfc3339(crate::date_time::now_utc());
            let _ = state.db.set_account_state(account_id, "idle", None);
            let detail = if pending_changes {
                "Some changes are waiting to sync"
            } else if outcome.folder_errors > 0 {
                "Some folders could not be checked"
            } else if outcome.more_work {
                "Downloading mail…"
            } else {
                "Mail is up to date"
            };
            emit_sync(app, account_id, "idle", Some(detail), Some(now));
            emit_progress(app, &state.db, account_id, &policy, None);
            emit_folder_counts(app, account_id);
            emit_message_change(app, account_id, None, "synced");
            emit_draft_change(app, account_id, None, None);
            emit_outbox_change(app, account_id, None, None);
            Ok(SyncPassOutcome {
                more_work: outcome.more_work,
            })
        }
        Err(error) => {
            // Sign-in failures (expired app password, revoked access) need a
            // different message than a dead connection: the fix is a new
            // password, not waiting for retry.
            if error.kind == FailureKind::SignInRejected {
                mail::pool::forget(account_id);
                let detail = "Sign-in failed. Update the account password in Settings > Accounts.";
                let _ = state
                    .db
                    .set_account_state(account_id, "authFailed", Some(detail));
                emit_sync(app, account_id, "authFailed", Some("Sign-in failed"), None);
                Err(PassError::AuthenticationFailed(error.into()))
            } else if error.kind == FailureKind::Certificate {
                let detail =
                    "Certificate verification failed. Check the trusted server certificate.";
                let _ = state
                    .db
                    .set_account_state(account_id, "offline", Some(detail));
                emit_sync(app, account_id, "offline", Some(detail), None);
                Err(PassError::Other(error.into()))
            } else {
                let _ = state.db.set_account_state(
                    account_id,
                    "offline",
                    Some("Mail sync is temporarily unavailable."),
                );
                emit_sync(
                    app,
                    account_id,
                    "offline",
                    Some("Will try again automatically"),
                    None,
                );
                Err(PassError::Other(error.into()))
            }
        }
    }
}

/// How often the visible non-INBOX folder is re-checked. INBOX has its own
/// watcher, so it is never polled here.
pub(crate) const FOLDER_POLL: Duration = Duration::from_secs(60);

/// The folder an account has open, as the frontend reports it.
#[derive(Debug, Clone)]
pub(crate) struct VisibleFolder {
    pub mailbox_id: i64,
    pub inbox: bool,
    /// When the folder was last scanned, or selected.
    pub polled_at: Instant,
}

/// Time until the visible folder is due, or `None` when nothing is polled.
pub(crate) fn folder_poll_due(visible: Option<&VisibleFolder>, now: Instant) -> Option<Duration> {
    let visible = visible?;
    if visible.inbox {
        return None;
    }
    Some((visible.polled_at + FOLDER_POLL).saturating_duration_since(now))
}

/// Folders a wake covers: the account's effective Inbox for the watcher, and
/// the visible folder once its poll is due. The pass resolves the Inbox name,
/// so an explicit assignment and a raw role never both join one pass.
pub(crate) fn scope_for_wake(
    reasons: u16,
    visible_name: Option<&str>,
) -> Option<mail::sync::SyncScope> {
    let visible = (reasons & wake::FOLDER != 0)
        .then(|| visible_name.map(str::to_string))
        .flatten();
    if reasons & wake::INBOX != 0 {
        return Some(mail::sync::SyncScope::Inbox {
            also: visible.into_iter().collect(),
        });
    }
    visible.map(|name| mail::sync::SyncScope::Folders(vec![name]))
}

impl AppState {
    pub(crate) fn visible_folder_due(&self, account_id: &str) -> Option<Duration> {
        let folders = self.visible_folders.lock().ok()?;
        folder_poll_due(folders.get(account_id), Instant::now())
    }

    pub(crate) fn mark_visible_folder_polled(&self, account_id: &str) {
        if let Ok(mut folders) = self.visible_folders.lock() {
            if let Some(folder) = folders.get_mut(account_id) {
                folder.polled_at = Instant::now();
            }
        }
    }

    /// The non-INBOX folder to poll, by its current name.
    pub(crate) fn visible_folder_name(&self, account_id: &str) -> Option<String> {
        let mailbox_id = {
            let folders = self.visible_folders.lock().ok()?;
            folders
                .get(account_id)
                .filter(|folder| !folder.inbox)
                .map(|folder| folder.mailbox_id)?
        };
        let (owner, name) = self.db.mailbox(mailbox_id).ok()?;
        (owner == account_id).then_some(name)
    }
}

/// Record the folder the mailbox has open, or clear it with `None`. The
/// worker re-checks its timers so a new selection is polled on time.
#[tauri::command]
pub async fn set_visible_folder(
    account_id: String,
    mailbox_id: Option<i64>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    command_result(store_visible_folder(&state, &account_id, mailbox_id))
}

fn store_visible_folder(
    state: &AppState,
    account_id: &str,
    mailbox_id: Option<i64>,
) -> Result<(), String> {
    let actor = state.actor(account_id)?;
    {
        let mut folders = state
            .visible_folders
            .lock()
            .map_err(|_| "Folder polling is unavailable.".to_string())?;
        match mailbox_id {
            None => {
                folders.remove(account_id);
            }
            Some(id) => {
                let (owner, _) = state
                    .db
                    .mailbox(id)
                    .map_err(|_| "Folder not found.".to_string())?;
                if owner != account_id {
                    return Err("Folder not found.".into());
                }
                let inbox = state
                    .db
                    .mailbox_for_role(account_id, "inbox")?
                    .is_some_and(|(inbox_id, _)| inbox_id == id);
                folders.insert(
                    account_id.to_string(),
                    VisibleFolder {
                        mailbox_id: id,
                        inbox,
                        polled_at: Instant::now(),
                    },
                );
            }
        }
    }
    actor.nudge();
    Ok(())
}

/// Draft and outbox work that does not need a full pass. The caller holds
/// the account.
pub(crate) async fn run_targeted_jobs(
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
    reasons: u16,
) {
    let Ok(account) = state.db.account(account_id) else {
        return;
    };
    if reasons & wake::DRAFTS != 0 {
        if let Ok(password) = crate::oauth::session_secret(&account).await {
            sync_drafts_locked(state, &account, &password).await;
            emit_draft_change(app, account_id, None, None);
        }
    }
    if reasons & wake::OUTBOX != 0 {
        replay_outbox_locked(account_id, app, state).await;
        emit_outbox_change(app, account_id, None, None);
    }
    if reasons & wake::REPLAY != 0 {
        replay_due_operations_locked(account_id, app, state).await;
    }
}

/// Replay queued operations that came due, such as undo-window moves. Does
/// not run a mailbox pass.
async fn replay_due_operations_locked(account_id: &str, app: &AppHandle, state: &AppState) {
    let Ok(account) = state.db.account(account_id) else {
        return;
    };
    let Ok(password) = crate::oauth::session_secret(&account).await else {
        return;
    };
    let policy = account_policy(state, account_id).unwrap_or_default();
    let _ = replay_offline_operations(app, &state.db, &account, &password, &policy).await;
    emit_message_change(app, account_id, None, "moved");
    emit_folder_counts(app, account_id);
}

/// A sentinel for arrival-only rule work. Durable per-message state owns the
/// actual provenance; the legacy account mark keeps pre-v44 retries covered.
pub(crate) fn begin_rule_window(db: &Database, account_id: &str) -> Option<i64> {
    let mark = db
        .rules_pending_from(account_id)
        .ok()
        .flatten()
        .unwrap_or(0);
    db.keep_rules_pending_from(account_id, mark).ok()?;
    Some(mark)
}

pub(crate) fn finish_sync_rule_window(
    db: &Database,
    account: &AccountRecord,
    watermark: Option<i64>,
    succeeded: bool,
    allow_notices: bool,
    on_notice: &mut dyn FnMut(i64) -> bool,
) -> Vec<i64> {
    if !succeeded {
        if let Some(mark) = watermark {
            let _ = db.keep_rules_pending_from(&account.summary.id, mark);
        }
        return Vec::new();
    }
    let mut fired = false;
    let (complete, matched_notify_ids) =
        apply_filter_rules_collecting(db, account, watermark, &mut |message_id| {
            if allow_notices && on_notice(message_id) {
                fired = true;
            }
        });
    if complete {
        let _ = db.clear_rules_pending_from(&account.summary.id);
    } else if let Some(mark) = watermark {
        let _ = db.keep_rules_pending_from(&account.summary.id, mark);
    }
    if fired {
        matched_notify_ids
    } else {
        Vec::new()
    }
}

#[cfg(test)]
pub(crate) fn finish_rule_window(
    db: &Database,
    account: &AccountRecord,
    watermark: Option<i64>,
    succeeded: bool,
    on_notice: &mut dyn FnMut(i64),
) {
    finish_sync_rule_window(db, account, watermark, succeeded, true, &mut |id| {
        on_notice(id);
        true
    });
}

/// A message a rule matched: (id, uid, folder name, folder id).
type RuleHit = (i64, u32, String, i64);

/// One rule action, resolved against the account's folders.
enum PlannedStep {
    MarkRead,
    Move {
        destination_id: i64,
        destination: String,
    },
    Flag(u8),
    Pin,
    Notify,
}

fn plan_step(
    db: &Database,
    account_id: &str,
    action: &RuleAction,
) -> Result<Option<PlannedStep>, String> {
    let step = match action.kind.as_str() {
        "mark_read" => Some(PlannedStep::MarkRead),
        "pin" => Some(PlannedStep::Pin),
        "notify" => Some(PlannedStep::Notify),
        "flag" => action
            .flag_color
            .filter(|color| *color <= MAX_FLAG_COLOR)
            .map(PlannedStep::Flag),
        "move_archive" | "move_trash" | "move_junk" => {
            let role = action.kind.strip_prefix("move_").unwrap_or("archive");
            db.mailbox_for_rule_role(account_id, role)?
                .map(|(destination_id, destination)| PlannedStep::Move {
                    destination_id,
                    destination,
                })
        }
        "move_mailbox" => match action
            .target_mailbox
            .as_deref()
            .and_then(|id| id.parse::<i64>().ok())
        {
            Some(id) => db
                .mailbox_name_for_account(account_id, id)?
                .map(|destination| PlannedStep::Move {
                    destination_id: id,
                    destination,
                }),
            None => None,
        },
        _ => None,
    };
    Ok(step)
}

/// File newly synced inbox mail through enabled filter rules. Actions
/// reuse the offline queue (local apply + queued op), so the replay later
/// in this sync delivers them and failures stay queued, never half-applied.
/// `newer_than_id` selects durable catch-up arrivals; `None` evaluates every
/// unread Inbox message for a retroactive rule edit.
pub(crate) fn apply_filter_rules(
    db: &Database,
    account: &AccountRecord,
    newer_than_id: Option<i64>,
) -> bool {
    apply_filter_rules_notifying(db, account, newer_than_id, &mut |_| {})
}

/// `apply_filter_rules` that also reports one notify candidate: the newest
/// message a notify action matched. Only new mail (`newer_than_id` set)
/// can produce one, so rule creation never notifies about old mail.
pub(crate) fn apply_filter_rules_notifying(
    db: &Database,
    account: &AccountRecord,
    newer_than_id: Option<i64>,
    on_notice: &mut dyn FnMut(i64),
) -> bool {
    apply_filter_rules_collecting(db, account, newer_than_id, on_notice).0
}

fn apply_filter_rules_collecting(
    db: &Database,
    account: &AccountRecord,
    newer_than_id: Option<i64>,
    on_notice: &mut dyn FnMut(i64),
) -> (bool, Vec<i64>) {
    let account_id = &account.summary.id;
    let Ok(rules) = db.list_filter_rules(account_id) else {
        return (false, Vec::new());
    };
    let arrival_ids = if newer_than_id.is_some() {
        let Ok(ids) = db.pending_rule_arrival_ids(account_id) else {
            return (false, Vec::new());
        };
        Some(ids)
    } else {
        None
    };
    let mut planned: Vec<(PlannedStep, Vec<RuleHit>)> = Vec::new();
    let mut complete = true;
    let mut notice: Option<i64> = None;
    let mut notify_matched_ids: Vec<i64> = Vec::new();
    let mut failed = std::collections::HashSet::new();
    for rule in rules.iter().filter(|rule| rule.enabled) {
        if validate_filter_rule(rule, account_id).is_err() {
            continue;
        }
        let matches = match arrival_ids.as_deref() {
            Some(ids) => db.find_rule_matches_in_arrivals(account_id, rule, ids),
            None => db.find_rule_matches(account_id, rule, newer_than_id),
        };
        let Ok(matches) = matches else {
            complete = false;
            if let Some(ids) = arrival_ids.as_ref() {
                failed.extend(ids.iter().copied());
            }
            continue;
        };
        if arrival_ids.is_none() {
            complete &= matches.len() < 100;
        }
        if matches.is_empty() {
            continue;
        }
        let mut steps = Vec::new();
        let mut unresolved = false;
        let mut planning_failed = false;
        for action in &rule.actions {
            match plan_step(db, account_id, action) {
                Ok(Some(step)) => steps.push(step),
                Ok(None) => unresolved = true,
                Err(_) => {
                    complete = false;
                    planning_failed = true;
                }
            }
        }
        // Manual retroactive application remains incomplete when its target
        // is unavailable; automatic arrivals skip it to avoid page starvation.
        if unresolved && arrival_ids.is_none() {
            complete = false;
        }
        if planning_failed {
            failed.extend(matches.iter().map(|(id, _, _, _)| *id));
        }
        if steps.is_empty() {
            continue;
        }
        for step in steps {
            match step {
                PlannedStep::Notify => {
                    if newer_than_id.is_some() {
                        notify_matched_ids.extend(matches.iter().map(|(id, _, _, _)| *id));
                        let newest = matches.iter().map(|(id, _, _, _)| *id).max();
                        notice = notice.max(newest);
                    }
                }
                step => planned.push((step, matches.clone())),
            }
        }
    }
    // Queue flag/pin updates before moves so replay never drops flags on removed source rows.
    planned.sort_by_key(|(step, _)| matches!(step, PlannedStep::Move { .. }) as u8);
    for (step, matches) in planned {
        match step {
            PlannedStep::MarkRead => {
                for (id, uid, mailbox, _) in &matches {
                    let Ok(Some(validity)) = db.mailbox_uid_validity(account_id, mailbox) else {
                        complete = false;
                        failed.insert(*id);
                        continue;
                    };
                    let operation = FlagOperation {
                        message_id: *id,
                        uid: *uid,
                        mailbox: mailbox.clone(),
                        uid_validity: Some(validity),
                        is_read: Some(true),
                        is_starred: None,
                        flag_color: None,
                    };
                    let Ok(queued) = serde_json::to_value(&operation) else {
                        complete = false;
                        failed.insert(*id);
                        continue;
                    };
                    if db
                        .record_colored_flag_change(
                            account_id,
                            *id,
                            Some(true),
                            None,
                            None,
                            Some(&queued),
                        )
                        .is_err()
                    {
                        complete = false;
                        failed.insert(*id);
                    }
                }
            }
            PlannedStep::Move {
                destination_id,
                destination,
            } => {
                for (id, uid, source, _) in &matches {
                    if source == &destination {
                        continue;
                    }
                    let Ok(Some(validity)) = db.mailbox_uid_validity(account_id, source) else {
                        complete = false;
                        failed.insert(*id);
                        continue;
                    };
                    let operation = MoveOperation {
                        message_id: *id,
                        uid: *uid,
                        source: source.clone(),
                        destination: destination.clone(),
                        uid_validity: Some(validity),
                        junk_keyword: None,
                    };
                    let dedupe_key = format!("move:{id}");
                    match db.has_offline_op_dedupe_key(account_id, &dedupe_key) {
                        Ok(true) => continue,
                        Ok(false) => {}
                        Err(_) => {
                            complete = false;
                            failed.insert(*id);
                            continue;
                        }
                    }
                    if db
                        .queue_operation(account_id, "move", &operation, Some(&dedupe_key))
                        .is_err()
                    {
                        complete = false;
                        failed.insert(*id);
                        continue;
                    }
                    if db.mark_pending_move(*id, destination_id).is_err() {
                        complete = false;
                        failed.insert(*id);
                    }
                }
            }
            PlannedStep::Flag(color) => {
                for (id, uid, mailbox, _) in &matches {
                    let Ok(Some(validity)) = db.mailbox_uid_validity(account_id, mailbox) else {
                        complete = false;
                        failed.insert(*id);
                        continue;
                    };
                    // Same path as the manual color command: local color and
                    // the queued op (with its color bits) commit together.
                    let operation = FlagOperation {
                        message_id: *id,
                        uid: *uid,
                        mailbox: mailbox.clone(),
                        uid_validity: Some(validity),
                        is_read: None,
                        is_starred: Some(true),
                        flag_color: Some(color),
                    };
                    let payload = serde_json::to_value(&operation).ok();
                    if db
                        .record_colored_flag_change(
                            account_id,
                            *id,
                            None,
                            Some(true),
                            Some(ColorChange::Set(color)),
                            payload.as_ref(),
                        )
                        .is_err()
                    {
                        complete = false;
                        failed.insert(*id);
                    }
                }
            }
            PlannedStep::Pin => {
                let ids: Vec<i64> = matches.iter().map(|(id, _, _, _)| *id).collect();
                if db.set_pinned(account_id, &ids, true).is_err() {
                    complete = false;
                    failed.extend(ids);
                }
            }
            PlannedStep::Notify => {}
        }
    }
    if let Some(message_id) = notice {
        on_notice(message_id);
    }
    if let Some(ids) = arrival_ids.as_ref() {
        let handled: Vec<i64> = ids
            .iter()
            .copied()
            .filter(|id| !failed.contains(id))
            .collect();
        if db
            .finish_rule_arrivals(account_id, false, &handled, &notify_matched_ids)
            .is_err()
        {
            complete = false;
        } else if complete && failed.is_empty() {
            match db.pending_rule_arrival_ids(account_id) {
                Ok(remaining) if remaining.is_empty() => {
                    complete = db.finish_rule_arrivals(account_id, true, &[], &[]).is_ok();
                }
                Ok(_) | Err(_) => complete = false,
            }
        } else {
            complete = false;
        }
    }
    (complete, notify_matched_ids)
}

async fn sync_drafts_locked(state: &AppState, account: &AccountRecord, password: &str) {
    let account_id = &account.summary.id;
    let Some((_, drafts_mailbox)) = state
        .db
        .mailbox_for_role(account_id, "drafts")
        .ok()
        .flatten()
    else {
        let _ = state.db.set_draft_sync_warning(
            account_id,
            "Saved locally. This account has no confirmed Drafts mailbox.",
        );
        return;
    };
    let records = match state.db.pending_draft_sync(account_id) {
        Ok(records) => records,
        Err(_) => return,
    };
    for record in records {
        if record.deleted {
            let result = match (record.remote_mailbox.as_deref(), record.remote_uid) {
                (Some(mailbox), Some(uid)) => {
                    mail::delete_remote_draft(
                        account,
                        password,
                        mailbox,
                        uid,
                        record.remote_uid_validity,
                    )
                    .await
                }
                _ => Ok(()),
            };
            if result.is_ok() {
                let _ = state.db.finish_remote_draft_delete(&record.id, account_id);
            } else {
                let _ = state.db.set_one_draft_sync_warning(
                    &record.id,
                    account_id,
                    "Deletion is saved locally and will retry when the Drafts folder is available.",
                );
            }
            continue;
        }
        let resolved = match resolve_draft_files(&state.db, &record.draft) {
            Ok(draft) => draft,
            Err(_) => {
                let _ = state.db.set_one_draft_sync_warning(
                    &record.id,
                    account_id,
                    "Saved locally. Reattach a missing file before this draft can synchronize.",
                );
                continue;
            }
        };
        let message_id = if record.remote_message_id.is_empty() {
            format!("<draft-{}-{}@run.rosie.snap>", record.id, record.revision)
        } else {
            record.remote_message_id.clone()
        };
        let bytes = match mail::prepare_draft_message(account, &resolved, &message_id).await {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = state.db.set_one_draft_sync_warning(
                    &record.id,
                    account_id,
                    "Saved locally. This draft could not be prepared for server synchronization.",
                );
                continue;
            }
        };
        let same_mailbox = record.remote_mailbox.as_deref() == Some(drafts_mailbox.as_str());
        let result = mail::upsert_remote_draft(
            account,
            password,
            &drafts_mailbox,
            &message_id,
            &bytes,
            same_mailbox.then_some(record.remote_uid).flatten(),
            same_mailbox.then_some(record.remote_uid_validity).flatten(),
        )
        .await;
        match result {
            Ok(location) => {
                if !same_mailbox {
                    if let (Some(old_mailbox), Some(old_uid)) =
                        (record.remote_mailbox.as_deref(), record.remote_uid)
                    {
                        let _ = mail::delete_remote_draft(
                            account,
                            password,
                            old_mailbox,
                            old_uid,
                            record.remote_uid_validity,
                        )
                        .await;
                    }
                }
                let _ = state.db.mark_draft_synced(
                    &record.id,
                    account_id,
                    &drafts_mailbox,
                    location.uid,
                    location.uid_validity,
                    &message_id,
                    record.revision,
                );
            }
            Err(_) => {
                let _ = state.db.set_one_draft_sync_warning(
                    &record.id,
                    account_id,
                    "Saved locally. Draft synchronization will retry automatically.",
                );
            }
        }
    }
    import_remote_drafts_locked(state, account, password, &drafts_mailbox).await;
}

async fn import_remote_drafts_locked(
    state: &AppState,
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
) {
    let account_id = &account.summary.id;
    let uid_validity = state
        .db
        .mailbox_uid_validity(account_id, mailbox)
        .ok()
        .flatten();
    let known = state
        .db
        .remote_draft_uids(account_id, mailbox, uid_validity)
        .unwrap_or_default();
    let snapshot = match mail::fetch_remote_drafts(account, password, mailbox, &known).await {
        Ok(snapshot) => snapshot,
        Err(_) => return,
    };
    let account_dir = match managed_account_dir(&state.attachment_dir, account_id) {
        Ok(path) => path,
        Err(_) => return,
    };
    if tokio::fs::create_dir_all(&account_dir).await.is_err() {
        return;
    }
    for remote in snapshot.drafts {
        let parsed_identity = remote
            .message_id
            .as_deref()
            .and_then(parse_postal_draft_message_id);
        let (mut id, revision) = parsed_identity
            .clone()
            .unwrap_or_else(|| (uuid::Uuid::new_v4().to_string(), 1));
        let existing = state.db.draft_sync_state(&id, account_id).ok().flatten();
        let mut sync_state = "synced";
        let mut sync_detail = None;
        if existing.as_ref().is_some_and(|(state, _, is_deleted)| {
            *is_deleted
                || matches!(
                    state.as_str(),
                    "reserved" | "deletePending" | "outboxDeletePending"
                )
        }) {
            continue;
        }
        if existing
            .as_ref()
            .is_some_and(|(state, _, _)| state != "synced" && state != "conflict")
        {
            id = uuid::Uuid::new_v4().to_string();
            sync_state = "conflict";
            sync_detail = Some("Recovered server copy; your local changes were preserved.");
        } else if existing
            .as_ref()
            .is_some_and(|(_, local_revision, _)| *local_revision > revision)
        {
            let _ = state.db.update_remote_draft_tracking(
                &id,
                account_id,
                mailbox,
                remote.uid,
                snapshot.uid_validity,
                remote.message_id.as_deref(),
            );
            continue;
        }
        let mut attachments = Vec::new();
        let mut write_failed = false;
        for attachment in remote.attachments {
            let token = uuid::Uuid::new_v4().to_string();
            let path = account_dir.join(&token);
            if tokio::fs::write(&path, &attachment.bytes).await.is_err() {
                write_failed = true;
                break;
            }
            #[cfg(unix)]
            if tokio::fs::set_permissions(
                &path,
                std::os::unix::fs::PermissionsExt::from_mode(0o600),
            )
            .await
            .is_err()
            {
                let _ = tokio::fs::remove_file(&path).await;
                write_failed = true;
                break;
            }
            if state
                .db
                .grant_file(&token, account_id, &path, attachment.bytes.len() as u64)
                .is_err()
            {
                let _ = tokio::fs::remove_file(&path).await;
                write_failed = true;
                break;
            }
            attachments.push(ComposeAttachment {
                token,
                filename: attachment.filename,
                content_type: Some(attachment.content_type),
                inline: attachment.inline,
                content_id: attachment.content_id,
                size: Some(attachment.bytes.len()),
            });
        }
        if write_failed {
            release_attachment_tokens(
                state,
                account_id,
                attachments.iter().map(|item| item.token.as_str()),
            )
            .await;
            continue;
        }
        let draft = ComposeDraft {
            body_format: if remote.has_html {
                crate::models::BodyFormat::Html
            } else {
                crate::models::BodyFormat::Plain
            },
            source_message_id: None,
            source_kind: None,
            include_signature: false,
            importance: String::new(),
            request_receipt: false,
            reply_to: None,
            id: Some(id.clone()),
            account_id: account_id.clone(),
            from: remote.from.as_deref().and_then(|address| {
                let lower = address.trim().to_ascii_lowercase();
                let owned: Vec<String> = std::iter::once(&account.summary.email)
                    .chain(account.summary.aliases.iter())
                    .map(|item| item.trim().to_ascii_lowercase())
                    .collect();
                if owned.iter().any(|item| item == &lower) {
                    Some(address.trim().to_string())
                } else {
                    None
                }
            }),
            to: remote.to,
            cc: remote.cc,
            bcc: remote.bcc,
            subject: remote.subject,
            html_body: crate::html_sanitize::sanitize_compose_html(&remote.html_body),
            text_body: remote.text_body,
            attachments,
            in_reply_to: remote.in_reply_to,
            references: remote.references,
            send_at: None,
        };
        if state
            .db
            .import_remote_draft(
                &id,
                &draft,
                mailbox,
                remote.uid,
                snapshot.uid_validity,
                remote.message_id.as_deref(),
                revision,
                &remote.updated_at,
                sync_state,
                sync_detail,
            )
            .is_err()
        {
            release_attachment_tokens(
                state,
                account_id,
                draft.attachments.iter().map(|item| item.token.as_str()),
            )
            .await;
        }
    }
    let current = snapshot.uids.into_iter().collect::<HashSet<_>>();
    let _ = state
        .db
        .reconcile_remote_drafts(account_id, mailbox, snapshot.uid_validity, &current);
    cleanup_unreferenced_attachments(state, account_id).await;
}

fn parse_postal_draft_message_id(value: &str) -> Option<(String, u32)> {
    let value = value.trim().trim_start_matches('<').trim_end_matches('>');
    let at_index = value.rfind('@')?;
    let (local, domain) = value.split_at(at_index);
    if !domain.eq_ignore_ascii_case("@run.rosie.snap") {
        return None;
    }
    let local = local.strip_prefix("draft-")?;
    let (id, revision) = local.rsplit_once('-')?;
    uuid::Uuid::parse_str(id).ok()?;
    Some((id.to_string(), revision.parse().ok()?))
}

/// Same signal `send_scheduled_outbox` uses: a parked account replays
/// nothing, so an offline wake cannot burn retry waits against a network that
/// is not there.
fn offline_for_delivery(sync_state: &str) -> bool {
    sync_state == "offline"
}

pub(crate) async fn replay_outbox_locked(account_id: &str, app: &AppHandle, state: &AppState) {
    // Offline accounts leave their rows parked; reconnect triggers a full
    // sync, which replays.
    if state
        .db
        .account(account_id)
        .is_ok_and(|account| offline_for_delivery(&account.summary.sync_state))
    {
        return;
    }
    // `archive_pending` records a confirmed SMTP send. It is deliberately
    // excluded here so background replay cannot send it again.
    if let Ok(ids) = state
        .db
        .outbox_ids_in_state(account_id, &["sent_copy_pending"])
    {
        for id in ids {
            let _ = retry_sent_copy_locked(&id, account_id, app, state).await;
        }
    }
    if let Ok(ids) = state.db.due_queued_outbox_ids(account_id) {
        for id in ids {
            let _ = deliver_outbox_locked(&id, account_id, "queued", app, state).await;
        }
    }
    let now = crate::date_time::format_rfc3339(crate::date_time::now_utc());
    if let Ok(ids) = state.db.scheduled_due_outbox_ids(account_id, &now) {
        for id in ids {
            let _ = deliver_outbox_locked(&id, account_id, "scheduled", app, state).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        folder_poll_due, offline_for_delivery, scope_for_wake, VisibleFolder, FOLDER_POLL,
    };
    use crate::commands::wake;
    use crate::mail::sync::SyncScope;
    use std::time::{Duration, Instant};

    // Visible-folder failure modes (D8):
    // 1. INBOX is polled on a timer on top of its IDLE watcher.
    // 2. A hidden folder keeps polling after the selection is cleared.
    // 3. A new selection polls at once instead of after one interval.
    #[test]
    fn visible_folder_polls_after_one_interval_and_never_inbox() {
        let now = Instant::now();
        assert_eq!(folder_poll_due(None, now), None, "cleared selection");
        let inbox = VisibleFolder {
            mailbox_id: 1,
            inbox: true,
            polled_at: now,
        };
        assert_eq!(folder_poll_due(Some(&inbox), now), None);
        let archive = VisibleFolder {
            mailbox_id: 2,
            inbox: false,
            polled_at: now,
        };
        assert_eq!(FOLDER_POLL, Duration::from_secs(60));
        assert_eq!(folder_poll_due(Some(&archive), now), Some(FOLDER_POLL));
        let later = now + Duration::from_secs(45);
        assert_eq!(
            folder_poll_due(Some(&archive), later),
            Some(Duration::from_secs(15))
        );
    }

    #[test]
    fn wake_scope_scans_inbox_and_visible_folder_once() {
        assert_eq!(
            scope_for_wake(wake::INBOX, None),
            Some(SyncScope::Inbox { also: Vec::new() })
        );
        assert_eq!(
            scope_for_wake(wake::FOLDER, Some("Archive")),
            Some(SyncScope::Folders(vec!["Archive".into()]))
        );
        assert_eq!(scope_for_wake(wake::FOLDER, None), None, "cleared folder");
        assert_eq!(scope_for_wake(wake::OUTBOX, Some("Archive")), None);
        assert_eq!(
            scope_for_wake(wake::INBOX | wake::FOLDER, Some("Archive")),
            Some(SyncScope::Inbox {
                also: vec!["Archive".into()]
            })
        );
    }

    #[test]
    fn offline_wake_replays_nothing_until_reconnect() {
        assert!(offline_for_delivery("offline"));
        for sync_state in ["idle", "syncing", "downloading", "", "error"] {
            assert!(
                !offline_for_delivery(sync_state),
                "state {sync_state:?} must keep replaying"
            );
        }
    }

    #[test]
    fn rule_mark_read_updates_local_unread_delta() {
        use crate::db::{CachedMessage, Database};
        use crate::models::{
            AccountRecord, AccountSummary, BodyFormat, FilterRule, MailboxRole, ProviderKind,
            RuleAction, RuleCondition, ServerConfig, TlsMode,
        };

        let db = Database::memory();
        let server = ServerConfig {
            host: "mail.example.test".into(),
            port: 993,
            tls_mode: TlsMode::Tls,
            username: "sam@example.test".into(),
            trusted_certificate: None,
        };
        let account = AccountRecord {
            summary: AccountSummary {
                notify_new_mail: true,
                id: "acct-rule-read".into(),
                provider: ProviderKind::Manual,
                provider_id: None,
                app_password_policy: None,
                app_password_url: None,
                password_format: None,
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
                default_body_format: BodyFormat::Plain,
            },
            imap: server.clone(),
            smtp: server,
        };
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(1),
                1,
            )
            .unwrap();
        db.upsert_envelope(
            &account.summary.id,
            inbox,
            &CachedMessage {
                uid: 1,
                internal_at: None,
                message_id: Some("<r1@example.test>".into()),
                subject: "Statement".into(),
                sender_name: "Billing".into(),
                sender_address: "billing@power.example.test".into(),
                recipients: String::new(),
                received_at: "2026-08-18T12:00:00Z".into(),
                preview: String::new(),
                is_read: false,
                is_starred: false,
                size: 100,
                to: vec![],
                cc: vec![],
                bcc: vec![],
                reply_to: None,
                thread_parent: None,
                text_body: String::new(),
                html_body: None,
                attachments: vec![],
                raw_message: vec![],
                has_attachments: false,
                is_answered: false,
                is_forwarded: false,
                has_calendar: false,
                calendar_json: None,
                list_unsubscribe: None,
                list_unsubscribe_post: None,
                importance: String::new(),
                disposition_to: String::new(),
            },
        )
        .unwrap();
        let rule = FilterRule {
            id: "rule-mark-read".into(),
            account_id: account.summary.id.clone(),
            name: "Mark read".into(),
            field: "from".into(),
            contains: "power.example.test".into(),
            action: "mark_read".into(),
            target_mailbox: None,
            enabled: true,
            match_mode: "all".into(),
            conditions: vec![RuleCondition {
                field: "from".into(),
                value: "power.example.test".into(),
            }],
            actions: vec![RuleAction {
                kind: "mark_read".into(),
                target_mailbox: None,
                flag_color: None,
            }],
        };
        db.create_filter_rule(&rule).unwrap();

        let (complete, _) = super::apply_filter_rules_collecting(&db, &account, None, &mut |_| {});
        assert!(complete);
        let inbox_summary = db
            .list_mailboxes(&account.summary.id)
            .unwrap()
            .into_iter()
            .find(|box_| box_.id == inbox)
            .unwrap();
        assert_eq!(inbox_summary.unread_count, 0);
    }

    // Failure modes for Rules v2 execution:
    // 1. Move queued before MarkRead/Flag drops flag updates when move deletes INBOX row.
    // 2. Broken rule pointing at missing mailbox stalls ARRIVAL_RULE_PENDING for unrelated rules.
    #[test]
    fn rules_enqueue_flags_before_moves_and_isolate_missing_folders() {
        use crate::db::{CachedMessage, Database};
        use crate::models::{
            AccountRecord, AccountSummary, BodyFormat, FilterRule, MailboxRole, ProviderKind,
            RuleAction, RuleCondition, ServerConfig, TlsMode,
        };

        let db = Database::memory();
        let server = ServerConfig {
            host: "mail.example.test".into(),
            port: 993,
            tls_mode: TlsMode::Tls,
            username: "sam@example.test".into(),
            trusted_certificate: None,
        };
        let account = AccountRecord {
            summary: AccountSummary {
                notify_new_mail: true,
                id: "acct-rule-order".into(),
                provider: ProviderKind::Manual,
                provider_id: None,
                app_password_policy: None,
                app_password_url: None,
                password_format: None,
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
                default_body_format: BodyFormat::Plain,
            },
            imap: server.clone(),
            smtp: server,
        };
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                &account.summary.id,
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(1),
                1,
            )
            .unwrap();
        let archive = db
            .upsert_mailbox(
                &account.summary.id,
                "Archive",
                &MailboxRole::Archive,
                Some(2),
                Some(2),
                Some(0),
                0,
            )
            .unwrap();
        let _ = archive;
        let msg = CachedMessage {
            internal_at: None,
            uid: 11,
            message_id: Some("<rule-order@example.test>".into()),
            subject: "Bill ready".into(),
            sender_name: "Power".into(),
            sender_address: "billing@power.example.test".into(),
            recipients: String::new(),
            received_at: "2026-08-18T12:00:00Z".into(),
            preview: String::new(),
            is_read: false,
            is_starred: false,
            size: 100,
            to: vec![],
            cc: vec![],
            bcc: vec![],
            reply_to: None,
            thread_parent: None,
            text_body: String::new(),
            html_body: None,
            attachments: vec![],
            raw_message: vec![],
            has_attachments: false,
            is_answered: false,
            is_forwarded: false,
            has_calendar: false,
            calendar_json: None,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            importance: String::new(),
            disposition_to: String::new(),
        };
        db.upsert_message(&account.summary.id, inbox, &msg).unwrap();
        // Rule 1 targets a non-existent folder and does not match this message.
        db.create_filter_rule(&FilterRule {
            id: "broken".into(),
            account_id: account.summary.id.clone(),
            name: "Broken".into(),
            field: "from".into(),
            contains: "nobody@elsewhere.test".into(),
            action: "move_mailbox".into(),
            target_mailbox: Some("99999".into()),
            enabled: true,
            match_mode: "all".into(),
            conditions: vec![RuleCondition {
                field: "from".into(),
                value: "nobody@elsewhere.test".into(),
            }],
            actions: vec![RuleAction {
                kind: "move_mailbox".into(),
                target_mailbox: Some("99999".into()),
                flag_color: None,
            }],
        })
        .unwrap();
        // Rule 2 has Move before Flag+MarkRead; queue order must still put flags first.
        db.create_filter_rule(&FilterRule {
            id: "move-and-flag".into(),
            account_id: account.summary.id.clone(),
            name: "File and flag".into(),
            field: "from".into(),
            contains: "power.example.test".into(),
            action: "move_archive".into(),
            target_mailbox: None,
            enabled: true,
            match_mode: "all".into(),
            conditions: vec![RuleCondition {
                field: "from".into(),
                value: "power.example.test".into(),
            }],
            actions: vec![
                RuleAction {
                    kind: "move_archive".into(),
                    target_mailbox: None,
                    flag_color: None,
                },
                RuleAction {
                    kind: "mark_read".into(),
                    target_mailbox: None,
                    flag_color: None,
                },
                RuleAction {
                    kind: "flag".into(),
                    target_mailbox: None,
                    flag_color: Some(2),
                },
            ],
        })
        .unwrap();

        let (complete, _) = super::apply_filter_rules_collecting(&db, &account, None, &mut |_| {});
        assert!(complete, "unmatched broken rule must not stall completion");
        let ops = db.queued_operations(&account.summary.id).unwrap();
        let kinds: Vec<&str> = ops.iter().map(|op| op.1.as_str()).collect();
        let last_non_move = kinds.iter().rposition(|k| *k != "move").unwrap();
        let first_move = kinds.iter().position(|k| *k == "move").unwrap();
        assert!(last_non_move < first_move, "ops order was {kinds:?}");
    }
}
