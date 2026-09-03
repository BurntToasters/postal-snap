use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard};
use zeroize::Zeroizing;

use crate::{
    credentials,
    db::Database,
    mail,
    models::{
        take_validated_setup, validate_compose_draft, AccountRecord, AccountRemovalOutcome,
        AccountSetupRequest, AccountSummary, AppSettings, CacheUsage, ComposeAttachment,
        ComposeDraft, DistributionChannel, DraftSaveOutcome, DraftSummary, IpcError,
        MailboxSummary, MessageCursor, MessageDetail, MessagePage, MessageSummary, OutboxSummary,
        SearchQuery, SendOutcome, SyncState,
    },
    security,
    settings::SettingsStore,
};

type CommandResult<T> = Result<T, IpcError>;

fn command_result<T>(result: Result<T, String>) -> CommandResult<T> {
    result.map_err(Into::into)
}

pub struct AppState {
    pub db: Database,
    pub settings: SettingsStore,
    attachment_dir: PathBuf,
    account_actors: Mutex<HashMap<String, Arc<AccountActor>>>,
    watchers: Mutex<HashSet<String>>,
    startup_error: Mutex<Option<String>>,
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

    fn actor(&self, account_id: &str) -> Result<Arc<AccountActor>, String> {
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

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> CommandResult<Vec<AccountSummary>> {
    command_result(state.db.list_accounts())
}

#[tauri::command]
pub async fn test_account(mut request: AccountSetupRequest) -> CommandResult<()> {
    let (imap, smtp, password) = take_validated_setup(&mut request)?;
    let password = Zeroizing::new(password);
    mail::test_account(&request, &imap, &smtp, &password).await?;
    Ok(())
}

#[tauri::command]
pub async fn add_account(
    mut request: AccountSetupRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    let (imap, smtp, password) = take_validated_setup(&mut request)?;
    let password = Zeroizing::new(password);
    let (imap, smtp) = mail::test_account(&request, &imap, &smtp, &password).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let summary = AccountSummary {
        id: id.clone(),
        provider: request.provider.clone(),
        email: request.email.trim().to_lowercase(),
        display_name: request.display_name.trim().to_string(),
        sync_state: "idle".into(),
        error: None,
    };
    let account = AccountRecord {
        summary: summary.clone(),
        imap,
        smtp,
    };
    credentials::store(&id, &password)?;
    if let Err(error) = state.db.insert_account(&account) {
        let _ = credentials::remove(&id);
        return Err(error.into());
    }
    crate::update_mail_menu_or_warn(&app, true);
    // The account is already durably saved. A transient watcher setup failure
    // must not make setup look unsuccessful or roll back the account.
    if state.ensure_watcher(id.clone(), app.clone()).is_err() {
        let _ = state.db.set_account_state(
            &id,
            "offline",
            Some("Background sync is unavailable. Use Get Mail to retry."),
        );
    }
    Ok(summary)
}

#[tauri::command]
pub async fn remove_account(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<AccountRemovalOutcome> {
    let attachment_dir = managed_account_dir(&state.attachment_dir, &account_id)?;
    state.db.account(&account_id)?;
    let guard = state.lock_account(&account_id).await?;
    // Recheck after waiting for another account operation so a concurrent
    // removal can never reach the credential vault twice.
    if let Err(error) = state.db.account(&account_id) {
        drop(guard);
        state.retire_actor(&account_id);
        return Err(error.into());
    }
    // Keep a zeroized copy so a database failure can restore the vault entry;
    // account deletion is treated as one user-visible transaction.
    let password = credentials::load_for_removal(&account_id)?;
    credentials::remove(&account_id)?;
    if let Err(error) = state.db.remove_account(&account_id) {
        if password
            .as_deref()
            .is_some_and(|password| credentials::store(&account_id, password).is_err())
        {
            return Err(
                "Postal Snap could not finish removing this account. Contact support before trying again."
                    .into(),
            );
        }
        return Err(error.into());
    }
    // Removal has committed; a count failure must not turn it into a reported
    // command failure. Disable mail actions rather than allowing commands with
    // unknown ownership.
    let account_count = state.db.account_count().unwrap_or(0);
    crate::update_mail_menu_or_warn(&app, crate::mail_actions_enabled(account_count));
    let cleanup_pending =
        attachment_dir.exists() && tokio::fs::remove_dir_all(attachment_dir).await.is_err();
    drop(guard);
    state.retire_actor(&account_id);
    Ok(AccountRemovalOutcome { cleanup_pending })
}

#[tauri::command]
pub fn list_mailboxes(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MailboxSummary>> {
    command_result(state.db.list_mailboxes(&account_id))
}

#[tauri::command]
pub async fn sync_account(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    command_result(sync_one(&account_id, &app, &state).await)
}

pub async fn sync_one(account_id: &str, app: &AppHandle, state: &AppState) -> Result<(), String> {
    let _guard = state.lock_account(account_id).await?;
    sync_one_locked(account_id, app, state).await
}

async fn sync_one_background(
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let _guard = state.lock_account_quiet(account_id).await?;
    sync_one_locked(account_id, app, state).await
}

async fn sync_one_locked(
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let account = state.db.account(account_id)?;
    let password = credentials::load(account_id)?;
    emit_sync(
        app,
        account_id,
        "connecting",
        Some("Connecting securely…"),
        None,
    );
    state.db.set_account_state(account_id, "syncing", None)?;
    emit_sync(app, account_id, "syncing", Some("Checking mail…"), None);
    let settings = state.settings.get()?;
    match mail::sync_account(&state.db, &account, &password, &settings.cache_policy).await {
        Ok(()) => {
            let pending_changes = replay_offline_operations(&state.db, &account, &password).await?;
            sync_drafts_locked(state, &account, &password).await;
            replay_outbox_locked(account_id, app, state).await;
            let now = chrono::Utc::now().to_rfc3339();
            state.db.set_account_state(account_id, "idle", None)?;
            emit_sync(
                app,
                account_id,
                "idle",
                Some(if pending_changes {
                    "Some changes are waiting to sync"
                } else {
                    "Mail is up to date"
                }),
                Some(now),
            );
            emit_folder_counts(app, account_id);
            emit_message_change(app, account_id, None, "synced");
            emit_draft_change(app, account_id, None, None);
            emit_outbox_change(app, account_id, None, None);
            Ok(())
        }
        Err(error) => {
            state.db.set_account_state(
                account_id,
                "offline",
                Some("Mail sync is temporarily unavailable."),
            )?;
            emit_sync(
                app,
                account_id,
                "offline",
                Some("Will try again automatically"),
                None,
            );
            Err(error)
        }
    }
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
        if existing
            .as_ref()
            .is_some_and(|(state, _)| state != "synced" && state != "conflict")
        {
            id = uuid::Uuid::new_v4().to_string();
            sync_state = "conflict";
            sync_detail = Some("Recovered server copy; your local changes were preserved.");
        } else if existing
            .as_ref()
            .is_some_and(|(_, local_revision)| *local_revision > revision)
        {
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
            id: Some(id.clone()),
            account_id: account_id.clone(),
            to: remote.to,
            cc: remote.cc,
            bcc: remote.bcc,
            subject: remote.subject,
            html_body: remote.html_body,
            text_body: remote.text_body,
            attachments,
            in_reply_to: remote.in_reply_to,
            references: remote.references,
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

async fn replay_outbox_locked(account_id: &str, app: &AppHandle, state: &AppState) {
    if let Ok(ids) = state
        .db
        .outbox_ids_in_state(account_id, &["sent_copy_pending"])
    {
        for id in ids {
            let _ = retry_sent_copy_locked(&id, account_id, app, state).await;
        }
    }
    if let Ok(ids) = state.db.outbox_ids_in_state(account_id, &["queued"]) {
        for id in ids {
            let _ = deliver_outbox_locked(&id, account_id, app, state).await;
        }
    }
}

#[tauri::command]
pub fn list_messages(
    account_id: String,
    mailbox_id: i64,
    cursor: Option<MessageCursor>,
    limit: u32,
    state: State<'_, AppState>,
) -> CommandResult<MessagePage> {
    let (owner, _) = state.db.mailbox(mailbox_id)?;
    if owner != account_id {
        return Err("Mailbox does not belong to this account.".into());
    }
    command_result(state.db.list_messages(mailbox_id, cursor.as_ref(), limit))
}

async fn ensure_message_content(
    account_id: &str,
    message_id: i64,
    state: &AppState,
) -> Result<(), String> {
    let (owner_id, ..) = state.db.message_fetch_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    if state.db.message_content_cached(message_id, account_id)? {
        return Ok(());
    }
    let _guard = state.lock_account(account_id).await?;
    let (owner_id, mailbox_id, mailbox, uid, size) = state.db.message_fetch_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    if state.db.message_content_cached(message_id, account_id)? {
        return Ok(());
    }
    let uid_validity = state.db.mailbox_uid_validity(account_id, &mailbox)?;
    let account = state.db.account(account_id)?;
    let password = credentials::load(account_id)?;
    let message =
        mail::download_message(&account, &password, &mailbox, uid, size, uid_validity).await?;
    state.db.upsert_message(account_id, mailbox_id, &message)
}

#[tauri::command]
pub async fn get_message(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<MessageDetail> {
    ensure_message_content(&account_id, message_id, &state).await?;
    command_result(state.db.message_detail(message_id, &account_id))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FlagOperation {
    message_id: i64,
    uid: u32,
    mailbox: String,
    #[serde(default)]
    uid_validity: Option<u32>,
    is_read: Option<bool>,
    is_starred: Option<bool>,
}

#[tauri::command]
pub async fn set_message_flags(
    account_id: String,
    message_id: i64,
    is_read: Option<bool>,
    is_starred: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    let (owner_id, mailbox, uid) = state.db.message_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    state.db.set_flags(message_id, is_read, is_starred)?;
    let uid_validity = state.db.mailbox_uid_validity(&account_id, &mailbox)?;
    let operation = FlagOperation {
        message_id,
        uid,
        mailbox: mailbox.clone(),
        uid_validity,
        is_read,
        is_starred,
    };
    let remote_result = {
        let account = state.db.account(&account_id)?;
        let password = credentials::load(&account_id)?;
        mail::set_remote_flags(
            &account,
            &password,
            &mailbox,
            uid,
            uid_validity,
            is_read,
            is_starred,
        )
        .await
    };
    if remote_result.is_err() {
        let dedupe_key = format!(
            "flags:{message_id}:{}:{}",
            is_read.is_some(),
            is_starred.is_some()
        );
        state
            .db
            .queue_operation(&account_id, "flags", &operation, Some(&dedupe_key))?;
    }
    emit_message_change(&app, &account_id, Some(message_id), "flags");
    emit_folder_counts(&app, &account_id);
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveOperation {
    message_id: i64,
    uid: u32,
    source: String,
    destination: String,
    #[serde(default)]
    uid_validity: Option<u32>,
}

#[tauri::command]
pub async fn move_message(
    account_id: String,
    message_id: i64,
    role: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    if !matches!(role.as_str(), "archive" | "trash" | "junk") {
        return Err("Unsupported destination.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (owner_id, source, uid) = state.db.message_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    let (destination_id, destination) = state
        .db
        .mailbox_for_role(&account_id, &role)?
        .ok_or_else(|| format!("This account does not have a {role} mailbox."))?;
    if source == destination {
        return Ok(());
    }
    command_result(
        move_message_inner(
            message_id,
            account_id,
            source,
            uid,
            destination_id,
            destination,
            &app,
            &state,
        )
        .await,
    )
}

#[tauri::command]
pub async fn move_message_to_mailbox(
    account_id: String,
    message_id: i64,
    destination_mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    let (owner_id, source, uid) = state.db.message_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    let (destination_account_id, destination) = state.db.mailbox(destination_mailbox_id)?;
    if destination_account_id != account_id {
        return Err("Messages cannot be moved between accounts.".into());
    }
    if source == destination {
        return Ok(());
    }
    command_result(
        move_message_inner(
            message_id,
            account_id,
            source,
            uid,
            destination_mailbox_id,
            destination,
            &app,
            &state,
        )
        .await,
    )
}

#[allow(clippy::too_many_arguments)]
async fn move_message_inner(
    message_id: i64,
    account_id: String,
    source: String,
    uid: u32,
    destination_id: i64,
    destination: String,
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let operation = MoveOperation {
        message_id,
        uid,
        source: source.clone(),
        destination: destination.clone(),
        uid_validity: state.db.mailbox_uid_validity(&account_id, &source)?,
    };
    let remote_result = {
        let account = state.db.account(&account_id)?;
        let password = credentials::load(&account_id)?;
        mail::move_remote(
            &account,
            &password,
            &source,
            &destination,
            uid,
            operation.uid_validity,
        )
        .await
    };
    if remote_result.is_err() {
        let dedupe_key = format!("move:{message_id}");
        state
            .db
            .queue_operation(&account_id, "move", &operation, Some(&dedupe_key))?;
        state.db.mark_pending_move(message_id, destination_id)?;
    } else {
        // UIDs are scoped to a mailbox. Remove the old cached row and let the
        // destination mailbox sync discover the server-assigned UID.
        state.db.mark_pending_move(message_id, destination_id)?;
        state.db.remove_message(message_id)?;
    }
    emit_message_change(app, &account_id, Some(message_id), "moved");
    emit_folder_counts(app, &account_id);
    Ok(())
}

#[tauri::command]
pub fn search_cached_messages(
    query: SearchQuery,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MessageSummary>> {
    command_result(state.db.search(&query))
}

#[tauri::command]
pub async fn search_server_messages(
    query: SearchQuery,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MessageSummary>> {
    let _guard = state.lock_account(&query.account_id).await?;
    let account = state.db.account(&query.account_id)?;
    let password = credentials::load(&query.account_id)?;
    emit_sync(
        &app,
        &query.account_id,
        "syncing",
        Some("Searching the mail server…"),
        None,
    );
    match mail::server_search(&state.db, &account, &password, &query).await {
        Ok(results) => {
            emit_sync(
                &app,
                &query.account_id,
                "idle",
                Some("Search complete"),
                None,
            );
            Ok(results)
        }
        Err(error) => {
            emit_sync(
                &app,
                &query.account_id,
                "error",
                Some("Server search failed"),
                None,
            );
            Err(error.into())
        }
    }
}

#[tauri::command]
pub async fn save_draft(
    draft: ComposeDraft,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<DraftSaveOutcome> {
    state.db.account(&draft.account_id)?;
    validate_compose_draft(&draft)?;
    let id = state.db.save_draft(&draft)?;
    cleanup_unreferenced_attachments(&state, &draft.account_id).await;
    state.actor(&draft.account_id)?.wake.notify_one();
    emit_draft_change(&app, &draft.account_id, Some(&id), Some("localPending"));
    Ok(DraftSaveOutcome {
        id,
        sync_state: "localPending".into(),
    })
}

#[tauri::command]
pub fn list_drafts(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<DraftSummary>> {
    state.db.account(&account_id)?;
    command_result(state.db.list_drafts(&account_id))
}

#[tauri::command]
pub fn get_draft(
    draft_id: String,
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<ComposeDraft> {
    command_result(state.db.draft(&draft_id, &account_id))
}

#[tauri::command]
pub async fn delete_draft(
    draft_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let draft = state.db.draft(&draft_id, &account_id)?;
    state.db.remove_draft(&draft_id, &account_id)?;
    release_attachment_tokens(
        &state,
        &account_id,
        draft.attachments.iter().map(|item| item.token.as_str()),
    )
    .await;
    state.actor(&account_id)?.wake.notify_one();
    emit_draft_change(&app, &account_id, Some(&draft_id), Some("deletePending"));
    Ok(())
}

#[tauri::command]
pub async fn send_message(
    draft: ComposeDraft,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    let account = state.db.account(&draft.account_id)?;
    validate_compose_draft(&draft)?;
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err("Add at least one recipient.".into());
    }
    let resolved_draft = resolve_draft_files(&state.db, &draft)?;
    let prepared = mail::prepare_message(&account, &resolved_draft).await?;
    let offline = account.summary.sync_state == "offline";
    let initial_detail = offline.then_some("Waiting for a secure mail connection.");
    let outbox_id = state.db.queue_outbox(
        &draft,
        "queued",
        initial_detail,
        &prepared.message_id,
        &prepared.bytes,
    )?;
    if offline {
        state.actor(&draft.account_id)?.wake.notify_one();
        emit_outbox_change(&app, &draft.account_id, Some(&outbox_id), Some("queued"));
        return Ok(SendOutcome {
            id: outbox_id,
            state: "queued".into(),
            detail: initial_detail.map(Into::into),
        });
    }
    command_result(deliver_outbox(&outbox_id, &draft.account_id, &app, &state).await)
}

#[tauri::command]
pub fn list_outbox(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<OutboxSummary>> {
    state.db.account(&account_id)?;
    command_result(state.db.list_outbox(&account_id))
}

#[tauri::command]
pub fn get_outbox(
    outbox_id: String,
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<ComposeDraft> {
    command_result(
        state
            .db
            .outbox(&outbox_id, &account_id)
            .map(|(draft, _)| draft),
    )
}

#[tauri::command]
pub async fn delete_outbox(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let (draft, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    state
        .db
        .remove_outbox_for_account(&outbox_id, &account_id)?;
    if outbox_state == "sent_copy_pending" {
        if let Some(draft_id) = draft.id.as_deref() {
            state.db.remove_draft(draft_id, &account_id)?;
        }
    }
    release_attachment_tokens(
        &state,
        &account_id,
        draft.attachments.iter().map(|item| item.token.as_str()),
    )
    .await;
    emit_outbox_change(&app, &account_id, Some(&outbox_id), Some("removed"));
    Ok(())
}

#[tauri::command]
pub async fn retry_outbox(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    let (draft, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    validate_compose_draft(&draft)?;
    if outbox_state != "needs_attention" {
        return Err("Only messages needing attention can be retried.".into());
    }
    state.db.set_outbox_state(&outbox_id, "sending", None)?;
    command_result(deliver_outbox(&outbox_id, &draft.account_id, &app, &state).await)
}

#[tauri::command]
pub async fn retry_sent_copy(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    let (_, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    if outbox_state != "sent_copy_pending" {
        return Err("Only a pending Sent copy can be saved again.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    command_result(retry_sent_copy_locked(&outbox_id, &account_id, &app, &state).await)
}

async fn deliver_outbox(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<SendOutcome, String> {
    let _guard = match state.lock_account(account_id).await {
        Ok(guard) => guard,
        Err(error) => {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
    };
    deliver_outbox_locked(outbox_id, account_id, app, state).await
}

async fn deliver_outbox_locked(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<SendOutcome, String> {
    let (draft, state_name, mut message_id, mut mime_bytes) =
        match state.db.outbox_delivery(outbox_id, account_id) {
            Ok(value) => value,
            Err(error) => {
                return outbox_preparation_failed(outbox_id, account_id, app, state, error);
            }
        };
    if let Err(error) = validate_compose_draft(&draft) {
        return outbox_preparation_failed(outbox_id, account_id, app, state, error);
    }
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return outbox_preparation_failed(
            outbox_id,
            account_id,
            app,
            state,
            "Add at least one recipient.".into(),
        );
    }
    let account = match state.db.account(account_id) {
        Ok(account) => account,
        Err(error) => {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
    };
    if message_id.is_empty() || mime_bytes.is_empty() {
        if state_name != "queued" {
            return outbox_preparation_failed(
                outbox_id,
                account_id,
                app,
                state,
                "The uncertain message payload is unavailable.".into(),
            );
        }
        let resolved = match resolve_draft_files(&state.db, &draft) {
            Ok(draft) => draft,
            Err(error) => {
                return outbox_preparation_failed(outbox_id, account_id, app, state, error);
            }
        };
        let prepared = match mail::prepare_message(&account, &resolved).await {
            Ok(prepared) => prepared,
            Err(error) => {
                return outbox_preparation_failed(outbox_id, account_id, app, state, error);
            }
        };
        if let Err(error) = state.db.prepare_queued_outbox(
            outbox_id,
            account_id,
            &prepared.message_id,
            &prepared.bytes,
        ) {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
        message_id = prepared.message_id;
        mime_bytes = prepared.bytes;
    }
    let password = match credentials::load(account_id) {
        Ok(password) => password,
        Err(error) => {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
    };
    state.db.mark_outbox_attempt_started(outbox_id)?;
    let _ = app.emit(
        "send-progress",
        serde_json::json!({ "id": outbox_id, "accountId": account_id, "phase": "sending" }),
    );
    match mail::send_prepared(&account, &password, &draft, &mime_bytes).await {
        Ok(()) => {
            let sent_mailbox = state.db.mailbox_for_role(account_id, "sent")?;
            let copy_result = match sent_mailbox {
                Some((_, mailbox)) => {
                    mail::ensure_sent_copy(&account, &password, &mailbox, &message_id, &mime_bytes)
                        .await
                }
                None => Err("This account has no confirmed Sent mailbox.".into()),
            };
            if copy_result.is_err() {
                const DETAIL: &str =
                    "Message sent. Its Sent-folder copy is waiting for a safe retry.";
                state
                    .db
                    .set_outbox_state(outbox_id, "sent_copy_pending", Some(DETAIL))?;
                let _ = app.emit(
                    "send-result",
                    serde_json::json!({ "id": outbox_id, "accountId": account_id, "ok": true, "phase": "sentCopyPending", "detail": DETAIL }),
                );
                emit_outbox_change(app, account_id, Some(outbox_id), Some("sentCopyPending"));
                return Ok(SendOutcome {
                    id: outbox_id.to_string(),
                    state: "sentCopyPending".into(),
                    detail: Some(DETAIL.into()),
                });
            }
            state.db.remove_outbox(outbox_id)?;
            if let Some(draft_id) = draft.id.as_deref() {
                state.db.remove_draft(draft_id, account_id)?;
            }
            release_attachment_tokens(
                state,
                account_id,
                draft.attachments.iter().map(|item| item.token.as_str()),
            )
            .await;
            let _ = app.emit(
                "send-result",
                serde_json::json!({ "id": outbox_id, "accountId": account_id, "ok": true, "phase": "sent" }),
            );
            emit_outbox_change(app, account_id, Some(outbox_id), Some("sent"));
            Ok(SendOutcome {
                id: outbox_id.to_string(),
                state: "sent".into(),
                detail: None,
            })
        }
        Err(_) => {
            const DETAIL: &str =
                "Delivery could not be confirmed. Postal Snap will not resend automatically.";
            state
                .db
                .set_outbox_state(outbox_id, "needs_attention", Some(DETAIL))?;
            let _ = app.emit(
                "send-result",
                serde_json::json!({ "id": outbox_id, "accountId": account_id, "ok": false, "phase": "needsAttention", "detail": DETAIL }),
            );
            emit_outbox_change(app, account_id, Some(outbox_id), Some("needsAttention"));
            Ok(SendOutcome {
                id: outbox_id.to_string(),
                state: "needsAttention".into(),
                detail: Some(DETAIL.into()),
            })
        }
    }
}

async fn retry_sent_copy_locked(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<SendOutcome, String> {
    let (draft, state_name, message_id, mime_bytes) =
        state.db.outbox_delivery(outbox_id, account_id)?;
    if state_name != "sent_copy_pending" {
        return Err("Only a pending Sent copy can be saved again.".into());
    }
    let account = state.db.account(account_id)?;
    let password = credentials::load(account_id)?;
    let (_, mailbox) = state
        .db
        .mailbox_for_role(account_id, "sent")?
        .ok_or_else(|| "This account has no confirmed Sent mailbox.".to_string())?;
    mail::ensure_sent_copy(&account, &password, &mailbox, &message_id, &mime_bytes).await?;
    state.db.remove_outbox(outbox_id)?;
    if let Some(draft_id) = draft.id.as_deref() {
        state.db.remove_draft(draft_id, account_id)?;
    }
    release_attachment_tokens(
        state,
        account_id,
        draft.attachments.iter().map(|item| item.token.as_str()),
    )
    .await;
    emit_outbox_change(app, account_id, Some(outbox_id), Some("sent"));
    Ok(SendOutcome {
        id: outbox_id.into(),
        state: "sent".into(),
        detail: None,
    })
}

fn outbox_preparation_failed(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
    error: String,
) -> Result<SendOutcome, String> {
    const DETAIL: &str =
        "The message was not sent. Check its attachments and account, then try again.";
    state
        .db
        .set_outbox_state(outbox_id, "needs_attention", Some(DETAIL))?;
    let _ = app.emit(
        "send-result",
        serde_json::json!({
            "id": outbox_id,
            "accountId": account_id,
            "ok": false,
            "phase": "needsAttention",
            "detail": DETAIL,
        }),
    );
    emit_outbox_change(app, account_id, Some(outbox_id), Some("needsAttention"));
    Err(error)
}

#[tauri::command]
pub async fn save_attachment(
    account_id: String,
    message_id: i64,
    attachment_id: String,
    suggested_filename: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let destination = app
        .dialog()
        .file()
        .set_file_name(security::safe_filename(&suggested_filename))
        .blocking_save_file();
    let Some(destination) = destination else {
        return Ok(());
    };
    let destination = destination
        .into_path()
        .map_err(|_| "Choose a valid save location.".to_string())?;
    ensure_message_content(&account_id, message_id, &state).await?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    let (_, bytes) = mail::extract_attachment(&raw, &attachment_id)?;
    tokio::fs::write(destination, bytes)
        .await
        .map_err(|_| "Could not save the attachment at that location.".into())
}

#[tauri::command]
pub async fn prepare_forward_attachments(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ComposeAttachment>> {
    ensure_message_content(&account_id, message_id, &state).await?;
    let detail = state.db.message_detail(message_id, &account_id)?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    let account_dir = managed_account_dir(&state.attachment_dir, &account_id)?;
    tokio::fs::create_dir_all(&account_dir)
        .await
        .map_err(|_| "Could not create private draft storage.".to_string())?;
    let mut prepared = Vec::new();
    let mut created_tokens = Vec::new();
    let result = async {
        let mut total = 0usize;
        for attachment in detail.attachments.into_iter().filter(|item| !item.inline) {
            let (_, bytes) = mail::extract_attachment(&raw, &attachment.id)?;
            total = total.saturating_add(bytes.len());
            if total > mail::MAX_MESSAGE_BYTES {
                return Err("Forwarded attachments are too large to prepare safely.".into());
            }
            let token = write_managed_file(&state, &account_id, &account_dir, &bytes).await?;
            created_tokens.push(token.clone());
            prepared.push(ComposeAttachment {
                token,
                filename: attachment.filename,
                content_type: Some(attachment.content_type),
                inline: false,
                content_id: None,
                size: Some(bytes.len()),
            });
        }
        Ok(prepared)
    }
    .await;
    if result.is_err() {
        release_attachment_tokens(
            &state,
            &account_id,
            created_tokens.iter().map(String::as_str),
        )
        .await;
    }
    result
}

#[tauri::command]
pub async fn choose_attachments(
    account_id: String,
    inline: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ComposeAttachment>> {
    state.db.account(&account_id)?;
    let builder = app.dialog().file();
    let selected = if inline {
        builder
            .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
            .blocking_pick_file()
            .into_iter()
            .collect()
    } else {
        builder.blocking_pick_files().unwrap_or_default()
    };
    let account_dir = managed_account_dir(&state.attachment_dir, &account_id)?;
    tokio::fs::create_dir_all(&account_dir)
        .await
        .map_err(|_| "Could not create private draft storage.".to_string())?;
    #[cfg(unix)]
    tokio::fs::set_permissions(
        &account_dir,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .await
    .map_err(|_| "Could not secure private draft storage.".to_string())?;
    let mut attachments = Vec::new();
    let mut created_tokens = Vec::new();
    let result = async {
        if selected.len() > 100 {
            return Err("Choose no more than 100 attachments.".into());
        }
        let mut total = 0usize;
        for selected in selected {
            let path = selected
                .into_path()
                .map_err(|_| "That selected file is unavailable.".to_string())?;
            let metadata = tokio::fs::symlink_metadata(&path)
                .await
                .map_err(|_| "That selected file is unavailable.".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("That selected file is unavailable.".into());
            }
            if metadata.len() > mail::MAX_MESSAGE_BYTES as u64 {
                return Err("That attachment is too large.".into());
            }
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|_| "That selected file is unavailable.".to_string())?;
            total = total.saturating_add(bytes.len());
            if total > mail::MAX_OUTGOING_BYTES {
                return Err("The selected attachments are too large.".into());
            }
            let token = write_managed_file(&state, &account_id, &account_dir, &bytes).await?;
            created_tokens.push(token.clone());
            attachments.push(ComposeAttachment {
                token,
                filename: security::safe_filename(
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("attachment"),
                ),
                content_type: Some(
                    mime_guess::from_path(&path)
                        .first_or_octet_stream()
                        .to_string(),
                ),
                inline,
                content_id: None,
                size: Some(bytes.len()),
            });
        }
        Ok(attachments)
    }
    .await;
    if result.is_err() {
        release_attachment_tokens(
            &state,
            &account_id,
            created_tokens.iter().map(String::as_str),
        )
        .await;
    }
    result
}

#[tauri::command]
pub async fn fetch_remote_image(url: String) -> CommandResult<String> {
    command_result(security::fetch_public_image(&url).await)
}

#[tauri::command]
pub async fn read_message_inline_image(
    account_id: String,
    message_id: i64,
    attachment_id: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    ensure_message_content(&account_id, message_id, &state).await?;
    let detail = state.db.message_detail(message_id, &account_id)?;
    let attachment = detail
        .attachments
        .iter()
        .find(|item| item.id == attachment_id && item.inline && item.content_id.is_some())
        .ok_or_else(|| "Inline image not found.".to_string())?;
    if !matches!(
        attachment.content_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err("This inline image format is not supported.".into());
    }
    if attachment.size > 20 * 1024 * 1024 {
        return Err("This inline image is too large.".into());
    }
    let raw = state.db.raw_message(message_id, &account_id)?;
    let (_, bytes) = mail::extract_attachment(&raw, &attachment_id)?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("This inline image is too large.".into());
    }
    Ok(format!(
        "data:{};base64,{}",
        attachment.content_type,
        STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub async fn read_compose_image(
    token: String,
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let path = state.db.resolve_file(&token, &account_id)?;
    if !path.is_absolute() || !path.is_file() {
        return Err("Choose a valid image file.".into());
    }
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    if !matches!(
        mime.essence_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err("Choose a PNG, JPEG, GIF, or WebP image.".into());
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| "Could not read that image.".to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("That image is too large.".into());
    }
    Ok(format!(
        "data:{};base64,{}",
        mime.essence_str(),
        STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub async fn release_compose_attachments(
    account_id: String,
    tokens: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    release_attachment_tokens(&state, &account_id, tokens.iter().map(String::as_str)).await;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CommandResult<AppSettings> {
    command_result(state.settings.get())
}

#[tauri::command]
pub fn save_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> CommandResult<AppSettings> {
    command_result(state.settings.save(settings))
}

#[tauri::command]
pub fn export_settings(app: AppHandle, state: State<'_, AppState>) -> CommandResult<bool> {
    let destination = app
        .dialog()
        .file()
        .set_file_name("Postal Snap Settings.json")
        .add_filter("JSON settings", &["json"])
        .blocking_save_file();
    let Some(destination) = destination else {
        return Ok(false);
    };
    let destination = destination
        .into_path()
        .map_err(|_| "Choose a valid settings export location.".to_string())?;
    command_result(state.settings.export_to(&destination).map(|()| true))
}

#[tauri::command]
pub fn import_settings(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Option<AppSettings>> {
    let source = app
        .dialog()
        .file()
        .add_filter("JSON settings", &["json"])
        .blocking_pick_file();
    let Some(source) = source else {
        return Ok(None);
    };
    let source = source
        .into_path()
        .map_err(|_| "Choose a valid settings file.".to_string())?;
    command_result(state.settings.import_from(&source).map(Some))
}

#[tauri::command]
pub fn reset_settings(state: State<'_, AppState>) -> CommandResult<AppSettings> {
    command_result(state.settings.reset_preferences())
}

#[tauri::command]
pub fn get_startup_notice(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    command_result(state.settings.take_startup_notice())
}

#[tauri::command]
pub fn get_startup_error(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    command_result(state.take_startup_error())
}

#[tauri::command]
pub fn get_cache_usage(state: State<'_, AppState>) -> CommandResult<CacheUsage> {
    command_result(
        state
            .db
            .cache_usage(state.settings.get()?.cache_policy.max_bytes),
    )
}

#[tauri::command]
pub fn clear_downloaded_mail(state: State<'_, AppState>) -> CommandResult<()> {
    command_result(state.db.clear_downloaded_mail())
}

#[tauri::command]
pub fn get_distribution_channel() -> DistributionChannel {
    if cfg!(feature = "mas") {
        DistributionChannel {
            kind: "macAppStore".into(),
            updates_managed_by: "store".into(),
        }
    } else if cfg!(feature = "msstore") || std::env::var_os("APPX_PACKAGE_FAMILY_NAME").is_some() {
        DistributionChannel {
            kind: "microsoftStore".into(),
            updates_managed_by: "store".into(),
        }
    } else if cfg!(feature = "flatpak") || std::env::var_os("FLATPAK_ID").is_some() {
        DistributionChannel {
            kind: "flatpak".into(),
            updates_managed_by: "store".into(),
        }
    } else {
        DistributionChannel {
            kind: "direct".into(),
            updates_managed_by: "postalSnap".into(),
        }
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

fn emit_folder_counts(app: &AppHandle, account_id: &str) {
    let _ = app.emit(
        "folder-counts-changed",
        serde_json::json!({ "accountId": account_id }),
    );
}

fn emit_message_change(app: &AppHandle, account_id: &str, message_id: Option<i64>, kind: &str) {
    let _ = app.emit(
        "message-changed",
        serde_json::json!({
            "accountId": account_id,
            "messageId": message_id,
            "kind": kind,
        }),
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
        serde_json::json!({
            "accountId": account_id,
            "draftId": draft_id,
            "syncState": sync_state,
        }),
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
        serde_json::json!({
            "accountId": account_id,
            "outboxId": outbox_id,
            "state": state,
        }),
    );
}

async fn replay_offline_operations(
    db: &Database,
    account: &AccountRecord,
    password: &str,
) -> Result<bool, String> {
    let mut remote_available = true;
    for (id, kind, payload) in db.queued_operations(&account.summary.id)? {
        let result = match kind.as_str() {
            "flags" => match serde_json::from_str::<FlagOperation>(&payload) {
                Ok(operation) => {
                    let Ok((owner, mailbox, uid)) = db.message_location(operation.message_id)
                    else {
                        db.remove_operation(id)?;
                        continue;
                    };
                    if owner != account.summary.id
                        || mailbox != operation.mailbox
                        || uid != operation.uid
                    {
                        db.remove_operation(id)?;
                        continue;
                    }
                    if operation.uid_validity.is_some()
                        && db.mailbox_uid_validity(&account.summary.id, &operation.mailbox)?
                            != operation.uid_validity
                    {
                        db.remove_operation(id)?;
                        continue;
                    }
                    let result = if remote_available {
                        mail::set_remote_flags(
                            account,
                            password,
                            &operation.mailbox,
                            operation.uid,
                            operation.uid_validity,
                            operation.is_read,
                            operation.is_starred,
                        )
                        .await
                    } else {
                        Err("Offline changes remain queued.".into())
                    };
                    // Initial sync restored server flags and reset local count
                    // overlays. Reapply user's queued intent whether remote
                    // replay succeeds now or remains queued.
                    db.set_flags(
                        operation.message_id,
                        operation.is_read,
                        operation.is_starred,
                    )?;
                    result
                }
                Err(_) => {
                    db.remove_operation(id)?;
                    continue;
                }
            },
            "move" => match serde_json::from_str::<MoveOperation>(&payload) {
                Ok(operation) => {
                    let Ok((owner, source, uid)) = db.message_location(operation.message_id) else {
                        db.remove_operation(id)?;
                        continue;
                    };
                    if owner != account.summary.id
                        || source != operation.source
                        || uid != operation.uid
                    {
                        db.remove_operation(id)?;
                        continue;
                    }
                    if operation.source == operation.destination {
                        let _ = db.clear_pending_move(operation.message_id);
                        db.remove_operation(id)?;
                        continue;
                    }
                    db.apply_pending_move_overlay(operation.message_id)?;
                    if operation.uid_validity.is_some()
                        && db.mailbox_uid_validity(&account.summary.id, &operation.source)?
                            != operation.uid_validity
                    {
                        let _ = db.clear_pending_move(operation.message_id);
                        db.remove_operation(id)?;
                        continue;
                    }
                    let result = if remote_available {
                        mail::move_remote(
                            account,
                            password,
                            &operation.source,
                            &operation.destination,
                            operation.uid,
                            operation.uid_validity,
                        )
                        .await
                    } else {
                        Err("Offline changes remain queued.".into())
                    };
                    if result.is_ok() {
                        db.remove_message(operation.message_id)?;
                    }
                    result
                }
                Err(_) => {
                    db.remove_operation(id)?;
                    continue;
                }
            },
            _ => {
                db.remove_operation(id)?;
                continue;
            }
        };
        if result.is_err() {
            remote_available = false;
            continue;
        }
        db.remove_operation(id)?;
    }
    Ok(!db.queued_operations(&account.summary.id)?.is_empty())
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
    let private = app
        .state::<AppState>()
        .settings
        .get()
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
    let _ = app.emit(
        "notification-candidate",
        serde_json::json!({ "accountId": account_id, "messageId": message.id }),
    );
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(test)]
mod tests {
    use super::cleanup_orphaned_account_dirs;

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
}
