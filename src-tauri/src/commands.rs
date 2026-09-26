use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub mod accounts;
pub mod attachments;
pub mod cache_policy;
pub mod drafts_send;
pub mod folders;
pub mod messages;
pub mod outbox;
pub mod security_net;
pub mod settings_system;
pub mod snooze_filters;
pub mod sync;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    credentials,
    db::Database,
    mail,
    models::{
        normalize_setup_password, validate_compose_draft, validate_compose_sender, AccountRecord,
        CachePolicy, ComposeDraft, IpcError, SyncState,
    },
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
    watchers: Mutex<HashSet<String>>,
    startup_error: Mutex<Option<String>>,
    mail_shortcut_guard: AtomicBool,
    app_nap: Mutex<Option<crate::app_nap::AppNapGuard>>,
}

/// Why an account worker was woken. Reasons accumulate until the worker
/// takes them, so a wake-up sent while IDLE is starting is never lost.
pub(crate) mod wake {
    /// A user action needs the account; resume IDLE afterwards without a sync.
    pub const OPERATION: u8 = 1;
    /// Run a full sync pass (Get Mail, rule changes, folder changes).
    pub const SYNC: u8 = 2;
    /// Push local draft changes to the server.
    pub const DRAFTS: u8 = 4;
    /// Deliver queued or due outbox items.
    pub const OUTBOX: u8 = 8;
    /// Credentials changed; leave the sign-in-failed pause and sync.
    pub const CREDENTIALS: u8 = 16;
    /// The download policy changed; backfill or evict and sync.
    pub const POLICY: u8 = 32;
    /// A manual sync succeeded; leave the sign-in-failed pause without
    /// another pass.
    pub const RESUME: u8 = 64;
}

pub(crate) struct AccountActor {
    operation: Arc<AsyncMutex<()>>,
    wake: Notify,
    reasons: AtomicU8,
    /// Callers queued for the account lock. Background sync yields between
    /// folders and batches while this is non-zero.
    waiting: AtomicUsize,
}

impl AccountActor {
    pub(crate) fn request(&self, reason: u8) {
        self.reasons.fetch_or(reason, Ordering::SeqCst);
        // notify_one stores a permit when IDLE is between setup and waiting,
        // avoiding a lost wake-up.
        self.wake.notify_one();
    }

    fn take_reasons(&self) -> u8 {
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
}

impl AppState {
    pub fn new(db: Database, settings: SettingsStore, attachment_dir: PathBuf) -> Self {
        Self {
            db,
            settings,
            attachment_dir,
            account_actors: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashSet::new()),
            startup_error: Mutex::new(None),
            mail_shortcut_guard: AtomicBool::new(false),
            app_nap: Mutex::new(None),
        }
    }

    pub fn set_startup_error(&self, error: Option<String>) -> Result<(), String> {
        *self
            .startup_error
            .lock()
            .map_err(|_| "Application startup status is unavailable.".to_string())? = error;
        Ok(())
    }

    pub fn take_startup_error(&self) -> Result<Option<String>, String> {
        let mut error = self
            .startup_error
            .lock()
            .map_err(|_| "Application startup status is unavailable.".to_string())?;
        Ok(error.take())
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
            .map_err(|_| "Account worker is unavailable.".to_string())?;
        // Checked under the map lock: removal retires the actor while holding
        // the same lock after deleting the row, so a racing caller cannot
        // recreate a worker for a removed account.
        self.db.account(account_id)?;
        let actor = actors
            .entry(account_id.to_string())
            .or_insert_with(|| {
                Arc::new(AccountActor {
                    operation: Arc::new(AsyncMutex::new(())),
                    wake: Notify::new(),
                    reasons: AtomicU8::new(0),
                    waiting: AtomicUsize::new(0),
                })
            })
            .clone();
        Ok(actor)
    }

    /// Wake the account worker for `reason` without taking the account.
    pub(crate) fn request(&self, account_id: &str, reason: u8) -> Result<(), String> {
        self.actor(account_id)?.request(reason);
        Ok(())
    }

    /// Take the account for a user action, interrupting IDLE and preempting
    /// background sync at its next yield point.
    async fn lock_account(&self, account_id: &str) -> Result<OwnedMutexGuard<()>, String> {
        let actor = self.actor(account_id)?;
        actor.request(wake::OPERATION);
        Ok(actor.acquire().await)
    }

    pub fn ensure_watcher(&self, account_id: String, app: AppHandle) -> Result<(), String> {
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "Account watcher is unavailable.".to_string())?;
        if !watchers.insert(account_id.clone()) {
            return Ok(());
        }
        let first_watcher = watchers.len() == 1;
        drop(watchers);
        if first_watcher {
            self.begin_background_activity();
        }
        tauri::async_runtime::spawn(async move {
            run_account_worker(&account_id, &app).await;
            let state = app.state::<AppState>();
            if let Ok(mut watchers) = state.watchers.lock() {
                watchers.remove(&account_id);
                if watchers.is_empty() {
                    drop(watchers);
                    state.end_background_activity();
                }
            };
        });
        Ok(())
    }

    fn begin_background_activity(&self) {
        if let Ok(mut guard) = self.app_nap.lock() {
            if guard.is_none() {
                *guard = Some(crate::app_nap::AppNapGuard::begin(
                    "Postal Snap is keeping mail in sync",
                ));
            }
        }
    }

    fn end_background_activity(&self) {
        if let Ok(mut guard) = self.app_nap.lock() {
            guard.take();
        }
    }

    fn retire_actor(&self, account_id: &str) {
        let retired = self
            .account_actors
            .lock()
            .ok()
            .and_then(|mut actors| actors.remove(account_id));
        mail::pool::forget(account_id);
        // Wake a parked or idle worker so it notices the removal and exits.
        if let Some(actor) = retired {
            actor.request(wake::SYNC);
        }
    }
}

fn reconnect_delay(account_id: &str, seconds: u64, attempt: u32) -> Duration {
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

/// Long-lived loop for one account: sync passes, targeted jobs, IDLE, and
/// the outbox timer. Exits when the account is removed.
async fn run_account_worker(account_id: &str, app: &AppHandle) {
    let mut backoff = 2u64;
    let mut attempt = 0u32;
    let mut first_pass = true;
    let mut parked = false;
    let mut pending_full = true;
    let mut more_work = false;
    loop {
        let state = app.state::<AppState>();
        let Ok(actor) = state.actor(account_id) else {
            break;
        };
        let reasons = actor.take_reasons();
        if parked {
            if reasons & (wake::CREDENTIALS | wake::SYNC | wake::RESUME) == 0 {
                actor.wake.notified().await;
                continue;
            }
            parked = false;
        }
        if reasons & (wake::SYNC | wake::POLICY | wake::CREDENTIALS) != 0 {
            pending_full = true;
        }
        let guard = actor.acquire().await;
        if pending_full || more_work {
            let previous_message_id = state
                .db
                .latest_inbox_message(account_id)
                .ok()
                .flatten()
                .map(|message| message.id);
            match sync::run_sync_pass(account_id, app, &state, &actor, guard).await {
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
                        _ = wait_for(&actor, wake::SYNC | wake::CREDENTIALS) => {},
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
                continue;
            }
            continue;
        }
        if reasons & (wake::DRAFTS | wake::OUTBOX) != 0 {
            sync::run_targeted_jobs(account_id, app, &state, reasons).await;
        }
        let Ok(account) = state.db.account(account_id) else {
            break;
        };
        let Ok(password) = credentials::load(account_id) else {
            drop(guard);
            let detail =
                "The saved password is unavailable. Update the password in Settings > Accounts.";
            // A locked vault can unlock later (for example after sign-in on
            // macOS), so retry with backoff instead of parking.
            let _ = state
                .db
                .set_account_state(account_id, "offline", Some(detail));
            emit_sync(app, account_id, "offline", Some(detail), None);
            tokio::select! {
                _ = tokio::time::sleep(reconnect_delay(account_id, backoff, attempt)) => {},
                _ = wait_for(&actor, wake::SYNC | wake::CREDENTIALS) => {},
            }
            backoff = (backoff * 2).min(120);
            attempt = attempt.wrapping_add(1);
            continue;
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
        let next_job = [next_send, drafts_pending.then_some(DRAFT_PUSH_DELAY)]
            .into_iter()
            .flatten()
            .min();
        let limit = next_job.map_or(IDLE_REFRESH, |due| {
            due.max(Duration::from_millis(200)).min(IDLE_REFRESH)
        });
        let job_due_first = next_job.is_some_and(|due| due < IDLE_REFRESH);
        match mail::idle_inbox(&account, &password, &actor.wake, limit).await {
            Ok(mail::IdleOutcome::Changed) => pending_full = true,
            Ok(mail::IdleOutcome::Timeout) if job_due_first => {
                let mut jobs = 0;
                if next_send.is_some_and(|due| due <= limit) {
                    jobs |= wake::OUTBOX;
                }
                if drafts_pending {
                    jobs |= wake::DRAFTS;
                }
                actor.reasons.fetch_or(jobs, Ordering::SeqCst);
            }
            Ok(mail::IdleOutcome::Timeout) => pending_full = true,
            Ok(mail::IdleOutcome::Interrupted) => {}
            Err(_) => {
                drop(guard);
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
                    _ = wait_for(&actor, wake::SYNC | wake::CREDENTIALS) => {},
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
async fn wait_for(actor: &AccountActor, mask: u8) {
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
    Move(MoveOperation),
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
        _ => Ok(ValidatedReplay::Drop),
    }
}

async fn replay_offline_operations(
    app: &AppHandle,
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
) -> Result<bool, String> {
    let account_id = &account.summary.id;
    let mut dropped = 0u32;
    for (id, kind, payload) in db.queued_operations(account_id)? {
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
                // Initial sync restored server flags and reset local count
                // overlays. Reapply user's queued intent whether remote
                // replay succeeds now or remains queued.
                db.set_flags(
                    operation.message_id,
                    operation.is_read,
                    operation.is_starred,
                )?;
                if let Err(error) = &result {
                    if error.terminal {
                        db.remove_operation(account_id, id)?;
                        dropped = dropped.saturating_add(1);
                    }
                    continue;
                }
            }
            ValidatedReplay::Move(operation) => {
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
                    },
                )
                .await;
                match result {
                    Ok(()) => {
                        db.remove_message(operation.message_id)?;
                        let _ = mail::refresh_mailbox_envelopes(
                            account,
                            password,
                            &operation.destination,
                            db,
                            policy,
                        )
                        .await;
                    }
                    Err(error) => {
                        if error.terminal {
                            let _ = db.clear_pending_move(operation.message_id);
                            db.remove_operation(account_id, id)?;
                            dropped = dropped.saturating_add(1);
                        }
                        // Transient failure: keep the queued op and the
                        // pending-move hiding so a later sync retries it.
                        continue;
                    }
                }
            }
        }
        db.remove_operation(account_id, id)?;
    }
    if dropped > 0 {
        let _ = app.emit(
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

pub(crate) async fn cleanup_orphaned_account_dirs(root: PathBuf, active_account_ids: Vec<String>) {
    let active_account_ids = active_account_ids.into_iter().collect::<HashSet<_>>();
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
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
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
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

/// Sync stores rows with rising ids, so only a row newer than the previous
/// newest counts. An older row surfacing after the newest was removed
/// elsewhere is not new mail.
fn is_new_mail(previous_message_id: Option<i64>, message_id: i64, is_read: bool) -> bool {
    !is_read && previous_message_id.is_none_or(|previous| message_id > previous)
}

fn notify_new_mail(
    app: &AppHandle,
    db: &Database,
    account_id: &str,
    previous_message_id: Option<i64>,
) {
    let Ok(Some(message)) = db.latest_inbox_message(account_id) else {
        return;
    };
    if !is_new_mail(previous_message_id, message.id, message.is_read) {
        return;
    }
    let settings = app.state::<AppState>().settings.get().ok();
    if settings
        .as_ref()
        .is_some_and(|settings| !settings.notify_new_mail)
    {
        return;
    }
    let private = settings
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
                || "New mail".to_string(),
                |name| format!("New mail for {name}"),
            ),
            "Open Postal Snap to read it.".to_string(),
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
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(test)]
mod tests {
    use super::{
        attachments::preview_text, drafts_send::resolve_requested_send_at, is_new_mail,
        sync::apply_filter_rules,
    };
    use super::{cleanup_orphaned_account_dirs, take_normalized_account_password};

    #[test]
    fn outbox_keeps_the_unsigned_draft_for_undo() {
        use super::drafts_send::sign_for_outbox;
        let draft = crate::models::ComposeDraft {
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
        let (stored, signed) = sign_for_outbox(draft, "Sam");
        assert_eq!(stored.text_body, "Hello");
        assert!(signed.text_body.ends_with("\n\n-- \nSam"));
        // Undo returns `stored`; sending it again signs exactly once.
        let (mut restored, _) = sign_for_outbox(stored, "Sam");
        restored.text_body.push_str(" and more");
        let (_, resent) = sign_for_outbox(restored, "Sam");
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
    fn only_newer_unread_inbox_mail_is_new() {
        // Rows get higher ids as sync stores them; an older row surfacing
        // after the newest was removed elsewhere is not new mail.
        assert!(is_new_mail(None, 7, false));
        assert!(is_new_mail(Some(6), 7, false));
        assert!(!is_new_mail(Some(7), 7, false));
        assert!(!is_new_mail(Some(9), 7, false));
        assert!(!is_new_mail(Some(6), 7, true));
    }
    use crate::db::{CachedMessage, Database};
    use crate::models::{
        AccountRecord, AccountSummary, FilterRule, MailboxRole, ProviderKind, ServerConfig, TlsMode,
    };

    fn rule_account() -> AccountRecord {
        AccountRecord {
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
                color: None,
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
            reply_to: None,
            thread_parent: None,
            text_body: "Pay by Friday".into(),
            html_body: None,
            attachments: vec![],
            raw_message: b"Subject: Power bill\r\n\r\nPay by Friday".to_vec(),
            has_attachments: false,
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
    fn update_password_keeps_the_normalized_secret() {
        let secret = take_normalized_account_password(
            &ProviderKind::Icloud,
            zeroize::Zeroizing::new("  family-secret  ".into()),
        )
        .expect("normalized password");
        assert_eq!(secret.as_str(), "family-secret");
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

        cleanup_orphaned_account_dirs(root.path().to_path_buf(), vec![active.clone()]).await;

        assert!(root.path().join(active).is_dir());
        assert!(!root.path().join(orphaned).exists());
        assert!(root.path().join(unrelated).is_dir());
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
}
