use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub mod accounts;
pub mod attachments;
pub mod badge;
pub mod cache_policy;
pub mod compatibility;
pub mod drafts_send;
pub mod drag_drop;
pub mod folders;
pub mod messages;
pub mod outbox;
pub mod replied;
pub mod security_net;
pub mod settings_system;
pub mod snooze_filters;
pub mod sync;

#[cfg(test)]
#[path = "commands/deferred_integration_tests.rs"]
mod deferred_integration_tests;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    db::Database,
    mail,
    models::{
        normalize_setup_password, validate_compose_draft, validate_compose_sender, AccountRecord,
        CachePolicy, ComposeDraft, IpcError, SyncState,
    },
    oauth,
    settings::SettingsStore,
};

use messages::{FlagOperation, MoveOperation};

type CommandResult<T> = Result<T, IpcError>;

fn command_result<T>(result: Result<T, String>) -> CommandResult<T> {
    result.map_err(Into::into)
}

fn refresh_mail_menu(app: &AppHandle, state: &AppState) {
    let count = state.db.account_count().unwrap_or(0);
    crate::update_mail_menu_or_warn(
        app,
        crate::mail_actions_enabled(count) && !state.mail_shortcut_guarded(),
    );
}

fn take_normalized_account_password(
    provider: &crate::models::ProviderKind,
    mut password: Zeroizing<String>,
) -> Result<Zeroizing<String>, IpcError> {
    let normalized = Zeroizing::new(normalize_setup_password(provider, &password));
    password.zeroize();
    if normalized.is_empty() || normalized.len() > 4096 {
        return Err("Enter the app-specific or email password.".into());
    }
    Ok(normalized)
}

fn validate_owned_compose(draft: &ComposeDraft, account: &AccountRecord) -> Result<(), String> {
    validate_compose_draft(draft)?;
    validate_compose_sender(
        draft.from.as_deref(),
        &account.summary.email,
        &account.summary.aliases,
    )
}

fn prepare_owned_compose(
    mut draft: ComposeDraft,
    account: &AccountRecord,
) -> Result<ComposeDraft, String> {
    draft.html_body = crate::html_sanitize::sanitize_compose_html(&draft.html_body);
    validate_owned_compose(&draft, account)?;
    Ok(draft)
}

pub struct AppState {
    pub db: Database,
    pub settings: SettingsStore,
    attachment_dir: PathBuf,
    account_actors: Mutex<HashMap<String, Arc<AccountActor>>>,
    workers: Mutex<HashSet<String>>,
    startup_error: Mutex<Option<String>>,
    mail_shortcut_guard: AtomicBool,
    /// The mail database or settings file did not open; the stand-ins must
    /// never receive accounts.
    storage_unavailable: AtomicBool,
    app_nap: crate::app_nap::ActivityHolds,
    update_gate: UpdateInstallGate,
    /// Folder the mailbox has open per account, polled while it is not INBOX.
    visible_folders: Mutex<HashMap<String, sync::VisibleFolder>>,
}

/// Prevent update installation from racing mail delivery.
pub(crate) struct UpdateInstallGate {
    active_deliveries: AtomicUsize,
    update_requested: AtomicBool,
    notify: Notify,
}

pub(crate) struct DeliveryGuard<'a> {
    gate: &'a UpdateInstallGate,
}

impl Drop for DeliveryGuard<'_> {
    fn drop(&mut self) {
        if self.gate.active_deliveries.fetch_sub(1, Ordering::SeqCst) == 1 {
            // Keep a permit if the updater has not registered its wait yet.
            self.gate.notify.notify_one();
        }
    }
}

impl UpdateInstallGate {
    fn new() -> Self {
        Self {
            active_deliveries: AtomicUsize::new(0),
            update_requested: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    /// Claim one delivery slot unless an update already owns the gate.
    pub(crate) fn try_start_delivery(&self) -> Option<DeliveryGuard<'_>> {
        if self.update_requested.load(Ordering::SeqCst) {
            return None;
        }
        self.active_deliveries.fetch_add(1, Ordering::SeqCst);
        if self.update_requested.load(Ordering::SeqCst) {
            if self.active_deliveries.fetch_sub(1, Ordering::SeqCst) == 1 {
                self.notify.notify_one();
            }
            return None;
        }
        Some(DeliveryGuard { gate: self })
    }

    pub(crate) async fn begin_update(&self) {
        self.update_requested.store(true, Ordering::SeqCst);
        while self.active_deliveries.load(Ordering::SeqCst) != 0 {
            self.notify.notified().await;
        }
    }

    pub(crate) fn release_update(&self) {
        self.update_requested.store(false, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
}

/// Why an account worker was woken. Reasons accumulate until the worker
/// takes them, so a wake-up sent while IDLE is starting is never lost.
pub(crate) mod wake {
    /// A user action needs the account; resume IDLE afterwards without a sync.
    pub const OPERATION: u16 = 1;
    /// Run a full sync pass (Get Mail, rule changes, folder changes).
    pub const SYNC: u16 = 2;
    /// Push local draft changes to the server.
    pub const DRAFTS: u16 = 4;
    /// Deliver queued or due outbox items.
    pub const OUTBOX: u16 = 8;
    /// Credentials changed; leave the sign-in-failed pause and sync.
    pub const CREDENTIALS: u16 = 16;
    /// The download policy changed; backfill or evict and sync.
    pub const POLICY: u16 = 32;
    /// A manual sync succeeded; leave the sign-in-failed pause without
    /// another pass.
    pub const RESUME: u16 = 64;
    /// The computer woke from sleep: sync like SYNC, but a worker paused for
    /// a rejected password stays paused.
    pub const SLEEP: u16 = 128;
    /// Replay offline operations that came due (undo-window moves) without a
    /// full pass.
    pub const REPLAY: u16 = 256;
    /// The INBOX watcher saw new mail: scan INBOX only.
    pub const INBOX: u16 = 512;
    /// The visible non-INBOX folder is due for its poll: scan it only.
    pub const FOLDER: u16 = 1024;
}

pub(crate) struct AccountActor {
    operation: Arc<AsyncMutex<()>>,
    wake: Notify,
    reasons: AtomicU16,
    /// Callers queued for the account lock. Background sync yields between
    /// folders and batches while this is non-zero.
    waiting: AtomicUsize,
    /// Read-only INBOX watcher state and its restart signal.
    watch: crate::mail::watch::WatchLink,
}

impl AccountActor {
    pub(crate) fn new() -> Self {
        Self {
            operation: Arc::new(AsyncMutex::new(())),
            wake: Notify::new(),
            reasons: AtomicU16::new(0),
            waiting: AtomicUsize::new(0),
            watch: crate::mail::watch::WatchLink::new(),
        }
    }

    pub(crate) fn request(&self, reason: u16) {
        self.reasons.fetch_or(reason, Ordering::SeqCst);
        // Sleep and credential changes also restart the watcher's session.
        if reason & (wake::SLEEP | wake::CREDENTIALS) != 0 {
            self.watch.signal_restart();
        }
        // notify_one stores a permit when IDLE is between setup and waiting,
        // avoiding a lost wake-up.
        self.wake.notify_one();
    }

    /// Wake the worker to re-check its timers without a reason.
    pub(crate) fn nudge(&self) {
        self.wake.notify_one();
    }

    pub(crate) fn watch(&self) -> &crate::mail::watch::WatchLink {
        &self.watch
    }

    pub(crate) fn take_reasons(&self) -> u16 {
        self.reasons.swap(0, Ordering::SeqCst)
    }

    fn contended(&self) -> bool {
        self.waiting.load(Ordering::SeqCst) > 0
    }

    async fn acquire(self: &Arc<Self>) -> OwnedMutexGuard<()> {
        struct Waiting<'a>(&'a AtomicUsize);
        impl Drop for Waiting<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        self.waiting.fetch_add(1, Ordering::SeqCst);
        let _waiting = Waiting(&self.waiting);
        self.operation.clone().lock_owned().await
    }

    /// The worker's lock: not counted as waiting, so a running pass never
    /// yields to the worker just so it can go back to IDLE.
    async fn acquire_for_worker(self: &Arc<Self>) -> OwnedMutexGuard<()> {
        self.operation.clone().lock_owned().await
    }
}

impl AppState {
    pub fn new(db: Database, settings: SettingsStore, attachment_dir: PathBuf) -> Self {
        Self {
            db,
            settings,
            attachment_dir,
            account_actors: Mutex::new(HashMap::new()),
            workers: Mutex::new(HashSet::new()),
            startup_error: Mutex::new(None),
            mail_shortcut_guard: AtomicBool::new(false),
            storage_unavailable: AtomicBool::new(false),
            app_nap: crate::app_nap::ActivityHolds::new("Postal Snap is keeping mail in sync"),
            update_gate: UpdateInstallGate::new(),
            visible_folders: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_startup_error(&self, error: Option<String>) -> Result<(), String> {
        *self
            .startup_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = error;
        Ok(())
    }

    pub fn take_startup_error(&self) -> Result<Option<String>, String> {
        let mut error = self
            .startup_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A storage failure lasts the whole launch, including window reloads.
        if self.storage_unavailable.load(Ordering::SeqCst) {
            return Ok(error.clone());
        }
        Ok(error.take())
    }

    pub fn set_storage_unavailable(&self) {
        self.storage_unavailable.store(true, Ordering::SeqCst);
    }

    /// Marker that asks the next launch to finish freeing disk space.
    pub(crate) fn compact_marker(&self) -> PathBuf {
        compact_marker_for(&self.attachment_dir)
    }

    /// Marker that records folders the last orphan sweep could not remove.
    pub(crate) fn orphan_marker(&self) -> PathBuf {
        orphan_marker_for(&self.attachment_dir)
    }

    /// Refuse work that would save accounts into a stand-in database.
    pub fn require_storage(&self) -> Result<(), String> {
        if self.storage_unavailable.load(Ordering::SeqCst) {
            return Err(
                "Postal Snap cannot change accounts until its mail data opens. Restart Postal Snap and try again."
                    .into(),
            );
        }
        Ok(())
    }

    pub fn set_mail_shortcut_guard(&self, guarded: bool) {
        self.mail_shortcut_guard.store(guarded, Ordering::Relaxed);
    }

    pub fn mail_shortcut_guarded(&self) -> bool {
        self.mail_shortcut_guard.load(Ordering::Relaxed)
    }

    pub(crate) fn actor(&self, account_id: &str) -> Result<Arc<AccountActor>, String> {
        // Validate before touching the map so arbitrary IDs cannot grow it.
        uuid::Uuid::parse_str(account_id).map_err(|_| "Account not found.".to_string())?;
        let mut actors = self
            .account_actors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Checked under the map lock: removal retires the actor while holding
        // the same lock after deleting the row, so a racing caller cannot
        // recreate a worker for a removed account.
        self.db.account(account_id)?;
        let actor = actors
            .entry(account_id.to_string())
            .or_insert_with(|| Arc::new(AccountActor::new()))
            .clone();
        Ok(actor)
    }

    /// Wake the account worker for `reason` without taking the account.
    pub(crate) fn request(&self, account_id: &str, reason: u16) -> Result<(), String> {
        self.actor(account_id)?.request(reason);
        Ok(())
    }

    pub(crate) async fn begin_update_install(&self) {
        self.update_gate.begin_update().await;
    }

    pub(crate) fn release_update_install(&self) {
        self.update_gate.release_update();
        let actors = self
            .account_actors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for actor in actors {
            actor.request(wake::OUTBOX);
        }
    }

    pub(crate) fn try_start_delivery(&self) -> Option<DeliveryGuard<'_>> {
        self.update_gate.try_start_delivery()
    }

    /// After system sleep: end a dead IDLE, send what came due, then sync.
    pub(crate) fn wake_after_sleep(&self, account_id: &str) {
        if let Ok(actor) = self.actor(account_id) {
            actor.request(wake::SLEEP | wake::OUTBOX);
        }
    }

    /// Take the account for a user action, interrupting IDLE and preempting
    /// background sync at its next yield point.
    async fn lock_account(&self, account_id: &str) -> Result<OwnedMutexGuard<()>, String> {
        let actor = self.actor(account_id)?;
        actor.request(wake::OPERATION);
        Ok(actor.acquire().await)
    }

    pub fn ensure_worker(&self, account_id: String, app: AppHandle) -> Result<(), String> {
        let mut workers = self
            .workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !workers.insert(account_id.clone()) {
            return Ok(());
        }
        drop(workers);
        // run_account_worker retires the registration itself on every exit,
        // including a panic mid-await; see WorkerCleanup.
        tauri::async_runtime::spawn(async move {
            run_account_worker(&account_id, &app).await;
        });
        Ok(())
    }

    /// Keep macOS from napping the app while mail work runs.
    pub(crate) fn hold_activity(&self) -> crate::app_nap::ActivityHold<'_> {
        self.app_nap.hold()
    }

    fn retire_actor(&self, account_id: &str) {
        // Poison-tolerant so the retirement still happens, and no stale actor
        // becomes reachable again, after a panic while the lock was held.
        let retired = self
            .account_actors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(account_id);
        mail::pool::forget(account_id);
        let mut folders = self
            .visible_folders
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        folders.remove(account_id);
        // Wake a parked or idle worker so it notices the removal and exits.
        if let Some(actor) = retired {
            actor.watch().signal_restart();
            actor.request(wake::SYNC);
        }
    }
}

/// The marker sits beside the mail database, one level above attachments.
pub(crate) fn compact_marker_for(attachment_dir: &Path) -> PathBuf {
    attachment_dir
        .parent()
        .unwrap_or(attachment_dir)
        .join("compact-pending")
}

/// Sits beside the compaction marker, one level above attachments.
pub(crate) fn orphan_marker_for(attachment_dir: &Path) -> PathBuf {
    attachment_dir
        .parent()
        .unwrap_or(attachment_dir)
        .join("orphan-attachments-pending")
}

pub(crate) fn reconnect_delay(account_id: &str, seconds: u64, attempt: u32) -> Duration {
    let clock = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() << 20 ^ u64::from(elapsed.subsec_nanos()))
        .unwrap_or(0);
    let account_hash = account_id
        .bytes()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    let jitter =
        (clock ^ account_hash ^ u64::from(attempt).wrapping_mul(0x9e3779b97f4a7c15)) % 1_000;
    Duration::from_secs(seconds) + Duration::from_millis(jitter)
}

/// How long IDLE waits before a cheap all-folder STATUS pass. Other folders
/// change without IDLE notifications, so this bounds their staleness.
const IDLE_REFRESH: Duration = Duration::from_secs(5 * 60);

/// Quiet period before locally saved drafts are pushed to the server.
const DRAFT_PUSH_DELAY: Duration = Duration::from_secs(60);

/// Only the user (new password, Get Mail) ends a rejected-password pause;
/// waking from sleep must not retry the sign-in.
fn leaves_auth_pause(reasons: u16) -> bool {
    reasons & (wake::CREDENTIALS | wake::SYNC | wake::RESUME) != 0
}

/// Retires a worker task on every exit, including a panic mid-await. The
/// ensure_worker registration must not outlive the task or the account stays
/// registered forever (every later ensure_worker call short-circuits), and
/// the spawned INBOX watcher must not keep IDLE-ing with no worker to serve.
struct WorkerCleanup<'a, R: tauri::Runtime = tauri::Wry> {
    app: &'a tauri::AppHandle<R>,
    account_id: String,
    watcher: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl<'a, R: tauri::Runtime> WorkerCleanup<'a, R> {
    fn for_account(app: &'a tauri::AppHandle<R>, account_id: &str) -> Self {
        Self {
            app,
            account_id: account_id.to_string(),
            watcher: None,
        }
    }

    fn watch(&mut self, watcher: tauri::async_runtime::JoinHandle<()>) {
        self.watcher = Some(watcher);
    }
}

impl<R: tauri::Runtime> Drop for WorkerCleanup<'_, R> {
    fn drop(&mut self) {
        // Abort before retiring: on either a clean exit or a panic unwind, no
        // watcher may keep watching an account nobody is serving. The lock is
        // poison-tolerant so cleanup itself never fails while unwinding.
        if let Some(watcher) = self.watcher.take() {
            watcher.abort();
        }
        self.app
            .state::<AppState>()
            .workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.account_id);
    }
}

/// Long-lived loop for one account: sync passes, targeted jobs, IDLE, and
/// the outbox timer. Exits when the account is removed.
async fn run_account_worker(account_id: &str, app: &AppHandle) {
    // Created first so the `else return` below still retires the
    // registration; the watcher handle is registered right after the spawn.
    let mut cleanup = WorkerCleanup::for_account(app, account_id);
    let mut backoff = 2u64;
    let mut attempt = 0u32;
    let mut first_pass = true;
    let mut parked = false;
    let mut pending_full = true;
    let mut more_work = false;
    let Ok(initial) = app.state::<AppState>().actor(account_id) else {
        return;
    };
    // The watcher only wakes this worker; it never touches the database.
    cleanup.watch(tauri::async_runtime::spawn(mail::watch::run_with_secret(
        account_id.to_string(),
        app.state::<AppState>().db.clone(),
        initial,
        mail::watch::SecretSource::Vault,
    )));
    loop {
        let state = app.state::<AppState>();
        let Ok(actor) = state.actor(account_id) else {
            break;
        };
        let reasons = actor.take_reasons();
        if parked {
            if !leaves_auth_pause(reasons) {
                actor.wake.notified().await;
                continue;
            }
            parked = false;
        }
        if reasons & (wake::SYNC | wake::POLICY | wake::CREDENTIALS | wake::SLEEP) != 0 {
            pending_full = true;
        }
        if reasons & wake::FOLDER != 0 {
            state.mark_visible_folder_polled(account_id);
        }
        let scope = if pending_full || more_work {
            Some(mail::sync::SyncScope::All)
        } else {
            let visible = (reasons & wake::FOLDER != 0)
                .then(|| state.visible_folder_name(account_id))
                .flatten();
            sync::scope_for_wake(reasons, visible.as_deref())
        };
        let guard = actor.acquire_for_worker().await;
        let work = state.hold_activity();
        if reasons & wake::OUTBOX != 0 && (pending_full || more_work) {
            // Send Later items that came due (for example during sleep) go
            // out before a long pass.
            sync::run_targeted_jobs(account_id, app, &state, wake::OUTBOX).await;
        }
        if let Some(scope) = scope {
            // Only a full pass is the complete Get Mail; a scoped pass stays
            // quick and leaves backfill to the next full pass.
            let quick = scope != mail::sync::SyncScope::All;
            let previous_message_id = state.db.inbox_high_water(account_id).ok().flatten();
            match sync::run_sync_pass(account_id, app, &state, &actor, guard, quick, scope).await {
                Ok(outcome) => {
                    backoff = 2;
                    attempt = 0;
                    pending_full = false;
                    more_work = outcome.more_work;
                    if !first_pass {
                        notify_new_mail(app, &state.db, account_id, previous_message_id);
                    }
                    first_pass = false;
                }
                Err(sync::PassError::AuthenticationFailed(_)) => {
                    parked = true;
                    more_work = false;
                    continue;
                }
                Err(sync::PassError::Other(_)) => {
                    more_work = false;
                    tokio::select! {
                        _ = tokio::time::sleep(reconnect_delay(account_id, backoff, attempt)) => {},
                        _ = wait_for(&actor, wake::SYNC | wake::CREDENTIALS | wake::SLEEP) => {},
                    }
                    backoff = (backoff * 2).min(120);
                    attempt = attempt.wrapping_add(1);
                    continue;
                }
            }
            if more_work {
                // Keep downloading history, but let queued user actions and
                // other accounts run between passes.
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            continue;
        }
        if reasons & (wake::DRAFTS | wake::OUTBOX | wake::REPLAY) != 0 {
            sync::run_targeted_jobs(account_id, app, &state, reasons).await;
        }
        let Ok(account) = state.db.account(account_id) else {
            break;
        };
        let password = match oauth::session_secret(&account).await {
            Ok(password) => password,
            Err(error) => {
                drop(guard);
                let detail = if account.summary.auth_method == "oauth" {
                    error
                } else {
                    "The saved password is unavailable. Update the password in Settings > Accounts."
                        .into()
                };
                // A locked vault can unlock later (for example after sign-in on
                // macOS), so retry with backoff instead of parking.
                let _ = state
                    .db
                    .set_account_state(account_id, "offline", Some(&detail));
                emit_sync(app, account_id, "offline", Some(&detail), None);
                tokio::select! {
                    _ = tokio::time::sleep(reconnect_delay(account_id, backoff, attempt)) => {},
                    _ = wait_for(&actor, wake::SYNC | wake::CREDENTIALS | wake::SLEEP) => {},
                }
                backoff = (backoff * 2).min(120);
                attempt = attempt.wrapping_add(1);
                continue;
            }
        };
        let next_send = state
            .db
            .next_scheduled_send_at(account_id)
            .ok()
            .flatten()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|when| {
                (when.with_timezone(&chrono::Utc) - chrono::Utc::now())
                    .to_std()
                    .unwrap_or(Duration::ZERO)
            });
        // Autosave does not wake the worker; push pending drafts after a
        // short quiet period instead of on every keystroke-driven save.
        let drafts_pending = state
            .db
            .pending_draft_sync(account_id)
            .is_ok_and(|records| !records.is_empty());
        let deferred_due = state.db.next_deferred_due(account_id).ok().flatten();
        let folder_due = state.visible_folder_due(account_id);
        let next_job = [
            next_send,
            drafts_pending.then_some(DRAFT_PUSH_DELAY),
            deferred_due,
            folder_due,
        ]
        .into_iter()
        .flatten()
        .min();
        let limit = next_job.map_or(IDLE_REFRESH, |due| {
            due.max(Duration::from_millis(200)).min(IDLE_REFRESH)
        });
        let job_due_first = next_job.is_some_and(|due| due < IDLE_REFRESH);
        // Waiting on IDLE alone may nap; a due send or draft push keeps its
        // timer on time.
        if next_job.is_none() {
            drop(work);
        }
        let watching = actor.watch().active();
        let mut held = Some(guard);
        if actor.contended() {
            // A user action or a yielded pass is queued: IDLE would hold the
            // account from it until the next wake-up.
            held.take();
            continue;
        }
        let outcome = if watching {
            // The watcher owns INBOX IDLE, so wait without the account.
            held.take();
            tokio::select! {
                _ = actor.wake.notified() => Ok(mail::IdleOutcome::Interrupted),
                _ = tokio::time::sleep(limit) => Ok(mail::IdleOutcome::Timeout),
            }
        } else {
            mail::idle_inbox(&account, &password, &actor.wake, limit).await
        };
        match outcome {
            Ok(mail::IdleOutcome::Changed) => pending_full = true,
            Ok(mail::IdleOutcome::Timeout) if job_due_first => {
                let mut jobs = 0;
                if next_send.is_some_and(|due| due <= limit) {
                    jobs |= wake::OUTBOX;
                }
                if drafts_pending {
                    jobs |= wake::DRAFTS;
                }
                if deferred_due.is_some_and(|due| due <= limit) {
                    jobs |= wake::REPLAY;
                }
                if folder_due.is_some_and(|due| due <= limit) {
                    jobs |= wake::FOLDER;
                }
                actor.reasons.fetch_or(jobs, Ordering::SeqCst);
            }
            Ok(mail::IdleOutcome::Timeout) => pending_full = true,
            Ok(mail::IdleOutcome::Interrupted) => {}
            Err(_) => {
                held.take();
                let _ = state.db.set_account_state(
                    account_id,
                    "offline",
                    Some("Connection lost. Reconnecting…"),
                );
                emit_sync(
                    app,
                    account_id,
                    "offline",
                    Some("Connection lost. Reconnecting…"),
                    None,
                );
                tokio::select! {
                    _ = tokio::time::sleep(reconnect_delay(account_id, backoff, attempt)) => {},
                    _ = wait_for(&actor, wake::SYNC | wake::CREDENTIALS | wake::SLEEP) => {},
                }
                backoff = (backoff * 2).min(120);
                attempt = attempt.wrapping_add(1);
                pending_full = true;
            }
        }
    }
}

/// Resolve once a wake-up carrying one of `mask` arrives. Other reasons are
/// kept for the worker loop.
pub(crate) async fn wait_for(actor: &AccountActor, mask: u16) {
    loop {
        if actor.reasons.load(Ordering::SeqCst) & mask != 0 {
            return;
        }
        actor.wake.notified().await;
    }
}

fn emit_sync(
    app: &AppHandle,
    account_id: &str,
    phase: &str,
    detail: Option<&str>,
    last_success_at: Option<String>,
) {
    let _ = app.emit(
        "sync-state",
        SyncState {
            account_id: account_id.into(),
            phase: phase.into(),
            detail: detail.map(Into::into),
            last_success_at,
        },
    );
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderCountsChanged {
    account_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageChanged {
    account_id: String,
    message_id: Option<i64>,
    kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftSyncChanged {
    account_id: String,
    draft_id: Option<String>,
    sync_state: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboxChanged {
    account_id: String,
    outbox_id: Option<String>,
    state: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineOperationsDropped {
    account_id: String,
    count: u32,
}

fn emit_folder_counts(app: &AppHandle, account_id: &str) {
    let _ = app.emit(
        "folder-counts-changed",
        FolderCountsChanged {
            account_id: account_id.into(),
        },
    );
}

fn emit_message_change(app: &AppHandle, account_id: &str, message_id: Option<i64>, kind: &str) {
    let _ = app.emit(
        "message-changed",
        MessageChanged {
            account_id: account_id.into(),
            message_id,
            kind: kind.into(),
        },
    );
}

fn emit_draft_change(
    app: &AppHandle,
    account_id: &str,
    draft_id: Option<&str>,
    sync_state: Option<&str>,
) {
    let _ = app.emit(
        "draft-sync-changed",
        DraftSyncChanged {
            account_id: account_id.into(),
            draft_id: draft_id.map(Into::into),
            sync_state: sync_state.map(Into::into),
        },
    );
}

fn emit_outbox_change(
    app: &AppHandle,
    account_id: &str,
    outbox_id: Option<&str>,
    state: Option<&str>,
) {
    let _ = app.emit(
        "outbox-changed",
        OutboxChanged {
            account_id: account_id.into(),
            outbox_id: outbox_id.map(Into::into),
            state: state.map(Into::into),
        },
    );
}

enum ValidatedReplay {
    Drop,
    ClearPending(i64),
    Flags(FlagOperation),
    Keyword(replied::KeywordOperation),
    Move(MoveOperation),
    Copy(MoveOperation),
}

#[derive(Default)]
struct MoveReplayFlagDependencies {
    operation_ids: Vec<i64>,
    is_read: Option<bool>,
    is_starred: Option<bool>,
}

fn move_replay_flag_dependencies(
    operations: &[(i64, String, String)],
    movement: &MoveOperation,
) -> MoveReplayFlagDependencies {
    let mut dependencies = MoveReplayFlagDependencies::default();
    let Some(uid_validity) = movement.uid_validity else {
        return dependencies;
    };
    for (id, kind, payload) in operations {
        if kind != "flags" {
            continue;
        }
        let Ok(flag) = serde_json::from_str::<messages::FlagOperation>(payload) else {
            continue;
        };
        if flag.message_id != movement.message_id
            || flag.mailbox != movement.source
            || flag.uid != movement.uid
            || flag.uid_validity != Some(uid_validity)
        {
            continue;
        }
        dependencies.operation_ids.push(*id);
        if flag.is_read.is_some() {
            dependencies.is_read = flag.is_read;
        }
        if flag.is_starred.is_some() {
            dependencies.is_starred = flag.is_starred;
        }
    }
    dependencies
}

/// Validate a queued operation against current local ownership and mailbox
/// identity before any network call. Stale operations are removed; the
/// decisions are DB-level and covered by tests without a mail server.
fn validate_queued_operation(
    db: &Database,
    account_id: &str,
    kind: &str,
    payload: &str,
) -> Result<ValidatedReplay, String> {
    match kind {
        "flags" => {
            let Ok(operation) = serde_json::from_str::<FlagOperation>(payload) else {
                return Ok(ValidatedReplay::Drop);
            };
            let Ok((owner, mailbox, uid)) = db.message_location(operation.message_id) else {
                return Ok(ValidatedReplay::Drop);
            };
            if owner != account_id || mailbox != operation.mailbox || uid != operation.uid {
                return Ok(ValidatedReplay::Drop);
            }
            let Some(expected_uid_validity) = operation.uid_validity else {
                return Ok(ValidatedReplay::Drop);
            };
            if db.mailbox_uid_validity(account_id, &operation.mailbox)?
                != Some(expected_uid_validity)
            {
                return Ok(ValidatedReplay::Drop);
            }
            Ok(ValidatedReplay::Flags(operation))
        }
        "keyword" => {
            let Ok(operation) = serde_json::from_str::<replied::KeywordOperation>(payload) else {
                return Ok(ValidatedReplay::Drop);
            };
            let Ok((owner, mailbox, uid)) = db.message_location(operation.message_id) else {
                return Ok(ValidatedReplay::Drop);
            };
            if owner != account_id || mailbox != operation.mailbox || uid != operation.uid {
                return Ok(ValidatedReplay::Drop);
            }
            let Some(expected) = operation.uid_validity else {
                return Ok(ValidatedReplay::Drop);
            };
            if db.mailbox_uid_validity(account_id, &operation.mailbox)? != Some(expected) {
                return Ok(ValidatedReplay::Drop);
            }
            Ok(ValidatedReplay::Keyword(operation))
        }
        "move" => {
            let Ok(operation) = serde_json::from_str::<MoveOperation>(payload) else {
                return Ok(ValidatedReplay::Drop);
            };
            let Ok((owner, source, uid)) = db.message_location(operation.message_id) else {
                return Ok(ValidatedReplay::Drop);
            };
            if owner != account_id || source != operation.source || uid != operation.uid {
                return Ok(ValidatedReplay::Drop);
            }
            if operation.source == operation.destination {
                return Ok(ValidatedReplay::ClearPending(operation.message_id));
            }
            let Some(expected_uid_validity) = operation.uid_validity else {
                return Ok(ValidatedReplay::ClearPending(operation.message_id));
            };
            if db.mailbox_uid_validity(account_id, &operation.source)?
                != Some(expected_uid_validity)
            {
                return Ok(ValidatedReplay::ClearPending(operation.message_id));
            }
            Ok(ValidatedReplay::Move(operation))
        }
        "copy" => {
            let Ok(operation) = serde_json::from_str::<MoveOperation>(payload) else {
                return Ok(ValidatedReplay::Drop);
            };
            let Ok((owner, source, uid)) = db.message_location(operation.message_id) else {
                return Ok(ValidatedReplay::Drop);
            };
            if owner != account_id
                || source != operation.source
                || uid != operation.uid
                || operation.source == operation.destination
            {
                return Ok(ValidatedReplay::Drop);
            }
            let Some(expected_uid_validity) = operation.uid_validity else {
                return Ok(ValidatedReplay::Drop);
            };
            if db.mailbox_uid_validity(account_id, &operation.source)?
                != Some(expected_uid_validity)
            {
                return Ok(ValidatedReplay::Drop);
            }
            Ok(ValidatedReplay::Copy(operation))
        }
        _ => Ok(ValidatedReplay::Drop),
    }
}

/// Largest UID set sent in one replay command.
const MAX_REPLAY_BATCH_UIDS: usize = 100;

/// What batch planning needs to know about one queued op.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ReplayPlanKind {
    Flags {
        mailbox: String,
        uid_validity: Option<u32>,
        is_read: Option<bool>,
        is_starred: Option<bool>,
    },
    Move {
        source: String,
        destination: String,
        uid_validity: Option<u32>,
        attempts: i64,
        /// A queued flag change for the same message replays first.
        has_flag_dependencies: bool,
    },
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReplayCandidate {
    id: i64,
    message_id: i64,
    kind: ReplayPlanKind,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ReplayBatchCaps {
    move_supported: bool,
}

/// Builds planner input from queued payloads. Unreadable payloads become
/// `Other` and keep the per-op path.
fn replay_candidates(operations: &[(i64, String, String, i64)]) -> Vec<ReplayCandidate> {
    let flagged_messages: HashSet<i64> = operations
        .iter()
        .filter(|(_, kind, _, _)| kind == "flags")
        .filter_map(|(_, _, payload, _)| serde_json::from_str::<FlagOperation>(payload).ok())
        .map(|operation| operation.message_id)
        .collect();
    operations
        .iter()
        .map(|(id, kind, payload, attempts)| {
            let (message_id, plan) = match kind.as_str() {
                "flags" => match serde_json::from_str::<FlagOperation>(payload) {
                    Ok(operation) => (
                        operation.message_id,
                        ReplayPlanKind::Flags {
                            mailbox: operation.mailbox,
                            uid_validity: operation.uid_validity,
                            is_read: operation.is_read,
                            is_starred: operation.is_starred,
                        },
                    ),
                    Err(_) => (0, ReplayPlanKind::Other),
                },
                "move" => match serde_json::from_str::<MoveOperation>(payload) {
                    Ok(operation) => (
                        operation.message_id,
                        ReplayPlanKind::Move {
                            has_flag_dependencies: flagged_messages.contains(&operation.message_id),
                            source: operation.source,
                            destination: operation.destination,
                            uid_validity: operation.uid_validity,
                            attempts: *attempts,
                        },
                    ),
                    Err(_) => (0, ReplayPlanKind::Other),
                },
                _ => (0, ReplayPlanKind::Other),
            };
            ReplayCandidate {
                id: *id,
                message_id,
                kind: plan,
            }
        })
        .collect()
}

/// Whether an op may share an IMAP command. Retried moves and moves that
/// would only clear a pending mark stay on the per-op path.
fn replay_batchable(candidate: &ReplayCandidate, caps: ReplayBatchCaps) -> bool {
    match &candidate.kind {
        ReplayPlanKind::Flags { uid_validity, .. } => uid_validity.is_some(),
        ReplayPlanKind::Move {
            source,
            destination,
            uid_validity,
            attempts,
            has_flag_dependencies,
        } => {
            caps.move_supported
                && uid_validity.is_some()
                && source != destination
                && *attempts == 0
                && !has_flag_dependencies
        }
        ReplayPlanKind::Other => false,
    }
}

/// Groups queued ops into contiguous runs that share one IMAP command. Every
/// index appears once, in queue order; a group of one keeps the per-op path.
fn plan_replay_batches(candidates: &[ReplayCandidate], caps: ReplayBatchCaps) -> Vec<Vec<usize>> {
    let mut plan: Vec<Vec<usize>> = Vec::new();
    let mut run: Vec<usize> = Vec::new();
    let mut run_messages: HashSet<i64> = HashSet::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let batchable = replay_batchable(candidate, caps);
        let joins = batchable
            && run
                .first()
                .is_some_and(|&first| candidates[first].kind == candidate.kind)
            && !run_messages.contains(&candidate.message_id)
            && run.len() < MAX_REPLAY_BATCH_UIDS;
        if !joins && !run.is_empty() {
            plan.push(std::mem::take(&mut run));
            run_messages.clear();
        }
        if batchable {
            run.push(index);
            run_messages.insert(candidate.message_id);
        } else {
            plan.push(vec![index]);
        }
    }
    if !run.is_empty() {
        plan.push(run);
    }
    plan
}

/// Flag outcomes shared by the batched and per-op replay paths.
#[derive(Default)]
struct ReplayFlagState {
    /// Flag ops already applied as a move's dependency.
    handled: HashSet<i64>,
    failed_messages: HashSet<i64>,
    terminal_messages: HashSet<i64>,
}

/// Replays one planned group in one IMAP command. Returns `false` with no
/// state changed when the group must fall back to per-op replay.
async fn replay_planned_batch(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
    group: &[(i64, String, String)],
    flag_state: &mut ReplayFlagState,
) -> Result<bool, String> {
    match group.first().map(|(_, kind, _)| kind.as_str()) {
        Some("flags") => replay_flag_batch(db, account, password, group, flag_state).await,
        Some("move") => replay_move_batch(db, account, password, policy, group, flag_state).await,
        _ => Ok(false),
    }
}

async fn replay_flag_batch(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    group: &[(i64, String, String)],
    flag_state: &mut ReplayFlagState,
) -> Result<bool, String> {
    let account_id = &account.summary.id;
    let mut operations = Vec::with_capacity(group.len());
    for (id, kind, payload) in group {
        if flag_state.handled.contains(id) {
            return Ok(false);
        }
        let ValidatedReplay::Flags(operation) =
            validate_queued_operation(db, account_id, kind, payload)?
        else {
            return Ok(false);
        };
        operations.push((*id, operation));
    }
    let Some((_, first)) = operations.first() else {
        return Ok(false);
    };
    let mailbox = first.mailbox.clone();
    let (is_read, is_starred) = (first.is_read, first.is_starred);
    let Some(uid_validity) = first.uid_validity else {
        return Ok(false);
    };
    // One STORE applies one value, so a mixed group must not share it.
    if operations.iter().any(|(_, operation)| {
        operation.mailbox != mailbox
            || operation.uid_validity != Some(uid_validity)
            || operation.is_read != is_read
            || operation.is_starred != is_starred
    }) {
        return Ok(false);
    }
    let uids: Vec<u32> = operations
        .iter()
        .map(|(_, operation)| operation.uid)
        .collect();
    if mail::set_remote_uid_flags(
        account,
        password,
        &mailbox,
        &uids,
        Some(uid_validity),
        is_read,
        is_starred,
    )
    .await
    .is_err()
    {
        return Ok(false);
    }
    for (id, operation) in &operations {
        db.set_flags(
            operation.message_id,
            operation.is_read,
            operation.is_starred,
        )?;
        flag_state.failed_messages.remove(&operation.message_id);
        db.remove_operation(account_id, *id)?;
    }
    Ok(true)
}

async fn replay_move_batch(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
    group: &[(i64, String, String)],
    flag_state: &mut ReplayFlagState,
) -> Result<bool, String> {
    let account_id = &account.summary.id;
    let queued = db.queued_operations(account_id)?;
    let mut operations = Vec::with_capacity(group.len());
    for (id, kind, payload) in group {
        let ValidatedReplay::Move(operation) =
            validate_queued_operation(db, account_id, kind, payload)?
        else {
            return Ok(false);
        };
        if flag_state.failed_messages.contains(&operation.message_id)
            || flag_state.terminal_messages.contains(&operation.message_id)
            || !move_replay_flag_dependencies(&queued, &operation)
                .operation_ids
                .is_empty()
        {
            return Ok(false);
        }
        operations.push((*id, operation));
    }
    let Some((_, first)) = operations.first() else {
        return Ok(false);
    };
    let source = first.source.clone();
    let destination = first.destination.clone();
    let Some(uid_validity) = first.uid_validity else {
        return Ok(false);
    };
    if operations.iter().any(|(_, operation)| {
        operation.source != source
            || operation.destination != destination
            || operation.uid_validity != Some(uid_validity)
    }) {
        return Ok(false);
    }
    let uids: Vec<u32> = operations
        .iter()
        .map(|(_, operation)| operation.uid)
        .collect();
    if mail::move_remote_uids(
        account,
        password,
        &source,
        &destination,
        &uids,
        Some(uid_validity),
    )
    .await
    .is_err()
    {
        return Ok(false);
    }
    let row_ids: Vec<i64> = operations
        .iter()
        .map(|(_, operation)| operation.message_id)
        .collect();
    // Only a database failure lands here; the per-op path dedupes and retries it.
    if db
        .remove_moved_messages(account_id, &row_ids, &destination)
        .is_err()
    {
        return Ok(false);
    }
    for (id, _) in &operations {
        db.remove_operation(account_id, *id)?;
    }
    let _ = mail::refresh_mailbox_envelopes(account, password, &destination, db, policy).await;
    land_pending_snoozes(db, account_id, &destination);
    Ok(true)
}

/// Land snoozes waiting on a destination the refresh just synced. Best effort:
/// the transfer rows are durable, so a later sync lands whatever this misses.
fn land_pending_snoozes(db: &Database, account_id: &str, destination: &str) {
    if let Ok(Some(mailbox_id)) = db.mailbox_id_for_name(account_id, destination) {
        let _ = db.apply_pending_snooze_transfers(account_id, mailbox_id);
    }
}

async fn replay_offline_operations(
    app: &AppHandle,
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
) -> Result<bool, String> {
    replay_offline_operations_with_notification(db, account, password, policy, |event, payload| {
        let _ = app.emit(event, payload);
    })
    .await
}

async fn replay_offline_operations_with_notification(
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
    mut notify: impl FnMut(&'static str, OfflineOperationsDropped) + Send,
) -> Result<bool, String> {
    let account_id = &account.summary.id;
    let mut dropped = 0u32;
    let queued = db.queued_operations_with_attempts(account_id)?;
    let operations: Vec<(i64, String, String)> = queued
        .iter()
        .map(|(id, kind, payload, _)| (*id, kind.clone(), payload.clone()))
        .collect();
    let caps = ReplayBatchCaps {
        move_supported: operations.iter().any(|(_, kind, _)| kind == "move")
            && mail::folders::server_supports_move(account, password)
                .await
                .unwrap_or(false),
    };
    let mut batch_starts: HashMap<usize, Vec<usize>> =
        plan_replay_batches(&replay_candidates(&queued), caps)
            .into_iter()
            .filter(|group| group.len() > 1)
            .map(|group| (group[0], group))
            .collect();
    let mut batched: HashSet<usize> = HashSet::new();
    let mut flag_state = ReplayFlagState::default();
    for (index, (id, kind, payload)) in operations.clone().into_iter().enumerate() {
        if batched.contains(&index) {
            continue;
        }
        if let Some(members) = batch_starts.remove(&index) {
            let group: Vec<_> = members
                .iter()
                .map(|&member| operations[member].clone())
                .collect();
            if replay_planned_batch(db, account, password, policy, &group, &mut flag_state).await? {
                batched.extend(members);
                continue;
            }
        }
        if kind == "flags" && flag_state.handled.contains(&id) {
            continue;
        }
        match validate_queued_operation(db, account_id, &kind, &payload)? {
            ValidatedReplay::Drop => {
                db.remove_operation(account_id, id)?;
                dropped = dropped.saturating_add(1);
                continue;
            }
            ValidatedReplay::ClearPending(message_id) => {
                let _ = db.clear_pending_move(message_id);
                db.remove_operation(account_id, id)?;
                dropped = dropped.saturating_add(1);
                continue;
            }
            ValidatedReplay::Flags(operation) => {
                let result = mail::set_remote_flags(
                    account,
                    password,
                    &operation.mailbox,
                    operation.uid,
                    operation.uid_validity,
                    operation.is_read,
                    operation.is_starred,
                )
                .await;
                if let Err(error) = &result {
                    if error.terminal {
                        db.remove_operation(account_id, id)?;
                        dropped = dropped.saturating_add(1);
                        flag_state.failed_messages.insert(operation.message_id);
                        flag_state.terminal_messages.insert(operation.message_id);
                        continue;
                    }
                    flag_state.failed_messages.insert(operation.message_id);
                }
                // Initial sync restored server flags. Keep queued intent only
                // while replay can still succeed.
                db.set_flags(
                    operation.message_id,
                    operation.is_read,
                    operation.is_starred,
                )?;
                if result.is_err() {
                    let _ = db.record_operation_attempt(account_id, id);
                    continue;
                }
                flag_state.failed_messages.remove(&operation.message_id);
            }
            ValidatedReplay::Keyword(operation) => {
                let result = mail::set_remote_keyword(
                    account,
                    password,
                    &operation.mailbox,
                    operation.uid,
                    operation.uid_validity,
                    operation.keyword,
                )
                .await;
                if let Err(error) = &result {
                    if error.terminal {
                        db.remove_operation(account_id, id)?;
                        dropped = dropped.saturating_add(1);
                    } else {
                        let _ = db.record_operation_attempt(account_id, id);
                    }
                    continue;
                }
            }
            ValidatedReplay::Move(operation) => {
                if flag_state.terminal_messages.contains(&operation.message_id) {
                    let _ = db.clear_pending_move(operation.message_id);
                    db.remove_operation(account_id, id)?;
                    dropped = dropped.saturating_add(1);
                    continue;
                }
                let dependencies =
                    move_replay_flag_dependencies(&db.queued_operations(account_id)?, &operation);
                let replay_flags =
                    (!dependencies.operation_ids.is_empty()).then_some(mail::MoveReplayFlags {
                        is_read: dependencies.is_read,
                        is_starred: dependencies.is_starred,
                    });
                if !dependencies.operation_ids.is_empty() {
                    let flag_result = mail::set_remote_flags(
                        account,
                        password,
                        &operation.source,
                        operation.uid,
                        operation.uid_validity,
                        dependencies.is_read,
                        dependencies.is_starred,
                    )
                    .await;
                    match flag_result {
                        Ok(()) => {
                            db.set_flags(
                                operation.message_id,
                                dependencies.is_read,
                                dependencies.is_starred,
                            )?;
                            for flag_id in &dependencies.operation_ids {
                                flag_state.handled.insert(*flag_id);
                            }
                            flag_state.failed_messages.remove(&operation.message_id);
                        }
                        Err(error) if error.terminal => {
                            for flag_id in dependencies.operation_ids {
                                db.remove_operation(account_id, flag_id)?;
                                flag_state.handled.insert(flag_id);
                                dropped = dropped.saturating_add(1);
                            }
                            let _ = db.clear_pending_move(operation.message_id);
                            db.remove_operation(account_id, id)?;
                            dropped = dropped.saturating_add(1);
                            continue;
                        }
                        Err(_) => {
                            flag_state.failed_messages.insert(operation.message_id);
                            for flag_id in &dependencies.operation_ids {
                                flag_state.handled.insert(*flag_id);
                            }
                            let _ = db.record_operation_attempt(account_id, id);
                            continue;
                        }
                    }
                }
                if flag_state.failed_messages.contains(&operation.message_id) {
                    continue;
                }
                let remote_message_id = db.message_rfc_id(operation.message_id).ok().flatten();
                let result = mail::move_remote(
                    account,
                    password,
                    &operation.source,
                    &operation.destination,
                    operation.uid,
                    operation.uid_validity,
                    mail::MoveOptions {
                        message_id: remote_message_id.as_deref(),
                        dedupe_existing: true,
                        replay_flags,
                    },
                )
                .await;
                match result {
                    Ok(()) => {
                        for flag_id in dependencies.operation_ids {
                            db.remove_operation(account_id, flag_id)?;
                            flag_state.handled.insert(flag_id);
                        }
                        // Durable transfer: the snooze survives the row-id
                        // change and lands once the destination caches the copy.
                        // Source row and transfer commit together; a database
                        // failure retries the dedupe-safe move on the next replay.
                        if db
                            .remove_moved_messages(
                                account_id,
                                &[operation.message_id],
                                &operation.destination,
                            )
                            .is_err()
                        {
                            let _ = db.record_operation_attempt(account_id, id);
                            continue;
                        }
                        let _ = mail::refresh_mailbox_envelopes(
                            account,
                            password,
                            &operation.destination,
                            db,
                            policy,
                        )
                        .await;
                        land_pending_snoozes(db, account_id, &operation.destination);
                    }
                    Err(error) => {
                        if error.terminal {
                            for flag_id in dependencies.operation_ids {
                                db.remove_operation(account_id, flag_id)?;
                                flag_state.handled.insert(flag_id);
                            }
                            let _ = db.clear_pending_move(operation.message_id);
                            db.remove_operation(account_id, id)?;
                            dropped = dropped.saturating_add(1);
                        } else {
                            for flag_id in &dependencies.operation_ids {
                                flag_state.handled.insert(*flag_id);
                            }
                        }
                        // Transient failure: keep the queued op and the
                        // pending-move hiding so a later sync retries it.
                        let _ = db.record_operation_attempt(account_id, id);
                        continue;
                    }
                }
            }
            ValidatedReplay::Copy(operation) => {
                let remote_message_id = db.message_rfc_id(operation.message_id).ok().flatten();
                let result = mail::copy_remote(
                    account,
                    password,
                    &operation.source,
                    &operation.destination,
                    operation.uid,
                    operation.uid_validity,
                    mail::CopyOptions {
                        message_id: remote_message_id.as_deref(),
                        dedupe_existing: true,
                    },
                )
                .await;
                if let Err(error) = result {
                    if error.terminal {
                        db.remove_operation(account_id, id)?;
                        dropped = dropped.saturating_add(1);
                    } else {
                        let _ = db.record_operation_attempt(account_id, id);
                    }
                    continue;
                }
                let _ = mail::refresh_mailbox_envelopes(
                    account,
                    password,
                    &operation.destination,
                    db,
                    policy,
                )
                .await;
            }
        }
        db.remove_operation(account_id, id)?;
    }
    if dropped > 0 {
        notify(
            "offline-operations-dropped",
            OfflineOperationsDropped {
                account_id: account_id.clone(),
                count: dropped,
            },
        );
    }
    Ok(!db.queued_operations(account_id)?.is_empty())
}

fn resolve_draft_files(db: &Database, draft: &ComposeDraft) -> Result<ComposeDraft, String> {
    let mut resolved = draft.clone();
    for attachment in &mut resolved.attachments {
        let path = db.resolve_file(&attachment.token, &draft.account_id)?;
        attachment.token = path.to_string_lossy().to_string();
    }
    Ok(resolved)
}

fn managed_account_dir(root: &Path, account_id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(account_id)
        .map_err(|_| "The account attachment store is invalid.".to_string())?;
    Ok(root.join(id.hyphenated().to_string()))
}

/// Removes account folders that no active account owns. Returns how many
/// orphaned folders are still present, so callers can report leftovers.
pub(crate) async fn cleanup_orphaned_account_dirs(root: PathBuf, database: &Database) -> usize {
    sweep_orphaned_account_dirs(root, Vec::new(), |path| {
        let database = database.clone();
        async move {
            tokio::task::spawn_blocking(move || database.remove_unowned_account_dir(&path))
                .await
                .map_err(std::io::Error::other)?
                .map_err(std::io::Error::other)
        }
    })
    .await
}

/// `cleanup_orphaned_account_dirs` with the removal operation injected for tests.
async fn sweep_orphaned_account_dirs<F, Fut>(
    root: PathBuf,
    active_account_ids: Vec<String>,
    remove: F,
) -> usize
where
    F: Fn(PathBuf) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<()>>,
{
    let active_account_ids = active_account_ids.into_iter().collect::<HashSet<_>>();
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        // A root that was never created holds nothing to remove.
        Err(error) => return usize::from(error.kind() != std::io::ErrorKind::NotFound),
    };
    let mut remaining = 0;
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            // Unlisted entries may still hold orphans.
            Err(_) => return remaining + 1,
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Ok(id) = uuid::Uuid::parse_str(name) else {
            continue;
        };
        if id.hyphenated().to_string() != name || active_account_ids.contains(name) {
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                remaining += 1;
                continue;
            }
        };
        let removable = file_type.is_dir() && !file_type.is_symlink();
        if removable && remove(entry.path()).await.is_err() {
            remaining += 1;
        }
    }
    remaining
}

/// Startup sweep: best effort and non-blocking, with its result kept in a marker.
pub(crate) async fn sweep_orphans_at_startup(root: PathBuf, database: Database, marker: PathBuf) {
    let remaining = cleanup_orphaned_account_dirs(root, &database).await;
    record_orphan_marker(&marker, remaining);
}

/// Keeps the marker in step with the last sweep. It survives restarts, so a
/// failed removal is never silently forgotten.
pub(crate) fn record_orphan_marker(marker: &Path, remaining: usize) {
    if remaining == 0 {
        let _ = std::fs::remove_file(marker);
    } else {
        let _ = std::fs::write(marker, b"");
    }
}

/// Makes `dir` unwritable so entries cannot be unlinked. `None` when the
/// permission change is not enforced, such as when running as root.
#[cfg(all(test, unix))]
pub(crate) fn make_unwritable(dir: &Path) -> Option<UnwritableDir> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o500)).ok()?;
    let probe = dir.join("probe");
    if std::fs::File::create(&probe).is_ok() {
        let _ = std::fs::remove_file(&probe);
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        return None;
    }
    Some(UnwritableDir(dir.to_path_buf()))
}

/// Restores a directory's write permission when dropped.
#[cfg(all(test, unix))]
pub(crate) struct UnwritableDir(PathBuf);

#[cfg(all(test, unix))]
impl Drop for UnwritableDir {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
    }
}

async fn write_managed_file(
    state: &AppState,
    account_id: &str,
    account_dir: &Path,
    bytes: &[u8],
) -> Result<String, String> {
    let token = uuid::Uuid::new_v4().to_string();
    let path = account_dir.join(&token);
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|_| "Could not copy that attachment into private storage.".to_string())?;
    #[cfg(unix)]
    if tokio::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .await
        .is_err()
    {
        let _ = tokio::fs::remove_file(&path).await;
        return Err("Could not secure that attachment.".into());
    }
    if let Err(error) = state
        .db
        .grant_file(&token, account_id, &path, bytes.len() as u64)
    {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(token)
}

async fn cleanup_unreferenced_attachments(state: &AppState, account_id: &str) {
    let Ok(files) = state.db.expired_unreferenced_files(account_id) else {
        return;
    };
    for (token, path) in files {
        if tokio::fs::remove_file(&path).await.is_ok()
            || matches!(tokio::fs::try_exists(&path).await, Ok(false))
        {
            let _ = state.db.remove_file_grant(&token, account_id);
        }
    }
}

async fn release_attachment_tokens<'a>(
    state: &AppState,
    account_id: &str,
    tokens: impl IntoIterator<Item = &'a str>,
) {
    let allowed = tokens.into_iter().collect::<HashSet<_>>();
    let Ok(files) = state.db.unreferenced_files(account_id) else {
        return;
    };
    for (token, path) in files {
        if !allowed.contains(token.as_str()) {
            continue;
        }
        if tokio::fs::remove_file(&path).await.is_ok()
            || matches!(tokio::fs::try_exists(&path).await, Ok(false))
        {
            let _ = state.db.remove_file_grant(&token, account_id);
        }
    }
}

fn notify_new_mail(
    app: &AppHandle,
    db: &Database,
    account_id: &str,
    previous_message_id: Option<i64>,
) {
    // Sync stores rows with rising ids, so arrival order never depends on
    // the sender's Date header.
    let Ok(Some(message)) = db.newest_unread_inbox_after(account_id, previous_message_id) else {
        return;
    };
    let settings = app.state::<AppState>().settings.get().ok();
    if settings.as_ref().is_some_and(|settings| {
        !settings.notify_new_mail
            || crate::settings::quiet_hours_active(
                &settings.quiet_hours_start,
                &settings.quiet_hours_end,
                local_minutes_now(),
            )
    }) {
        return;
    }
    let private = settings
        .as_ref()
        .map(|settings| settings.private_notifications)
        .unwrap_or(true);
    // With several accounts, say which one received the mail. The account's
    // own display name is shown, never its address, even in private mode.
    let account_label = (db.account_count().unwrap_or(0) > 1)
        .then(|| db.account(account_id).ok())
        .flatten()
        .map(|account| account.summary.display_name)
        .filter(|name| !name.trim().is_empty());
    let (title, body) = if private {
        (
            account_label.as_deref().map_or_else(
                || crate::strings::notify::NEW_MAIL.to_string(),
                crate::strings::notify::new_mail_for,
            ),
            crate::strings::notify::OPEN_TO_READ.to_string(),
        )
    } else {
        let sender = if message.sender_name.is_empty() {
            message.sender_address.clone()
        } else {
            message.sender_name.clone()
        };
        (
            sender,
            match account_label {
                Some(name) => format!(
                    "{}
{name}",
                    message.subject
                ),
                None => message.subject.clone(),
            },
        )
    };
    let play_sound = settings
        .as_ref()
        .map(|settings| settings.new_mail_sound)
        .unwrap_or(true);
    let mut notice = app.notification().builder().title(title).body(body);
    if play_sound {
        notice = notice.sound(new_mail_sound_name());
    }
    let _ = notice.show();
}

fn local_minutes_now() -> u32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

/// System sound for a new-mail alert. Each desktop has its own name.
fn new_mail_sound_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "Mail"
    } else if cfg!(target_os = "macos") {
        "Ping"
    } else {
        "message-new-email"
    }
}

#[cfg(test)]
fn mail_alert_sound(play: bool) -> Option<&'static str> {
    play.then(new_mail_sound_name)
}

#[cfg(test)]
mod tests {
    // Get Mail stall failure modes:
    // - a Get Mail pass yields to the worker only because the worker waits
    //   for the lock, and the worker then IDLEs holding it (up to 300s);
    // - a user action queued behind the worker is not seen as contention.
    #[tokio::test]
    async fn worker_lock_wait_is_not_contention_but_user_waits_are() {
        use super::AccountActor;
        use std::sync::Arc;
        let actor = Arc::new(AccountActor::new());
        let pass = actor.acquire().await;
        let worker = tokio::spawn({
            let actor = actor.clone();
            async move {
                let _guard = actor.acquire_for_worker().await;
            }
        });
        tokio::task::yield_now().await;
        assert!(!actor.contended(), "a pass must not yield to the worker");
        let user = tokio::spawn({
            let actor = actor.clone();
            async move {
                let _guard = actor.acquire().await;
            }
        });
        tokio::task::yield_now().await;
        assert!(actor.contended(), "a queued user action must be seen");
        drop(pass);
        worker.await.unwrap();
        user.await.unwrap();
        assert!(!actor.contended());
    }

    #[test]
    fn replay_wake_bit_is_distinct_from_existing_reasons() {
        use super::wake;
        let existing = wake::OPERATION
            | wake::SYNC
            | wake::DRAFTS
            | wake::OUTBOX
            | wake::CREDENTIALS
            | wake::POLICY
            | wake::RESUME
            | wake::SLEEP;
        assert_eq!(wake::REPLAY, 256);
        assert_eq!(wake::REPLAY & existing, 0);
    }

    // Watch wake failure modes (G3, D4):
    // 1. Two new bits alias an existing reason, so a watcher wake runs a full pass.
    // 2. A SLEEP wake is consumed by the watcher check and never reaches the worker.
    // 3. An ordinary INBOX wake restarts the watcher's session.
    #[test]
    fn watch_wake_bits_are_distinct_from_existing_reasons() {
        use super::wake;
        let existing = wake::OPERATION
            | wake::SYNC
            | wake::DRAFTS
            | wake::OUTBOX
            | wake::CREDENTIALS
            | wake::POLICY
            | wake::RESUME
            | wake::SLEEP
            | wake::REPLAY;
        assert_eq!(wake::INBOX, 512);
        assert_eq!(wake::FOLDER, 1024);
        assert_eq!((wake::INBOX | wake::FOLDER) & existing, 0);
        assert_eq!(wake::INBOX & wake::FOLDER, 0);
    }

    #[test]
    fn sleep_wake_restarts_the_watcher_and_stays_for_the_worker() {
        use super::{wake, AccountActor};
        let actor = AccountActor::new();
        actor.request(wake::SLEEP | wake::OUTBOX);
        assert_eq!(actor.watch().epoch(), 1);
        assert_eq!(actor.take_reasons() & wake::SLEEP, wake::SLEEP);
        actor.request(wake::INBOX);
        assert_eq!(
            actor.watch().epoch(),
            1,
            "an INBOX wake must not restart the watcher"
        );
    }

    // A worker panic must not permanently disable the account. Failure modes,
    // written before the guard:
    // 1. The panicked task leaves its ensure_worker registration in place, so
    //    every later ensure_worker call short-circuits the account forever.
    // 2. The INBOX watcher the task spawned keeps running; nobody else holds
    //    its handle once the worker task is gone.
    // 3. Cleanup runs while the panic unwinds, so it must not panic itself.
    #[test]
    fn panicking_worker_retires_its_registration_and_aborts_its_watcher() {
        use super::{AppState, WorkerCleanup};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tauri::Manager;

        let watcher_aborted = Arc::new(AtomicBool::new(false));
        let (watcher_ready_tx, watcher_ready_rx) = tokio::sync::oneshot::channel::<()>();
        let app = tauri::test::mock_app();
        let directory = tempfile::tempdir().unwrap();
        let db = Database::memory();
        let settings =
            crate::settings::SettingsStore::load(directory.path().join("settings.json"), &db)
                .unwrap();
        let handle = app.app_handle().clone();
        handle.manage(AppState::new(db, settings, directory.path().to_path_buf()));

        let account_id = uuid::Uuid::new_v4().to_string();
        let state = handle.state::<AppState>();
        state.workers.lock().unwrap().insert(account_id.clone());

        let worker = tauri::async_runtime::spawn({
            let handle = handle.clone();
            let worker_account_id = account_id.clone();
            let aborted = watcher_aborted.clone();
            async move {
                // A real watcher parks on IDLE; this parked future records
                // cancellation in Drop, ending cleanly only from the guard.
                struct ParkedWatcher(Arc<AtomicBool>);
                impl Drop for ParkedWatcher {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::SeqCst);
                    }
                }
                let mut cleanup = WorkerCleanup::for_account(&handle, &worker_account_id);
                let ready = watcher_ready_tx;
                cleanup.watch(tauri::async_runtime::spawn(async move {
                    let _parked = ParkedWatcher(aborted);
                    let _ = ready.send(());
                    std::future::pending::<()>().await;
                }));
                // The watcher has polled and is parked, so the only way its
                // future can end is the guard's abort while the bug unwinds.
                watcher_ready_rx.await.unwrap();
                panic!("simulated bug in the worker loop");
            }
        });
        let panicked = matches!(
            tauri::async_runtime::block_on(worker),
            Err(tauri::Error::JoinError(error)) if error.is_panic()
        );
        assert!(panicked);
        // The watcher future is dropped by cancellation on a runtime worker;
        // wait briefly rather than asserting on the same instant.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !watcher_aborted.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "watcher was not aborted"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            !state.workers.lock().unwrap().contains(&account_id),
            "cleanup must run while the panic unwinds so ensure_worker can re-spawn"
        );
        // The registration is gone, so ensure_worker's insert succeeds again.
        assert!(state.workers.lock().unwrap().insert(account_id.clone()));
    }

    #[test]
    fn waking_from_sleep_keeps_a_rejected_password_paused() {
        use super::{leaves_auth_pause, wake};
        assert!(!leaves_auth_pause(wake::SLEEP | wake::OUTBOX));
        assert!(leaves_auth_pause(wake::SYNC));
        assert!(leaves_auth_pause(wake::CREDENTIALS));
        assert!(leaves_auth_pause(wake::RESUME));
    }

    #[cfg(unix)]
    use super::make_unwritable;
    use super::{
        attachments::preview_text, drafts_send::resolve_requested_send_at, mail_alert_sound,
        new_mail_sound_name, sync::apply_filter_rules,
    };
    use super::{
        cleanup_orphaned_account_dirs, record_orphan_marker, sweep_orphaned_account_dirs,
        take_normalized_account_password,
    };

    #[test]
    fn outbox_keeps_the_unsigned_draft_for_undo() {
        use super::drafts_send::sign_for_outbox;
        let draft = crate::models::ComposeDraft {
            body_format: crate::models::BodyFormat::Html,
            source_message_id: None,
            source_kind: None,
            include_signature: true,
            importance: String::new(),
            request_receipt: false,
            reply_to: None,
            id: None,
            account_id: "account-1".into(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hi".into(),
            html_body: "<p>Hello</p>".into(),
            text_body: "Hello".into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
        };
        let (stored, signed) = sign_for_outbox(draft, "Sam", true);
        assert_eq!(stored.text_body, "Hello");
        assert!(signed.text_body.ends_with("\n\n-- \nSam"));
        let mut skipped = stored.clone();
        skipped.include_signature = false;
        let (_, unsigned) = sign_for_outbox(skipped, "Sam", true);
        assert_eq!(unsigned.text_body, "Hello");
        // Undo returns `stored`; sending it again signs exactly once.
        let (mut restored, _) = sign_for_outbox(stored, "Sam", true);
        restored.text_body.push_str(" and more");
        let (_, resent) = sign_for_outbox(restored, "Sam", true);
        assert_eq!(resent.text_body.matches("-- \nSam").count(), 1);
    }

    #[test]
    fn forwarded_inline_images_stay_inline_only_when_referenced() {
        use super::attachments::forward_as_inline;
        let image = crate::models::Attachment {
            id: "a".into(),
            filename: "logo.png".into(),
            content_type: "image/png".into(),
            size: 10,
            content_id: Some("<logo@example.com>".into()),
            inline: true,
        };
        assert!(forward_as_inline(
            &image,
            Some("<p>Hi</p><img src=\"cid:logo@example.com\">")
        ));
        // Stored received HTML keeps the reference as data-inline-cid.
        assert!(forward_as_inline(
            &image,
            Some("<img data-inline-cid=\"logo@example.com\" alt=\"Logo\">")
        ));
        assert!(!forward_as_inline(&image, Some("<p>No picture</p>")));
        assert!(!forward_as_inline(&image, None));
        let file = crate::models::Attachment {
            inline: false,
            ..image.clone()
        };
        assert!(!forward_as_inline(
            &file,
            Some("<img src=\"cid:logo@example.com\">")
        ));
        let no_id = crate::models::Attachment {
            content_id: None,
            ..image
        };
        assert!(!forward_as_inline(&no_id, Some("<img src=\"cid:\">")));
    }

    #[test]
    fn mail_alert_sound_follows_setting() {
        assert_eq!(mail_alert_sound(false), None);
        assert_eq!(mail_alert_sound(true), Some(new_mail_sound_name()));
        assert!(!new_mail_sound_name().is_empty());
    }
    use super::replied;
    use crate::db::{CachedMessage, Database};
    use crate::mail;
    use crate::models::{
        AccountRecord, AccountSummary, FilterRule, MailboxRole, ProviderKind, ServerConfig, TlsMode,
    };

    fn rule_account() -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                default_body_format: crate::models::BodyFormat::Html,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
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
            imap: ServerConfig {
                trusted_certificate: None,
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
            },
        }
    }

    fn rule_mailbox(db: &Database, account_id: &str, name: &str, role: &MailboxRole) -> i64 {
        db.upsert_mailbox(account_id, name, role, Some(1), Some(2), Some(0), 0)
            .unwrap()
    }

    fn bill(db: &Database, account_id: &str, inbox: i64, uid: u32) -> i64 {
        let mut message = CachedMessage {
            uid,
            internal_at: None,
            message_id: Some(format!("<{uid}@bills.example.com>")),
            subject: "Power bill".into(),
            sender_name: "Power Co".into(),
            sender_address: "bills@power.example.com".into(),
            recipients: "sam@example.com".into(),
            received_at: "2026-08-18T12:00:00Z".into(),
            preview: "Pay by Friday".into(),
            is_read: false,
            is_starred: false,
            size: 32,
            to: vec!["sam@example.com".into()],
            cc: vec![],
            bcc: vec![],
            reply_to: None,
            thread_parent: None,
            text_body: "Pay by Friday".into(),
            html_body: None,
            attachments: vec![],
            raw_message: b"Subject: Power bill\r\n\r\nPay by Friday".to_vec(),
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
        message.sender_address = "bills@power.example.com".into();
        db.upsert_message(account_id, inbox, &message).unwrap();
        db.list_messages(inbox, None, 10).unwrap().items[0].id
    }

    fn enabled_rule(account_id: &str, action: &str) -> FilterRule {
        FilterRule {
            id: String::new(),
            account_id: account_id.into(),
            name: "Bills".into(),
            field: "from".into(),
            contains: "power.example.com".into(),
            action: action.into(),
            target_mailbox: None,
            enabled: true,
        }
    }

    // Rule window failure modes:
    // - mail cached by a pass that later fails is never filed
    // - a second failure moves the mark past the first failure's mail
    // - a success leaves the mark set, so mail a user moves into the Inbox
    //   between passes is filed again
    #[test]
    fn rules_file_mail_cached_by_a_failed_pass_on_the_next_success() {
        use super::sync::{begin_rule_window, finish_rule_window};
        let db = Database::memory();
        let account = rule_account();
        let account_id = account.summary.id.clone();
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, &account_id, "INBOX", &MailboxRole::Inbox);
        rule_mailbox(&db, &account_id, "Archive", &MailboxRole::Archive);
        db.create_filter_rule(&enabled_rule(&account_id, "move_archive"))
            .unwrap();
        let pending = |db: &Database| db.pending_move_uids(inbox).unwrap();

        let first = begin_rule_window(&db, &account_id);
        bill(&db, &account_id, inbox, 1);
        finish_rule_window(&db, &account, first, false);
        assert!(pending(&db).is_empty());

        let second = begin_rule_window(&db, &account_id);
        bill(&db, &account_id, inbox, 2);
        finish_rule_window(&db, &account, second, false);
        assert!(pending(&db).is_empty());

        let third = begin_rule_window(&db, &account_id);
        finish_rule_window(&db, &account, third, true);
        assert_eq!(pending(&db), vec![2, 1]);

        bill(&db, &account_id, inbox, 3);
        let fourth = begin_rule_window(&db, &account_id);
        finish_rule_window(&db, &account, fourth, true);
        assert_eq!(pending(&db), vec![2, 1]);
    }

    // A crash before finish must not skip cached mail on restart.
    #[test]
    fn rule_window_is_durable_before_mail_is_cached() {
        use super::sync::{begin_rule_window, finish_rule_window};
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        rule_mailbox(&db, account_id, "Archive", &MailboxRole::Archive);
        db.create_filter_rule(&enabled_rule(account_id, "move_archive"))
            .unwrap();
        let first = begin_rule_window(&db, account_id);
        assert_eq!(db.rules_pending_from(account_id).unwrap(), first);
        bill(&db, account_id, inbox, 1);
        let restarted = begin_rule_window(&db, account_id);
        assert_eq!(restarted, first);
        finish_rule_window(&db, &account, restarted, true);
        assert_eq!(db.pending_move_uids(inbox).unwrap(), vec![1]);
    }

    // A bounded rule batch must retain its watermark for the remaining rows.
    #[test]
    fn rule_window_survives_more_than_one_batch() {
        use super::sync::{begin_rule_window, finish_rule_window};
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        rule_mailbox(&db, account_id, "Archive", &MailboxRole::Archive);
        db.create_filter_rule(&enabled_rule(account_id, "move_archive"))
            .unwrap();
        let first = begin_rule_window(&db, account_id);
        for uid in 1..=101 {
            bill(&db, account_id, inbox, uid);
        }
        finish_rule_window(&db, &account, first, true);
        let second = begin_rule_window(&db, account_id);
        finish_rule_window(&db, &account, second, true);
        assert_eq!(db.pending_move_uids(inbox).unwrap().len(), 101);
        assert_eq!(db.rules_pending_from(account_id).unwrap(), None);
    }

    #[test]
    fn filter_rules_apply_locally_and_queue_for_replay() {
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let archive = rule_mailbox(&db, account_id, "Archive", &MailboxRole::Archive);
        let id = bill(&db, account_id, inbox, 1);

        // Read rule: applied locally, flag queued exactly once (deduped).
        let mut read_rule = db
            .create_filter_rule(&enabled_rule(account_id, "mark_read"))
            .unwrap();
        apply_filter_rules(&db, &account, None);
        assert!(db
            .unread_message_ids(inbox)
            .unwrap()
            .iter()
            .all(|(unread_id, _)| unread_id != &id));
        let flag_ops: Vec<String> = db
            .queued_operations(account_id)
            .unwrap()
            .iter()
            .filter(|(_, kind, _)| kind == "flags")
            .map(|(_, _, payload)| payload.clone())
            .collect();
        assert_eq!(flag_ops.len(), 1);
        assert!(flag_ops[0].contains("isRead"));
        assert!(flag_ops[0].contains("\"uid\":1"));

        // Unread a second message; move rule queues a move with pending flag.
        bill(&db, account_id, inbox, 2);
        db.set_flags(id, Some(false), None).unwrap();
        read_rule.enabled = false;
        db.update_filter_rule(&read_rule).unwrap();
        db.create_filter_rule(&enabled_rule(account_id, "move_archive"))
            .unwrap();
        apply_filter_rules(&db, &account, None);
        let move_ops: Vec<String> = db
            .queued_operations(account_id)
            .unwrap()
            .iter()
            .filter(|(_, kind, _)| kind == "move")
            .map(|(_, _, payload)| payload.clone())
            .collect();
        assert_eq!(move_ops.len(), 2);
        assert!(move_ops[0].contains("\"uid\":2") || move_ops[1].contains("\"uid\":2"));
        assert!(move_ops[0].contains("\"uid\":1") || move_ops[1].contains("\"uid\":1"));
        assert_eq!(db.pending_move_uids(inbox).unwrap(), vec![2, 1]);
        assert_eq!(db.pending_move_uids(archive).unwrap(), Vec::<u32>::new());
    }

    #[test]
    fn mark_read_and_move_rules_apply_to_the_same_unread_set() {
        let db = Database::memory();
        let account = rule_account();
        let account_id = account.summary.id.clone();
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, &account_id, "INBOX", &MailboxRole::Inbox);
        let archive = rule_mailbox(&db, &account_id, "Archive", &MailboxRole::Archive);
        let _ = archive;
        bill(&db, &account_id, inbox, 1);
        db.create_filter_rule(&enabled_rule(&account_id, "mark_read"))
            .unwrap();
        db.create_filter_rule(&enabled_rule(&account_id, "move_archive"))
            .unwrap();
        apply_filter_rules(&db, &account, None);
        let move_ops: Vec<String> = db
            .queued_operations(&account_id)
            .unwrap()
            .iter()
            .filter(|(_, kind, _)| kind == "move")
            .map(|(_, _, payload)| payload.clone())
            .collect();
        assert_eq!(move_ops.len(), 1);
        assert!(db.list_filter_rules(&account_id).is_ok());
    }

    #[test]
    fn first_queued_move_wins_when_multiple_move_rules_match() {
        let db = Database::memory();
        let account = rule_account();
        let account_id = account.summary.id.clone();
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, &account_id, "INBOX", &MailboxRole::Inbox);
        let archive = rule_mailbox(&db, &account_id, "Archive", &MailboxRole::Archive);
        let trash = rule_mailbox(&db, &account_id, "Trash", &MailboxRole::Trash);
        let message_id = bill(&db, &account_id, inbox, 1);
        db.create_filter_rule(&enabled_rule(&account_id, "move_archive"))
            .unwrap();
        db.create_filter_rule(&enabled_rule(&account_id, "move_trash"))
            .unwrap();
        apply_filter_rules(&db, &account, None);
        let move_ops: Vec<String> = db
            .queued_operations(&account_id)
            .unwrap()
            .iter()
            .filter(|(_, kind, _)| kind == "move")
            .map(|(_, _, payload)| payload.clone())
            .collect();
        assert_eq!(move_ops.len(), 1);
        assert!(move_ops[0].contains("\"destination\":\"Archive\""));
        assert!(!move_ops[0].contains("\"destination\":\"Trash\""));
        let pending: Option<i64> = db
            .conn()
            .unwrap()
            .query_row(
                "SELECT pending_move_to FROM messages WHERE id=?1",
                [message_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, Some(archive));
        assert_ne!(pending, Some(trash));
    }

    #[test]
    fn update_password_keeps_the_normalized_secret() {
        let secret = take_normalized_account_password(
            &ProviderKind::Icloud,
            zeroize::Zeroizing::new("  family-secret  ".into()),
        )
        .expect("normalized password");
        assert_eq!(secret.as_str(), "family-secret");
    }

    fn attachment_owners(ids: &[&str]) -> crate::db::Database {
        let db = crate::db::Database::memory();
        for (index, id) in ids.iter().enumerate() {
            let mut account = rule_account();
            account.summary.id = (*id).to_string();
            account.summary.email = format!("owner{index}@example.com");
            db.insert_account(&account).unwrap();
        }
        db
    }

    // Failures: delayed cleanup uses stale owners, deletes a new account's
    // attachment, or reports success when ownership cannot be read.
    #[test]
    fn delayed_orphan_cleanup_keeps_a_newly_added_account() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let root = tempfile::tempdir().unwrap();
            let db = crate::db::Database::memory();
            let mut account = rule_account();
            account.summary.id = uuid::Uuid::new_v4().to_string();
            let path = root.path().join(&account.summary.id);
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            started_rx.await.unwrap();
            let sweep = super::accounts::sweep_unowned_attachments(&db, root.path().to_path_buf());
            tokio::pin!(sweep);
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(sweep.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            db.insert_account(&account).unwrap();
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("draft.bin"), b"unsent attachment").unwrap();
            release_tx.send(()).unwrap();
            let remaining = sweep.await;
            blocker.await.unwrap();
            assert_eq!(remaining, 0);
            assert!(path.join("draft.bin").is_file());
        });
    }

    // Failure: overlapping startup/retry sweeps report already-removed files
    // as leftovers and leave a false pending-cleanup marker.
    #[tokio::test]
    async fn concurrent_orphan_sweeps_do_not_report_removed_files_as_leftovers() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("draft.bin"), b"orphan").unwrap();
        let db = crate::db::Database::memory();
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
        let remove = |path: std::path::PathBuf| {
            let db = db.clone();
            let barrier = barrier.clone();
            async move {
                barrier.wait().await;
                tokio::task::spawn_blocking(move || db.remove_unowned_account_dir(&path))
                    .await
                    .unwrap()
                    .map_err(std::io::Error::other)
            }
        };
        let (first, second) = tokio::join!(
            sweep_orphaned_account_dirs(root.path().to_path_buf(), vec![], &remove),
            sweep_orphaned_account_dirs(root.path().to_path_buf(), vec![], &remove),
        );
        assert!(!path.exists());
        assert_eq!((first, second), (0, 0));
    }

    #[tokio::test]
    async fn orphan_cleanup_keeps_files_when_ownership_query_fails() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("draft.bin"), b"keep").unwrap();
        let db = crate::db::Database::memory();
        db.conn()
            .unwrap()
            .execute_batch("DROP TABLE accounts")
            .unwrap();
        let remaining =
            super::accounts::sweep_unowned_attachments(&db, root.path().to_path_buf()).await;
        assert_eq!(remaining, 1);
        assert!(path.join("draft.bin").is_file());
    }

    #[tokio::test]
    async fn startup_cleanup_removes_only_orphaned_uuid_directories() {
        let root = tempfile::tempdir().unwrap();
        let active = uuid::Uuid::new_v4().hyphenated().to_string();
        let orphaned = uuid::Uuid::new_v4().hyphenated().to_string();
        let unrelated = "user-files";
        std::fs::create_dir(root.path().join(&active)).unwrap();
        std::fs::create_dir(root.path().join(&orphaned)).unwrap();
        std::fs::create_dir(root.path().join(unrelated)).unwrap();

        let remaining = cleanup_orphaned_account_dirs(
            root.path().to_path_buf(),
            &attachment_owners(&[&active]),
        )
        .await;

        assert_eq!(remaining, 0);
        assert!(root.path().join(active).is_dir());
        assert!(!root.path().join(orphaned).exists());
        assert!(root.path().join(unrelated).is_dir());
    }

    // Failure modes for orphaned attachment folders:
    // 1. A folder that cannot be removed is not reported as still present.
    // 2. A clean or never-created root reports a false alarm.
    // 3. A symlink named like an account id is followed and its target removed.
    // 4. An uppercase, braced, or non-UUID name is removed as if it were ours.
    // 5. An active account's folder is removed.
    // 6. A stale marker survives a sweep that now finds nothing.
    #[cfg(unix)]
    #[tokio::test]
    async fn orphan_sweep_reports_a_folder_it_cannot_remove() {
        let root = tempfile::tempdir().unwrap();
        let orphan = root
            .path()
            .join(uuid::Uuid::new_v4().hyphenated().to_string());
        std::fs::create_dir(&orphan).unwrap();
        std::fs::write(orphan.join("draft.bin"), b"attachment").unwrap();
        let Some(lock) = make_unwritable(root.path()) else {
            // Running as root bypasses directory permissions; nothing to prove.
            return;
        };
        let remaining =
            cleanup_orphaned_account_dirs(root.path().to_path_buf(), &attachment_owners(&[])).await;
        drop(lock);
        assert_eq!(remaining, 1);
        assert!(orphan.is_dir());
    }

    #[tokio::test]
    async fn orphan_sweep_reports_nothing_for_a_clean_or_missing_root() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            cleanup_orphaned_account_dirs(root.path().to_path_buf(), &attachment_owners(&[])).await,
            0
        );
        let missing = root.path().join("never-created");
        assert_eq!(
            cleanup_orphaned_account_dirs(missing, &attachment_owners(&[])).await,
            0
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn orphan_sweep_never_follows_or_removes_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep.txt"), b"keep").unwrap();
        let link = root
            .path()
            .join(uuid::Uuid::new_v4().hyphenated().to_string());
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();

        let remaining =
            cleanup_orphaned_account_dirs(root.path().to_path_buf(), &attachment_owners(&[])).await;

        assert_eq!(remaining, 0);
        assert!(outside.path().join("keep.txt").is_file());
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    }

    #[tokio::test]
    async fn orphan_sweep_keeps_uppercase_braced_and_plain_uuid_names() {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4();
        let names = [
            id.hyphenated().to_string().to_uppercase(),
            id.braced().to_string(),
            id.simple().to_string(),
        ];
        for name in &names {
            std::fs::create_dir(root.path().join(name)).unwrap();
        }

        let remaining =
            cleanup_orphaned_account_dirs(root.path().to_path_buf(), &attachment_owners(&[])).await;

        assert_eq!(remaining, 0);
        for name in &names {
            assert!(root.path().join(name).is_dir(), "{name} was removed");
        }
    }

    // Failure modes for the injected-remover sweep (platform-neutral):
    // 1. A failed removal is not counted, so leftovers go unreported.
    // 2. A successful removal is counted as a leftover.
    // 3. An active, symlinked, or non-canonical entry reaches the remover.
    #[tokio::test]
    async fn orphan_sweep_counts_only_failed_removals_it_attempts() {
        let root = tempfile::tempdir().unwrap();
        let active = uuid::Uuid::new_v4().hyphenated().to_string();
        let failing = uuid::Uuid::new_v4().hyphenated().to_string();
        let succeeding = uuid::Uuid::new_v4().hyphenated().to_string();
        let uppercase = uuid::Uuid::new_v4().hyphenated().to_string().to_uppercase();
        let braced = uuid::Uuid::new_v4().braced().to_string();
        for name in [&active, &failing, &succeeding, &uppercase, &braced] {
            std::fs::create_dir(root.path().join(name)).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            root.path().join("missing-target"),
            root.path()
                .join(uuid::Uuid::new_v4().hyphenated().to_string()),
        )
        .unwrap();

        let attempted = std::sync::Mutex::new(Vec::<String>::new());
        let remaining = sweep_orphaned_account_dirs(
            root.path().to_path_buf(),
            vec![active.clone()],
            |path: std::path::PathBuf| {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                let fails = name == failing;
                attempted.lock().unwrap().push(name);
                async move {
                    if fails {
                        Err(std::io::Error::other("injected removal failure"))
                    } else {
                        Ok(())
                    }
                }
            },
        )
        .await;

        assert_eq!(remaining, 1);
        let mut attempted = attempted.into_inner().unwrap();
        attempted.sort();
        let mut expected = vec![failing, succeeding];
        expected.sort();
        assert_eq!(attempted, expected);
    }

    #[test]
    fn orphan_marker_follows_the_last_sweep() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("orphan-attachments-pending");
        record_orphan_marker(&marker, 2);
        assert!(marker.exists());
        record_orphan_marker(&marker, 0);
        assert!(!marker.exists());
        record_orphan_marker(&marker, 0);
        assert!(!marker.exists());
    }

    #[test]
    fn preview_text_rejects_binary_content() {
        assert_eq!(
            preview_text(b"Hello\nworld\t!").as_deref(),
            Some("Hello\nworld\t!")
        );
        assert!(preview_text(b"\x00\x01\x02binary").is_none());
        assert!(preview_text("héllo wörld".as_bytes()).is_some());
    }

    #[test]
    fn requested_send_at_accepts_only_bounded_future_times() {
        assert_eq!(resolve_requested_send_at(None).unwrap(), None);
        assert_eq!(resolve_requested_send_at(Some("   ")).unwrap(), None);
        assert!(resolve_requested_send_at(Some("tomorrow-ish")).is_err());
        assert!(resolve_requested_send_at(Some("2000-01-01T00:00:00Z")).is_err());
        let far = (chrono::Utc::now() + chrono::Duration::days(366)).to_rfc3339();
        assert!(resolve_requested_send_at(Some(&far)).is_err());
        let soon = (chrono::Utc::now() + chrono::Duration::hours(3)).to_rfc3339();
        let resolved = resolve_requested_send_at(Some(&soon)).unwrap().unwrap();
        assert!(resolved.contains("T"));
    }

    #[test]
    fn queued_replay_validation_drops_stale_operations_before_network() {
        use super::{validate_queued_operation, ValidatedReplay};

        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        rule_mailbox(&db, account_id, "Archive", &MailboxRole::Archive);
        let id = bill(&db, account_id, inbox, 1);

        let flag =
            |mailbox: &str, uid: u32, validity: Option<u32>| super::messages::FlagOperation {
                message_id: id,
                uid,
                mailbox: mailbox.into(),
                uid_validity: validity,
                is_read: Some(true),
                is_starred: None,
            };
        let flags_payload =
            |operation: &super::messages::FlagOperation| serde_json::to_string(operation).unwrap();

        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "flags",
                &flags_payload(&flag("INBOX", 1, Some(1)))
            ),
            Ok(ValidatedReplay::Flags(_))
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "flags",
                &flags_payload(&flag("INBOX", 1, Some(99)))
            ),
            Ok(ValidatedReplay::Drop)
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "flags",
                &flags_payload(&flag("INBOX", 1, None))
            ),
            Ok(ValidatedReplay::Drop)
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "flags",
                &flags_payload(&flag("Archive", 1, Some(1)))
            ),
            Ok(ValidatedReplay::Drop)
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "flags",
                &flags_payload(&flag("INBOX", 42, Some(1)))
            ),
            Ok(ValidatedReplay::Drop)
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                "account-2",
                "flags",
                &flags_payload(&flag("INBOX", 1, Some(1)))
            ),
            Ok(ValidatedReplay::Drop)
        ));
        assert!(matches!(
            validate_queued_operation(&db, account_id, "flags", "not json"),
            Ok(ValidatedReplay::Drop)
        ));
        assert!(matches!(
            validate_queued_operation(&db, account_id, "unknown", "{}"),
            Ok(ValidatedReplay::Drop)
        ));

        let move_operation =
            |destination: &str, validity: Option<u32>| super::messages::MoveOperation {
                message_id: id,
                uid: 1,
                source: "INBOX".into(),
                destination: destination.into(),
                uid_validity: validity,
            };
        let move_payload =
            |operation: &super::messages::MoveOperation| serde_json::to_string(operation).unwrap();

        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "move",
                &move_payload(&move_operation("Archive", Some(1)))
            ),
            Ok(ValidatedReplay::Move(_))
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "move",
                &move_payload(&move_operation("INBOX", Some(1)))
            ),
            Ok(ValidatedReplay::ClearPending(value)) if value == id
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "move",
                &move_payload(&move_operation("Archive", Some(99)))
            ),
            Ok(ValidatedReplay::ClearPending(value)) if value == id
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "copy",
                &move_payload(&move_operation("Archive", Some(1)))
            ),
            Ok(ValidatedReplay::Copy(_))
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "copy",
                &move_payload(&move_operation("INBOX", Some(1)))
            ),
            Ok(ValidatedReplay::Drop)
        ));
        assert!(matches!(
            validate_queued_operation(
                &db,
                account_id,
                "copy",
                &move_payload(&move_operation("Archive", Some(99)))
            ),
            Ok(ValidatedReplay::Drop)
        ));
    }

    #[test]
    fn retired_account_cannot_recreate_actor() {
        // W9: once the row is gone, no caller may bring a worker back.
        let directory =
            std::env::temp_dir().join(format!("postal-snap-actor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let db = Database::memory();
        let settings =
            crate::settings::SettingsStore::load(directory.join("settings.json"), &db).unwrap();
        let state = super::AppState::new(db.clone(), settings, directory.clone());
        let mut account = rule_account();
        account.summary.id = uuid::Uuid::new_v4().to_string();
        db.insert_account(&account).unwrap();

        assert!(state.actor(&account.summary.id).is_ok());
        db.remove_account(&account.summary.id).unwrap();
        state.retire_actor(&account.summary.id);

        assert!(state.actor(&account.summary.id).is_err());
        assert!(state
            .request(&account.summary.id, super::wake::SYNC)
            .is_err());
        let _ = std::fs::remove_dir_all(directory);
    }

    // Replied/forwarded failure modes, written before the code:
    // - a keyword is set after a refused, retry, or uncertain send
    // - a forged source_message_id from another account gets a flag
    // - $Forwarded is attempted where PERMANENTFLAGS forbids it
    // - the flag op replays onto a recycled UID or changed UIDVALIDITY
    // - the local mark clears an already-set flag
    // - a draft with no source, or a plain new message, gets a keyword
    #[test]
    fn keyword_only_after_confirmed_send() {
        use super::replied::{keyword_after_send, SourceKeyword};
        use crate::mail::SendFailure;
        use crate::models::DraftSourceKind::{Forward, Redirect, Reply, ReplyAll};
        assert_eq!(
            keyword_after_send(Some(Reply), &Ok(())),
            Some(SourceKeyword::Answered)
        );
        assert_eq!(
            keyword_after_send(Some(ReplyAll), &Ok(())),
            Some(SourceKeyword::Answered)
        );
        assert_eq!(
            keyword_after_send(Some(Forward), &Ok(())),
            Some(SourceKeyword::Forwarded)
        );
        assert_eq!(keyword_after_send(Some(Redirect), &Ok(())), None);
        assert_eq!(keyword_after_send(None, &Ok(())), None);
        for failure in [
            SendFailure::NotSentRetry,
            SendFailure::NotSentRefused,
            SendFailure::Uncertain,
        ] {
            for kind in [Reply, ReplyAll, Forward, Redirect] {
                assert_eq!(keyword_after_send(Some(kind), &Err(failure)), None);
            }
        }
    }

    #[test]
    fn forwarded_needs_permanent_flag_support() {
        use crate::mail::folders::forwarded_permitted;
        use async_imap::types::Flag;
        assert!(!forwarded_permitted(&[]));
        assert!(!forwarded_permitted(&[Flag::Seen, Flag::Answered]));
        assert!(forwarded_permitted(&[Flag::MayCreate]));
        assert!(forwarded_permitted(&[Flag::Custom("$forwarded".into())]));
        assert!(!forwarded_permitted(&[Flag::Custom("$Junk".into())]));
    }

    #[test]
    fn source_message_must_belong_to_the_sending_account() {
        use super::replied::resolve_source;
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let mut other = rule_account();
        other.summary.id = "account-2".into();
        other.summary.email = "kim@example.com".into();
        other.imap.username = "kim@example.com".into();
        other.smtp.username = "kim@example.com".into();
        db.insert_account(&other).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        let target = resolve_source(&db, account_id, id).unwrap().unwrap();
        assert_eq!((target.mailbox.as_str(), target.uid), ("INBOX", 1));
        assert_eq!(target.uid_validity, Some(1));
        assert!(resolve_source(&db, "account-2", id).unwrap().is_none());
        assert!(resolve_source(&db, account_id, id + 999).unwrap().is_none());
    }

    fn queue_keyword(db: &Database, account_id: &str, operation: &replied::KeywordOperation) {
        let key = format!("keyword:{}:{:?}", operation.message_id, operation.keyword);
        db.queue_operation(account_id, "keyword", operation, Some(&key))
            .unwrap();
    }

    fn keyword_operation(
        message_id: i64,
        uid: u32,
        keyword: replied::SourceKeyword,
    ) -> replied::KeywordOperation {
        replied::KeywordOperation {
            message_id,
            uid,
            mailbox: "INBOX".into(),
            uid_validity: Some(1),
            keyword,
        }
    }

    fn keyword_ops_for(db: &Database, account_id: &str, message_id: i64) -> usize {
        db.queued_operations(account_id)
            .unwrap()
            .iter()
            .filter(|(_, kind, payload)| {
                kind == "keyword"
                    && serde_json::from_str::<replied::KeywordOperation>(payload)
                        .is_ok_and(|operation| operation.message_id == message_id)
            })
            .count()
    }

    #[tokio::test]
    async fn queued_source_keywords_finish_before_archive_moves_the_source() {
        use replied::SourceKeyword::{Answered, Forwarded};
        type Outcome = Result<(), mail::MailboxOperationError>;
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        let other = bill(&db, account_id, inbox, 2);
        let mut second = rule_account();
        second.summary.id = "account-2".into();
        second.summary.email = "other@example.com".into();
        db.insert_account(&second).unwrap();
        let second_inbox = rule_mailbox(&db, "account-2", "INBOX", &MailboxRole::Inbox);
        let foreign = bill(&db, "account-2", second_inbox, 1);
        let ok = || std::future::ready(Ok::<(), mail::MailboxOperationError>(()));
        let transient = || -> std::future::Ready<Outcome> {
            std::future::ready(Err(mail::MailboxOperationError::transient(
                "offline".into(),
            )))
        };
        let terminal = || -> std::future::Ready<Outcome> {
            std::future::ready(Err(mail::MailboxOperationError::terminal(
                "mailbox changed".into(),
            )))
        };

        // Nothing queued: nothing sent, archive may proceed.
        let calls = std::cell::RefCell::new(Vec::new());
        super::replied::finish_source_keywords(&db, account_id, id, |operation| {
            calls.borrow_mut().push(operation.keyword);
            ok()
        })
        .await
        .unwrap();
        assert!(calls.borrow().is_empty());

        // Only this message's keyword ops run. Other messages, other accounts,
        // and other kinds stay queued.
        queue_keyword(&db, account_id, &keyword_operation(id, 1, Answered));
        queue_keyword(&db, account_id, &keyword_operation(other, 2, Answered));
        queue_keyword(&db, "account-2", &keyword_operation(foreign, 1, Forwarded));
        db.queue_operation(
            account_id,
            "flags",
            &serde_json::json!({ "messageId": id, "mailbox": "INBOX", "uid": 1, "uidValidity": 1, "isRead": true }),
            Some("flags-1"),
        )
        .unwrap();
        let calls = std::cell::RefCell::new(Vec::new());
        super::replied::finish_source_keywords(&db, account_id, id, |operation| {
            calls
                .borrow_mut()
                .push((operation.message_id, operation.keyword));
            ok()
        })
        .await
        .unwrap();
        assert_eq!(*calls.borrow(), vec![(id, Answered)]);
        assert_eq!(keyword_ops_for(&db, account_id, id), 0);
        assert_eq!(keyword_ops_for(&db, account_id, other), 1);
        assert_eq!(keyword_ops_for(&db, "account-2", foreign), 1);
        assert_eq!(db.queued_operations(account_id).unwrap().len(), 2);

        // A transient failure stops the archive and keeps the op queued.
        let result =
            super::replied::finish_source_keywords(&db, account_id, other, |_| transient()).await;
        assert!(result.is_err());
        assert_eq!(keyword_ops_for(&db, account_id, other), 1);

        // A terminal failure drops the stale op so archive can continue.
        let result =
            super::replied::finish_source_keywords(&db, account_id, other, |_| terminal()).await;
        assert!(result.is_ok());
        assert_eq!(keyword_ops_for(&db, account_id, other), 0);

        // Partial success: the first op lands, the second stays queued.
        queue_keyword(&db, account_id, &keyword_operation(id, 1, Answered));
        queue_keyword(&db, account_id, &keyword_operation(id, 1, Forwarded));
        let attempts = std::cell::Cell::new(0);
        let result = super::replied::finish_source_keywords(&db, account_id, id, |_| {
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                ok()
            } else {
                transient()
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(keyword_ops_for(&db, account_id, id), 1);

        // A stale op (source uid no longer matches) never reaches the server.
        let stale = bill(&db, account_id, inbox, 9);
        queue_keyword(&db, account_id, &keyword_operation(stale, 4, Answered));
        let called = std::cell::Cell::new(false);
        super::replied::finish_source_keywords(&db, account_id, stale, |_| {
            called.set(true);
            ok()
        })
        .await
        .unwrap();
        assert!(!called.get());
        assert_eq!(keyword_ops_for(&db, account_id, stale), 0);
    }

    fn store_ok() -> std::future::Ready<Result<(), mail::MailboxOperationError>> {
        std::future::ready(Ok(()))
    }

    fn store_transient() -> std::future::Ready<Result<(), mail::MailboxOperationError>> {
        std::future::ready(Err(mail::MailboxOperationError::transient(
            "offline".into(),
        )))
    }

    fn store_terminal() -> std::future::Ready<Result<(), mail::MailboxOperationError>> {
        std::future::ready(Err(mail::MailboxOperationError::terminal(
            "mailbox changed".into(),
        )))
    }

    // Failure modes for the send-time keyword intent (Answered/Forwarded):
    // 1. The STORE runs before the intent is queued, so a crash loses it.
    // 2. A successful STORE leaves the queued intent behind for a second STORE.
    // 3. A transient STORE failure drops the intent, so it is never retried.
    // 4. A terminal STORE failure keeps the intent, so it replays forever.
    // 5. A queue failure skips the STORE or fails the send.
    // 6. A crash after queueing but before the STORE leaves no replayable intent.
    // 7. Archive moves a message while its transient keyword is still queued.
    #[tokio::test]
    async fn keyword_intent_is_queued_before_the_store_runs() {
        use replied::SourceKeyword::Answered;
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        let queued_during_store = std::cell::Cell::new(None);
        replied::apply_keyword_intent(&db, account_id, keyword_operation(id, 1, Answered), |_| {
            queued_during_store.set(Some(keyword_ops_for(&db, account_id, id)));
            store_ok()
        })
        .await;
        assert_eq!(queued_during_store.get(), Some(1));
    }

    #[tokio::test]
    async fn keyword_intent_is_removed_after_store_success() {
        use replied::SourceKeyword::Answered;
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        replied::apply_keyword_intent(&db, account_id, keyword_operation(id, 1, Answered), |_| {
            store_ok()
        })
        .await;
        assert_eq!(keyword_ops_for(&db, account_id, id), 0);
    }

    #[tokio::test]
    async fn keyword_intent_survives_a_transient_store_failure_once() {
        use replied::SourceKeyword::Answered;
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        for _ in 0..2 {
            replied::apply_keyword_intent(
                &db,
                account_id,
                keyword_operation(id, 1, Answered),
                |_| store_transient(),
            )
            .await;
        }
        // Same message and keyword share one dedupe key.
        assert_eq!(keyword_ops_for(&db, account_id, id), 1);
    }

    #[tokio::test]
    async fn keyword_intent_is_removed_after_a_terminal_store_failure() {
        use replied::SourceKeyword::Answered;
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        replied::apply_keyword_intent(&db, account_id, keyword_operation(id, 1, Answered), |_| {
            store_terminal()
        })
        .await;
        assert_eq!(keyword_ops_for(&db, account_id, id), 0);
    }

    #[tokio::test]
    async fn keyword_intent_queue_failure_does_not_block_the_store() {
        use replied::SourceKeyword::Answered;
        let db = Database::memory();
        // No such account: the foreign key rejects the queued row.
        let store_calls = std::cell::Cell::new(0);
        replied::apply_keyword_intent(&db, "ghost", keyword_operation(1, 1, Answered), |_| {
            store_calls.set(store_calls.get() + 1);
            store_ok()
        })
        .await;
        assert_eq!(store_calls.get(), 1);
        assert!(db.queued_operations("ghost").unwrap().is_empty());
    }

    #[tokio::test]
    async fn keyword_intent_left_by_a_crash_replays_before_archive() {
        use super::{validate_queued_operation, ValidatedReplay};
        use replied::SourceKeyword::Answered;
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        // Crash simulation: the intent was queued, then the process stopped
        // before any STORE ran.
        queue_keyword(&db, account_id, &keyword_operation(id, 1, Answered));
        let (_, kind, payload) = db.queued_operations(account_id).unwrap().remove(0);
        assert!(matches!(
            validate_queued_operation(&db, account_id, &kind, &payload),
            Ok(ValidatedReplay::Keyword(_))
        ));
        let applied = std::cell::RefCell::new(Vec::new());
        replied::finish_source_keywords(&db, account_id, id, |operation| {
            applied.borrow_mut().push(operation.keyword);
            store_ok()
        })
        .await
        .unwrap();
        assert_eq!(*applied.borrow(), vec![Answered]);
        assert_eq!(keyword_ops_for(&db, account_id, id), 0);
    }

    #[tokio::test]
    async fn keyword_intent_blocks_archive_until_its_store_succeeds() {
        use replied::SourceKeyword::Answered;
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        replied::apply_keyword_intent(&db, account_id, keyword_operation(id, 1, Answered), |_| {
            store_transient()
        })
        .await;
        assert!(
            replied::finish_source_keywords(&db, account_id, id, |_| store_transient())
                .await
                .is_err()
        );
        assert_eq!(keyword_ops_for(&db, account_id, id), 1);
        replied::finish_source_keywords(&db, account_id, id, |_| store_ok())
            .await
            .unwrap();
        assert_eq!(keyword_ops_for(&db, account_id, id), 0);
    }

    #[test]
    fn keyword_replay_drops_stale_operations_and_mark_only_sets() {
        use super::replied::KeywordOperation;
        use super::{validate_queued_operation, ValidatedReplay};
        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let id = bill(&db, account_id, inbox, 1);
        let payload = |uid: u32, validity: Option<u32>, mailbox: &str| {
            serde_json::to_string(&KeywordOperation {
                message_id: id,
                uid,
                mailbox: mailbox.into(),
                uid_validity: validity,
                keyword: super::replied::SourceKeyword::Answered,
            })
            .unwrap()
        };
        assert!(matches!(
            validate_queued_operation(&db, account_id, "keyword", &payload(1, Some(1), "INBOX")),
            Ok(ValidatedReplay::Keyword(_))
        ));
        for stale in [
            payload(1, Some(9), "INBOX"),
            payload(1, None, "INBOX"),
            payload(7, Some(1), "INBOX"),
            payload(1, Some(1), "Archive"),
        ] {
            assert!(matches!(
                validate_queued_operation(&db, account_id, "keyword", &stale),
                Ok(ValidatedReplay::Drop)
            ));
        }
        assert!(matches!(
            validate_queued_operation(&db, "account-2", "keyword", &payload(1, Some(1), "INBOX")),
            Ok(ValidatedReplay::Drop)
        ));
        db.mark_replied(id, account_id, true, false).unwrap();
        db.mark_replied(id, account_id, false, true).unwrap();
        db.mark_replied(id, account_id, false, false).unwrap();
        let summary = db.list_messages(inbox, None, 10).unwrap().items.remove(0);
        assert!(summary.is_answered && summary.is_forwarded);
    }

    #[test]
    fn move_replay_collects_later_flags_for_the_same_source_identity() {
        use super::move_replay_flag_dependencies;

        let db = Database::memory();
        let account = rule_account();
        let account_id = &account.summary.id;
        db.insert_account(&account).unwrap();
        let inbox = rule_mailbox(&db, account_id, "INBOX", &MailboxRole::Inbox);
        let archive = rule_mailbox(&db, account_id, "Archive", &MailboxRole::Archive);
        let id = bill(&db, account_id, inbox, 1);
        let movement = super::messages::MoveOperation {
            message_id: id,
            uid: 1,
            source: "INBOX".into(),
            destination: "Archive".into(),
            uid_validity: Some(1),
        };
        db.queue_operation(account_id, "move", &movement, Some(&format!("move:{id}")))
            .unwrap();
        db.mark_pending_move(id, archive).unwrap();

        let flag = |is_read: Option<bool>, is_starred: Option<bool>, uid, validity| {
            serde_json::json!({
                "messageId": id,
                "uid": uid,
                "mailbox": "INBOX",
                "uidValidity": validity,
                "isRead": is_read.map(serde_json::Value::Bool).unwrap_or(serde_json::Value::Null),
                "isStarred": is_starred.map(serde_json::Value::Bool).unwrap_or(serde_json::Value::Null),
            })
        };
        db.queue_operation(
            account_id,
            "flags",
            &flag(Some(true), None, 1, 1),
            Some(&format!("flags:{id}:true:false")),
        )
        .unwrap();
        db.queue_operation(
            account_id,
            "flags",
            &flag(None, Some(true), 1, 1),
            Some(&format!("flags:{id}:false:true")),
        )
        .unwrap();
        db.queue_operation(
            account_id,
            "flags",
            &flag(Some(false), None, 1, 1),
            Some(&format!("flags:{id}:true:false")),
        )
        .unwrap();
        db.queue_operation(
            account_id,
            "flags",
            &flag(None, Some(false), 99, 1),
            Some("flags:stale-uid"),
        )
        .unwrap();

        let dependencies =
            move_replay_flag_dependencies(&db.queued_operations(account_id).unwrap(), &movement);
        assert_eq!(dependencies.operation_ids.len(), 2);
        assert_eq!(dependencies.is_read, Some(false));
        assert_eq!(dependencies.is_starred, Some(true));
    }

    // Batched replay failure modes (W15):
    // 1. Flags with different values share one STORE and apply the wrong value.
    // 2. A move batches without MOVE, or retries a move that may have landed.
    // 3. A batch reorders ops for one message or puts one message twice in a command.
    // 4. An unbounded run builds an IMAP command line the server rejects.
    use super::{
        plan_replay_batches, replay_candidates, ReplayBatchCaps, ReplayCandidate, ReplayPlanKind,
    };

    const MOVE_CAPABLE: ReplayBatchCaps = ReplayBatchCaps {
        move_supported: true,
    };
    const NO_MOVE: ReplayBatchCaps = ReplayBatchCaps {
        move_supported: false,
    };

    fn flag_candidate(
        id: i64,
        message_id: i64,
        mailbox: &str,
        uid_validity: Option<u32>,
        is_read: Option<bool>,
        is_starred: Option<bool>,
    ) -> ReplayCandidate {
        ReplayCandidate {
            id,
            message_id,
            kind: ReplayPlanKind::Flags {
                mailbox: mailbox.into(),
                uid_validity,
                is_read,
                is_starred,
            },
        }
    }

    fn move_candidate(
        id: i64,
        message_id: i64,
        source: &str,
        destination: &str,
        attempts: i64,
    ) -> ReplayCandidate {
        ReplayCandidate {
            id,
            message_id,
            kind: ReplayPlanKind::Move {
                source: source.into(),
                destination: destination.into(),
                uid_validity: Some(7),
                attempts,
                has_flag_dependencies: false,
            },
        }
    }

    #[test]
    fn replay_plan_groups_flags_by_mailbox_validity_and_values() {
        let candidates = vec![
            flag_candidate(1, 10, "INBOX", Some(7), Some(true), None),
            flag_candidate(2, 11, "INBOX", Some(7), Some(true), None),
            flag_candidate(3, 12, "INBOX", Some(7), Some(false), None),
            flag_candidate(4, 13, "Archive", Some(7), Some(true), None),
            flag_candidate(5, 14, "INBOX", Some(8), Some(true), None),
            flag_candidate(6, 15, "INBOX", Some(8), Some(true), Some(true)),
        ];
        assert_eq!(
            plan_replay_batches(&candidates, NO_MOVE),
            vec![vec![0, 1], vec![2], vec![3], vec![4], vec![5]]
        );
    }

    #[test]
    fn replay_plan_caps_each_batch_at_the_uid_limit() {
        let total = super::MAX_REPLAY_BATCH_UIDS * 2 + 1;
        let candidates: Vec<_> = (0..total)
            .map(|index| {
                let id = index as i64 + 1;
                flag_candidate(id, id, "INBOX", Some(7), Some(true), None)
            })
            .collect();
        let sizes: Vec<usize> = plan_replay_batches(&candidates, NO_MOVE)
            .iter()
            .map(Vec::len)
            .collect();
        assert_eq!(
            sizes,
            vec![
                super::MAX_REPLAY_BATCH_UIDS,
                super::MAX_REPLAY_BATCH_UIDS,
                1
            ]
        );
    }

    #[test]
    fn replay_plan_batches_moves_only_with_move_capability() {
        let candidates = vec![
            move_candidate(1, 10, "INBOX", "Archive", 0),
            move_candidate(2, 11, "INBOX", "Archive", 0),
        ];
        assert_eq!(
            plan_replay_batches(&candidates, NO_MOVE),
            vec![vec![0], vec![1]]
        );
        assert_eq!(
            plan_replay_batches(&candidates, MOVE_CAPABLE),
            vec![vec![0, 1]]
        );
    }

    #[test]
    fn replay_plan_keeps_retried_moves_on_the_per_op_path() {
        let candidates = vec![
            move_candidate(1, 10, "INBOX", "Archive", 0),
            move_candidate(2, 11, "INBOX", "Archive", 1),
            move_candidate(3, 12, "INBOX", "Archive", 0),
        ];
        assert_eq!(
            plan_replay_batches(&candidates, MOVE_CAPABLE),
            vec![vec![0], vec![1], vec![2]]
        );
    }

    #[test]
    fn replay_plan_never_batches_moves_that_only_clear_pending() {
        let mut no_validity = move_candidate(2, 11, "INBOX", "Archive", 0);
        if let ReplayPlanKind::Move { uid_validity, .. } = &mut no_validity.kind {
            *uid_validity = None;
        }
        let candidates = vec![
            move_candidate(1, 10, "INBOX", "INBOX", 0),
            no_validity,
            flag_candidate(3, 12, "INBOX", None, Some(true), None),
        ];
        assert_eq!(
            plan_replay_batches(&candidates, MOVE_CAPABLE),
            vec![vec![0], vec![1], vec![2]]
        );
    }

    #[test]
    fn replay_plan_keeps_per_message_order_across_kinds() {
        let candidates = vec![
            flag_candidate(1, 10, "INBOX", Some(7), Some(true), None),
            move_candidate(2, 10, "INBOX", "Archive", 0),
            flag_candidate(3, 10, "Archive", Some(7), None, Some(true)),
        ];
        assert_eq!(
            plan_replay_batches(&candidates, MOVE_CAPABLE),
            vec![vec![0], vec![1], vec![2]]
        );
    }

    #[test]
    fn replay_plan_never_puts_one_message_twice_in_a_batch() {
        let candidates = vec![
            flag_candidate(1, 10, "INBOX", Some(7), Some(true), None),
            flag_candidate(2, 10, "INBOX", Some(7), Some(true), None),
            flag_candidate(3, 11, "INBOX", Some(7), Some(true), None),
        ];
        assert_eq!(
            plan_replay_batches(&candidates, NO_MOVE),
            vec![vec![0], vec![1, 2]]
        );
    }

    #[test]
    fn replay_plan_splits_mixed_runs_in_queue_order() {
        let candidates = vec![
            flag_candidate(1, 10, "INBOX", Some(7), Some(true), None),
            flag_candidate(2, 11, "INBOX", Some(7), Some(true), None),
            move_candidate(3, 12, "INBOX", "Archive", 0),
            move_candidate(4, 13, "INBOX", "Archive", 0),
            move_candidate(5, 14, "INBOX", "Archive", 2),
            flag_candidate(6, 15, "INBOX", Some(7), Some(true), None),
            ReplayCandidate {
                id: 7,
                message_id: 0,
                kind: ReplayPlanKind::Other,
            },
        ];
        assert_eq!(
            plan_replay_batches(&candidates, MOVE_CAPABLE),
            vec![vec![0, 1], vec![2, 3], vec![4], vec![5], vec![6]]
        );
    }

    #[test]
    fn replay_candidates_mark_moves_that_have_queued_flags() {
        let move_payload = |message_id: i64| {
            format!(
                r#"{{"messageId":{message_id},"uid":1,"source":"INBOX","destination":"Archive","uidValidity":7}}"#
            )
        };
        let operations = vec![
            (1, "move".to_string(), move_payload(10), 0),
            (
                2,
                "flags".to_string(),
                r#"{"messageId":10,"uid":1,"mailbox":"INBOX","uidValidity":7,"isRead":true,"isStarred":null}"#
                    .to_string(),
                0,
            ),
            (3, "move".to_string(), move_payload(11), 0),
            (4, "move".to_string(), "not json".to_string(), 0),
        ];
        let candidates = replay_candidates(&operations);
        assert!(matches!(
            candidates[0].kind,
            ReplayPlanKind::Move {
                has_flag_dependencies: true,
                ..
            }
        ));
        assert!(matches!(
            candidates[2].kind,
            ReplayPlanKind::Move {
                has_flag_dependencies: false,
                attempts: 0,
                ..
            }
        ));
        assert_eq!(candidates[3].kind, ReplayPlanKind::Other);
        assert_eq!(
            plan_replay_batches(&candidates, MOVE_CAPABLE),
            vec![vec![0], vec![1], vec![2], vec![3]]
        );
    }
}
