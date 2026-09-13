use tauri::{AppHandle, State};

use super::sync::sync_one;
use super::{command_result, AppState, CommandResult};
use crate::{
    credentials, mail,
    models::{validate_folder_name, MailboxRole, RecipientSuggestion},
};

#[tauri::command]
pub fn suggest_recipients(
    account_id: String,
    prefix: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<RecipientSuggestion>> {
    state.db.account(&account_id)?;
    command_result(
        state
            .db
            .suggest_recipients(&account_id, &prefix, limit.unwrap_or(8)),
    )
}

pub(crate) fn folder_role(
    state: &AppState,
    account_id: &str,
    mailbox_id: i64,
) -> Result<MailboxRole, String> {
    let (owner, _) = state.db.mailbox(mailbox_id)?;
    if owner != account_id {
        return Err("Folder does not belong to this account.".into());
    }
    let role = state
        .db
        .list_mailboxes(account_id)?
        .into_iter()
        .find(|mailbox| mailbox.id == mailbox_id)
        .map(|mailbox| mailbox.role)
        .ok_or_else(|| "That folder is no longer available.".to_string())?;
    Ok(role)
}

#[tauri::command]
pub async fn create_folder(
    account_id: String,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let name = validate_folder_name(&name)?;
    let _guard = state.lock_account(&account_id).await?;
    let account = state.db.account(&account_id)?;
    let password = credentials::load(&account_id)?;
    let result = mail::create_folder(&account, &password, &name).await;
    drop(_guard);
    command_result(result)?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn rename_folder(
    account_id: String,
    mailbox_id: i64,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let name = validate_folder_name(&name)?;
    if state.db.mailbox(mailbox_id)?.0 != account_id {
        return Err("Folder does not belong to this account.".into());
    }
    if folder_role(&state, &account_id, mailbox_id)? != MailboxRole::Other {
        return Err("Only personal folders can be renamed.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (_, old_name) = state.db.mailbox(mailbox_id)?;
    if old_name.eq_ignore_ascii_case(&name) {
        return Ok(());
    }
    let account = state.db.account(&account_id)?;
    let password = credentials::load(&account_id)?;
    let result = mail::rename_folder(&account, &password, &old_name, &name).await;
    if result.is_ok() {
        state
            .db
            .rename_mailbox_local(&account_id, &old_name, &name)?;
    }
    drop(_guard);
    command_result(result)?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn delete_folder(
    account_id: String,
    mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    if state.db.mailbox(mailbox_id)?.0 != account_id {
        return Err("Folder does not belong to this account.".into());
    }
    if folder_role(&state, &account_id, mailbox_id)? != MailboxRole::Other {
        return Err("Only personal folders can be deleted.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (_, name) = state.db.mailbox(mailbox_id)?;
    let account = state.db.account(&account_id)?;
    let password = credentials::load(&account_id)?;
    let result = mail::delete_folder(&account, &password, &name).await;
    drop(_guard);
    command_result(result)?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn empty_trash(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    empty_role_folder(
        account_id,
        "trash",
        "This account does not have a trash mailbox.",
        app,
        state,
    )
    .await
}

#[tauri::command]
pub async fn empty_junk(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    empty_role_folder(
        account_id,
        "junk",
        "This account does not have a junk mailbox.",
        app,
        state,
    )
    .await
}

async fn empty_role_folder(
    account_id: String,
    role: &str,
    missing: &str,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let (folder_id, name) = state
        .db
        .mailbox_for_role(&account_id, role)?
        .ok_or_else(|| missing.to_string())?;
    let _guard = state.lock_account(&account_id).await?;
    let account = state.db.account(&account_id)?;
    let password = credentials::load(&account_id)?;
    let validity = state
        .db
        .mailbox_uid_validity(&account_id, &name)?
        .ok_or_else(|| {
            "Mailbox identity is unavailable; refresh mail and try again.".to_string()
        })?;
    let protected = state.db.pending_move_uids(folder_id).unwrap_or_default();
    let result = mail::empty_folder(&account, &password, &name, Some(validity), &protected).await;
    drop(_guard);
    command_result(result)?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}
