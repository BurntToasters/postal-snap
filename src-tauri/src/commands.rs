use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub mod accounts;
pub mod attachments;
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
use sync::sync_one_background;

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
}

struct AccountActor {
    operation: Arc<AsyncMutex<()>>,
    wake: Notify,
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

    fn actor(&self, account_id: &str) -> Result<Arc<AccountActor>, String> {
        // Validate before touching the map so arbitrary IDs cannot grow it.
        uuid::Uuid::parse_str(account_id).map_err(|_| "Account not found.".to_string())?;
        self.db.account(account_id)?;
        let actor = self
            .account_actors
            .lock()
            .map_err(|_| "Account worker is unavailable.".to_string())?
            .entry(account_id.to_string())
            .or_insert_with(|| {
                Arc::new(AccountActor {
                    operation: Arc::new(AsyncMutex::new(())),
                    wake: Notify::new(),
                })
            })
            .clone();
        Ok(actor)
    }

    async fn lock_account(&self, account_id: &str) -> Result<OwnedMutexGuard<()>, String> {
        let actor = self.actor(account_id)?;
        // notify_one stores a permit when IDLE is between setup and waiting,
        // avoiding a lost wake-up and a two-minute operation delay.
        actor.wake.notify_one();
        Ok(actor.operation.clone().lock_owned().await)
    }

    async fn lock_account_quiet(&self, account_id: &str) -> Result<OwnedMutexGuard<()>, String> {
        Ok(self.actor(account_id)?.operation.clone().lock_owned().await)
    }

    pub fn ensure_watcher(&self, account_id: String, app: AppHandle) -> Result<(), String> {
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "Account watcher is unavailable.".to_string())?;
        if !watchers.insert(account_id.clone()) {
            return Ok(());
        }
        drop(watchers);
        tauri::async_runtime::spawn(async move {
            let mut backoff = 2u64;
            let mut first_sync = true;
            loop {
                let state = app.state::<AppState>();
                if state.db.account(&account_id).is_err() {
                    break;
                }
                let previous_message_id = state
                    .db
                    .latest_inbox_message(&account_id)
                    .ok()
                    .flatten()
                    .map(|message| message.id);
                match sync_one_background(&account_id, &app, &state).await {
                    Ok(()) => {
                        if !first_sync {
                            notify_new_mail(&app, &state.db, &account_id, previous_message_id);
                        }
                        first_sync = false;
                    }
                    Err(_) => {
                        tokio::time::sleep(reconnect_delay(&account_id, backoff)).await;
                        backoff = (backoff * 2).min(120);
                        continue;
                    }
                }
                let actor = match state.actor(&account_id) {
                    Ok(actor) => actor,
                    Err(_) => break,
                };
                let _guard = actor.operation.lock().await;
                let account = match state.db.account(&account_id) {
                    Ok(account) => account,
                    Err(_) => break,
                };
                let password = match credentials::load(&account_id) {
                    Ok(password) => password,
                    Err(_) => break,
                };
                match mail::idle_inbox(&account, &password, &actor.wake).await {
                    Ok(()) => backoff = 2,
                    Err(_) => {
                        drop(_guard);
                        let _ = state.db.set_account_state(
                            &account_id,
                            "offline",
                            Some("Connection lost. Reconnecting…"),
                        );
                        emit_sync(
                            &app,
                            &account_id,
                            "offline",
                            Some("Connection lost. Reconnecting…"),
                            None,
                        );
                        tokio::time::sleep(reconnect_delay(&account_id, backoff)).await;
                        backoff = (backoff * 2).min(120);
                    }
                }
            }
            if let Ok(mut watchers) = app.state::<AppState>().watchers.lock() {
                watchers.remove(&account_id);
            }
        });
        Ok(())
    }

    fn retire_actor(&self, account_id: &str) {
        if let Ok(mut actors) = self.account_actors.lock() {
            actors.remove(account_id);
        }
    }
}

fn reconnect_delay(account_id: &str, seconds: u64) -> Duration {
    let jitter = account_id.bytes().fold(0u64, |value, byte| {
        value.wrapping_mul(31).wrapping_add(u64::from(byte))
    }) % 1_000;
    Duration::from_secs(seconds) + Duration::from_millis(jitter)
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
    db: &Database,
    account: &AccountRecord,
    password: &str,
    policy: &CachePolicy,
) -> Result<bool, String> {
    let account_id = &account.summary.id;
    for (id, kind, payload) in db.queued_operations(account_id)? {
        match validate_queued_operation(db, account_id, &kind, &payload)? {
            ValidatedReplay::Drop => {
                db.remove_operation(account_id, id)?;
                continue;
            }
            ValidatedReplay::ClearPending(message_id) => {
                let _ = db.clear_pending_move(message_id);
                db.remove_operation(account_id, id)?;
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
                    if is_terminal_mailbox_error(error) {
                        db.remove_operation(account_id, id)?;
                    }
                    continue;
                }
            }
            ValidatedReplay::Move(operation) => {
                let result = mail::move_remote(
                    account,
                    password,
                    &operation.source,
                    &operation.destination,
                    operation.uid,
                    operation.uid_validity,
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
                        if is_terminal_mailbox_error(&error) {
                            let _ = db.clear_pending_move(operation.message_id);
                            db.remove_operation(account_id, id)?;
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
    Ok(!db.queued_operations(account_id)?.is_empty())
}

fn is_terminal_mailbox_error(error: &str) -> bool {
    error.contains("mailbox changed")
        || error.contains("cannot safely move")
        || error.contains("does not belong")
        || error.contains("message missing")
        || error.contains("Message not found")
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

fn notify_new_mail(
    app: &AppHandle,
    db: &Database,
    account_id: &str,
    previous_message_id: Option<i64>,
) {
    let Ok(Some(message)) = db.latest_inbox_message(account_id) else {
        return;
    };
    if previous_message_id == Some(message.id) || message.is_read {
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
    let (title, body) = if private {
        (
            "New mail".to_string(),
            "Open Postal Snap to read it.".to_string(),
        )
    } else {
        (
            if message.sender_name.is_empty() {
                message.sender_address.clone()
            } else {
                message.sender_name.clone()
            },
            message.subject.clone(),
        )
    };
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(test)]
mod tests {
    use super::{
        attachments::preview_text, drafts_send::resolve_requested_send_at, sync::apply_filter_rules,
    };
    use super::{cleanup_orphaned_account_dirs, take_normalized_account_password};
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
        apply_filter_rules(&db, &account);
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
        apply_filter_rules(&db, &account);
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
        apply_filter_rules(&db, &account);
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
}
