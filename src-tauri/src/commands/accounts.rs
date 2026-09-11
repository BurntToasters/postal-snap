use tauri::{AppHandle, State};
use zeroize::Zeroizing;

use super::sync::sync_one;
use super::{
    command_result, managed_account_dir, refresh_mail_menu, take_normalized_account_password,
    AppState, CommandResult,
};
use crate::{
    credentials, mail,
    models::{
        take_validated_setup, AccountInboxCount, AccountRecord, AccountRemovalOutcome,
        AccountSetupRequest, AccountSummary, AppSettings, ProviderKind,
    },
};

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
pub async fn update_account_password(
    account_id: String,
    password: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    let _guard = state.lock_account(&account_id).await?;
    let password = Zeroizing::new(password);
    let account = state.db.account(&account_id)?;
    if account.summary.auth_method != "password" {
        return Err("This account signs in without a password. Reconnect it instead.".into());
    }
    let normalized =
        take_normalized_account_password(&account.summary.provider, password.to_string())?;
    let (imap, smtp) = mail::test_account(
        &AccountSetupRequest {
            provider: account.summary.provider.clone(),
            email: account.summary.email.clone(),
            display_name: account.summary.display_name.clone(),
            password: String::new(),
            imap: None,
            smtp: None,
        },
        &account.imap,
        &account.smtp,
        &normalized,
    )
    .await?;
    state.db.update_account_servers(&account_id, &imap, &smtp)?;
    credentials::store(&account_id, &normalized)?;
    state.db.set_account_state(&account_id, "idle", None)?;
    drop(_guard);
    let _ = sync_one(&account_id, &app, &state).await;
    let summary = state
        .db
        .list_accounts()?
        .into_iter()
        .find(|summary| summary.id == account_id)
        .ok_or_else(|| "Account not found.".to_string())?;
    Ok(summary)
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
    let mut aliases = Vec::new();
    if request.provider == ProviderKind::Icloud {
        if let Ok(found) = mail::discover_icloud_aliases(&request.email, &password).await {
            aliases = found;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let summary = AccountSummary {
        id: id.clone(),
        provider: request.provider.clone(),
        email: request.email.trim().to_lowercase(),
        display_name: request.display_name.trim().to_string(),
        sync_state: "idle".into(),
        error: None,
        aliases,
        auth_method: "password".into(),
        signature: String::new(),
    };
    if state.db.email_taken(&summary.email)? {
        return Err("An account with this email address is already set up.".into());
    }
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
    refresh_mail_menu(&app, &state);
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
    command_result(remove_single_account(&app, &state, &account_id).await)
}

/// Remove every account, vault secret, and cached attachment, then restore
/// factory settings (including an unfinished first-run) so a restart lands
/// back on setup. Continues past a single-account failure so one stuck
/// account cannot block the erase; the first error is reported afterwards.
#[tauri::command]
pub async fn erase_all_data(app: AppHandle, state: State<'_, AppState>) -> CommandResult<u32> {
    let ids: Vec<String> = state
        .db
        .list_accounts()?
        .iter()
        .map(|account| account.id.clone())
        .collect();
    let mut removed = 0u32;
    let mut first_error: Option<String> = None;
    for account_id in &ids {
        match remove_single_account(&app, &state, account_id).await {
            Ok(_) => removed += 1,
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    state.settings.save(AppSettings::default())?;
    refresh_mail_menu(&app, &state);
    if let Some(error) = first_error {
        return command_result(Err(error));
    }
    Ok(removed)
}

async fn remove_single_account(
    app: &AppHandle,
    state: &State<'_, AppState>,
    account_id: &str,
) -> Result<AccountRemovalOutcome, String> {
    let attachment_dir = managed_account_dir(&state.attachment_dir, account_id)?;
    state.db.account(account_id)?;
    let guard = state.lock_account(account_id).await?;
    // Recheck after waiting for another account operation so a concurrent
    // removal can never reach the credential vault twice.
    if let Err(error) = state.db.account(account_id) {
        drop(guard);
        state.retire_actor(account_id);
        return Err(error);
    }
    // Keep a zeroized copy so a database failure can restore the vault entry;
    // account deletion is treated as one user-visible transaction.
    let password = credentials::load_for_removal(account_id)?;
    credentials::remove(account_id)?;
    let _ = crate::oauth::remove_tokens(account_id);
    if let Err(error) = state.db.remove_account(account_id) {
        if password
            .as_deref()
            .is_some_and(|password| credentials::store(account_id, password).is_err())
        {
            return Err(
                "Postal Snap could not finish removing this account. Contact support before trying again."
                    .into(),
            );
        }
        return Err(error);
    }
    // Removal has committed; a count failure must not turn it into a reported
    // command failure. Disable mail actions rather than allowing commands with
    // unknown ownership.
    refresh_mail_menu(app, state);
    let cleanup_pending =
        attachment_dir.exists() && tokio::fs::remove_dir_all(attachment_dir).await.is_err();
    drop(guard);
    state.retire_actor(account_id);
    Ok(AccountRemovalOutcome { cleanup_pending })
}

#[tauri::command]
pub async fn discover_account_aliases(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    let account = state.db.account(&account_id)?;
    if account.summary.provider != ProviderKind::Icloud {
        return Ok(account.summary);
    }
    let password = credentials::load(&account_id)?;
    let discovered = mail::discover_icloud_aliases(&account.summary.email, &password).await?;
    let mut updated_aliases = account.summary.aliases.clone();
    for alias in discovered {
        if !updated_aliases.contains(&alias) {
            updated_aliases.push(alias);
        }
    }
    let updated = state
        .db
        .update_account_aliases(&account_id, &updated_aliases)?;
    Ok(updated)
}

#[tauri::command]
pub fn update_account_aliases(
    account_id: String,
    aliases: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    state.db.account(&account_id)?;
    let mut clean_aliases = Vec::new();
    for alias in aliases {
        let trimmed = alias.trim().to_lowercase();
        if trimmed.is_empty() || trimmed.len() > 320 || trimmed.contains(char::is_control) {
            return Err("One of the alias addresses is invalid.".into());
        }
        if trimmed.parse::<lettre::message::Mailbox>().is_err() {
            return Err("One of the alias addresses is invalid.".into());
        }
        if !clean_aliases.contains(&trimmed) {
            clean_aliases.push(trimmed);
        }
    }
    let updated = state
        .db
        .update_account_aliases(&account_id, &clean_aliases)?;
    Ok(updated)
}

#[tauri::command]
pub fn update_account_display_name(
    account_id: String,
    display_name: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let trimmed = display_name.trim();
    if trimmed.is_empty() || trimmed.len() > 120 || trimmed.contains(char::is_control) {
        return Err("Account name is invalid.".into());
    }
    state.db.account(&account_id)?;
    command_result(state.db.update_account_display_name(&account_id, trimmed))
}

#[tauri::command]
pub fn update_account_signature(
    account_id: String,
    signature: String,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    command_result(state.db.update_account_signature(&account_id, &signature))
}

#[tauri::command]
pub fn get_account_inbox_counts(
    state: State<'_, AppState>,
) -> CommandResult<Vec<AccountInboxCount>> {
    command_result(state.db.list_account_inbox_counts())
}
