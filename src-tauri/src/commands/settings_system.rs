use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::{command_result, refresh_mail_menu, AppState, CommandResult};
use crate::models::{AppSettings, CacheUsage, DistributionChannel};

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CommandResult<AppSettings> {
    command_result(state.settings.get())
}

#[tauri::command]
pub fn save_settings(
    settings: AppSettings,
    confirm_token: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<AppSettings> {
    let current = state.settings.get()?;
    crate::settings::require_threat_off_confirm(&current, &settings, confirm_token.as_deref())?;
    command_result(state.settings.save(settings))
}

#[tauri::command]
pub fn set_mail_shortcut_guard(
    guarded: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.set_mail_shortcut_guard(guarded);
    refresh_mail_menu(&app, &state);
    Ok(())
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

fn check_native_dialog_text(title: &str, message: &str) -> Result<(), String> {
    if title.len() > 120 || message.len() > 2000 {
        return Err("Dialog text is too long.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn show_native_confirm(app: AppHandle, title: String, message: String) -> CommandResult<bool> {
    check_native_dialog_text(&title, &message)?;
    let confirmed = app
        .dialog()
        .message(message)
        .title(title)
        .kind(tauri_plugin_dialog::MessageDialogKind::Info)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .blocking_show();
    Ok(confirmed)
}

#[tauri::command]
pub fn show_native_message(app: AppHandle, title: String, message: String) -> CommandResult<()> {
    check_native_dialog_text(&title, &message)?;
    app.dialog()
        .message(message)
        .title(title)
        .kind(tauri_plugin_dialog::MessageDialogKind::Info)
        .blocking_show();
    Ok(())
}

#[tauri::command]
pub fn relaunch_app(app: AppHandle) -> CommandResult<()> {
    app.restart();
}
