use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use super::{command_result, AppState, CommandResult};
use crate::security;

fn protection_policy(state: &AppState) -> Result<security::ProtectionPolicy, String> {
    let settings = state.settings.get()?;
    Ok(security::ProtectionPolicy {
        block_advertising_and_tracking: settings.block_advertising_and_tracking,
        block_reported_threats: settings.block_reported_threats,
    })
}

#[tauri::command]
pub async fn fetch_remote_image(
    url: String,
    state: State<'_, AppState>,
) -> CommandResult<security::RemoteImageResult> {
    let policy = protection_policy(&state)?;
    command_result(security::fetch_public_image(&url, policy).await)
}

const APPLE_APP_PASSWORD_GUIDE: &str = "https://support.apple.com/102654";

#[tauri::command]
pub fn inspect_external_url(
    url: String,
    state: State<'_, AppState>,
) -> CommandResult<security::ExternalLinkCheck> {
    let policy = protection_policy(&state)?;
    command_result(security::inspect_external_link(&url, policy))
}

#[tauri::command]
pub fn open_external_url(
    app: AppHandle,
    url: String,
    open_anyway: Option<bool>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let policy = protection_policy(&state)?;
    let inspected = security::inspect_external_link(&url, policy)?;
    security::authorize_external_open(&inspected, open_anyway.unwrap_or(false))?;
    app.opener()
        .open_url(&inspected.url, None::<&str>)
        .map_err(|_| "Postal Snap could not open that link.".to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_help_url(app: AppHandle) -> CommandResult<()> {
    app.opener()
        .open_url(APPLE_APP_PASSWORD_GUIDE, None::<&str>)
        .map_err(|_| "Postal Snap could not open that help page.".to_string())?;
    Ok(())
}
