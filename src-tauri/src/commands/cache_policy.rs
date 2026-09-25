use tauri::{AppHandle, State};

use super::sync::{account_policy, emit_progress};
use super::{command_result, wake, AppState, CommandResult};
use crate::models::{CachePolicy, CacheUsage, SyncProgress};

#[tauri::command]
pub fn get_account_cache_policy(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<CachePolicy> {
    command_result(account_policy(&state, &account_id))
}

/// Store a per-account download policy. A wider policy resumes backfill that
/// stopped at the old cutoff; a narrower one evicts bodies right away. Either
/// way the worker runs a pass so the change takes effect without waiting.
#[tauri::command]
pub async fn set_account_cache_policy(
    account_id: String,
    policy: CachePolicy,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<CachePolicy> {
    if !policy.is_valid() {
        return Err("Choose a valid download setting.".into());
    }
    let default = state.settings.get()?.cache_policy;
    state
        .db
        .set_account_cache_policy(&account_id, &policy, &default)?;
    let db = state.db.clone();
    let owner = account_id.clone();
    let evict = policy.clone();
    tauri::async_runtime::spawn_blocking(move || db.evict_account_to_policy(&owner, &evict))
        .await
        .map_err(|_| "Postal Snap could not apply the download setting.".to_string())??;
    state.request(&account_id, wake::POLICY)?;
    emit_progress(&app, &state.db, &account_id, &policy, None);
    Ok(policy)
}

#[tauri::command]
pub fn get_account_cache_usage(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<CacheUsage> {
    let policy = account_policy(&state, &account_id)?;
    command_result(state.db.account_cache_usage(&account_id, policy.max_bytes))
}

#[tauri::command]
pub async fn clear_account_downloads(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    let db = state.db.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || db.clear_account_downloads(&account_id))
            .await
            .map_err(|_| "Postal Snap could not clear downloaded mail.".to_string())?;
    command_result(result)
}

#[tauri::command]
pub fn get_sync_progress(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<SyncProgress> {
    let policy = account_policy(&state, &account_id)?;
    command_result(state.db.account_sync_progress(&account_id, &policy))
}
