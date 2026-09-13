use std::path::Path;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::{command_result, refresh_mail_menu, AppState, CommandResult};
use crate::models::{
    AppSettings, CacheUsage, DistributionChannel, LicenseCredit, LicenseCredits, LicensePackage,
};

#[tauri::command(async)]
pub fn get_settings(state: State<'_, AppState>) -> CommandResult<AppSettings> {
    command_result(state.settings.get())
}

#[tauri::command(async)]
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
pub async fn export_settings(app: AppHandle, state: State<'_, AppState>) -> CommandResult<bool> {
    let picker = app.clone();
    let destination = tokio::task::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_file_name("Postal Snap Settings.json")
            .add_filter("JSON settings", &["json"])
            .blocking_save_file()
    })
    .await
    .map_err(|_| "Could not open the save dialog.".to_string())?;
    let Some(destination) = destination else {
        return Ok(false);
    };
    let destination = destination
        .into_path()
        .map_err(|_| "Choose a valid settings export location.".to_string())?;
    command_result(state.settings.export_to(&destination).map(|()| true))
}

#[tauri::command]
pub async fn import_settings(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Option<AppSettings>> {
    let picker = app.clone();
    let source = tokio::task::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .add_filter("JSON settings", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "Could not open the file dialog.".to_string())?;
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

#[tauri::command(async)]
pub fn get_cache_usage(state: State<'_, AppState>) -> CommandResult<CacheUsage> {
    command_result(
        state
            .db
            .cache_usage(state.settings.get()?.cache_policy.max_bytes),
    )
}

#[tauri::command(async)]
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
        // Sideloaded Flatpaks have no remote, so updates come from GitHub
        // Releases manually rather than a store.
        DistributionChannel {
            kind: "flatpak".into(),
            updates_managed_by: "githubDownload".into(),
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
pub async fn show_native_confirm(
    app: AppHandle,
    title: String,
    message: String,
) -> CommandResult<bool> {
    check_native_dialog_text(&title, &message)?;
    let dialog_app = app.clone();
    let confirmed = tokio::task::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(message)
            .title(title)
            .kind(tauri_plugin_dialog::MessageDialogKind::Info)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
            .blocking_show()
    })
    .await
    .map_err(|_| "Could not open the confirmation dialog.".to_string())?;
    Ok(confirmed)
}

#[tauri::command]
pub async fn show_native_message(
    app: AppHandle,
    title: String,
    message: String,
) -> CommandResult<()> {
    check_native_dialog_text(&title, &message)?;
    let dialog_app = app.clone();
    tokio::task::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(message)
            .title(title)
            .kind(tauri_plugin_dialog::MessageDialogKind::Info)
            .blocking_show();
    })
    .await
    .map_err(|_| "Could not open the message dialog.".to_string())?;
    Ok(())
}

#[tauri::command]
pub fn relaunch_app(app: AppHandle) -> CommandResult<()> {
    app.restart();
}

const MAX_LICENSE_NOTICE_BYTES: usize = 1_048_576;
const MAX_LICENSE_PACKAGE_BYTES: usize = 16_777_216;
const LICENSE_NOTICE_FILES: &[(&str, &str, &str)] = &[
    ("mpl", "Mozilla Public License 2.0", "LICENSE"),
    (
        "cc-by-sa",
        "EasyList / EasyPrivacy (CC BY-SA 3.0)",
        "LICENSE-CC-BY-SA-3.0.txt",
    ),
    (
        "cc0",
        "EasyList / EasyPrivacy / TweetFeed (CC0)",
        "LICENSE-CC0-1.0.txt",
    ),
];
const LICENSE_PACKAGE_FILES: &[&str] = &["licenses.json", "licenses-cargo.json"];

fn read_named_license_file(dir: &Path, filename: &str, max_bytes: usize) -> Result<String, String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("Could not read license credits.".into());
    }
    let path = dir.join(filename);
    if path.file_name().and_then(|name| name.to_str()) != Some(filename) {
        return Err("Could not read license credits.".into());
    }
    let bytes = std::fs::read(&path).map_err(|_| "Could not read license credits.".to_string())?;
    if bytes.len() > max_bytes {
        return Err("Could not read license credits.".into());
    }
    String::from_utf8(bytes).map_err(|_| "Could not read license credits.".to_string())
}

fn read_compiled_license_packages(
    dir: &Path,
    filename: &str,
) -> Result<Vec<LicensePackage>, String> {
    let raw = read_named_license_file(dir, filename, MAX_LICENSE_PACKAGE_BYTES)?;
    let entries: std::collections::BTreeMap<String, CompiledLicenseEntry> =
        serde_json::from_str(&raw).map_err(|_| "Could not read license credits.".to_string())?;
    Ok(entries
        .into_iter()
        .map(|(id, entry)| LicensePackage {
            id,
            licenses: entry.licenses,
            repository: entry.repository.filter(|value| !value.is_empty()),
            license_text: entry.license_text.filter(|value| !value.is_empty()),
            license_text_status: entry.license_text_status,
        })
        .collect())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompiledLicenseEntry {
    licenses: String,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    license_text: Option<String>,
    #[serde(default)]
    license_text_status: Option<String>,
}

pub(crate) fn read_license_credits_from(dir: &Path) -> Result<LicenseCredits, String> {
    let notices = LICENSE_NOTICE_FILES
        .iter()
        .map(|(id, title, filename)| {
            Ok(LicenseCredit {
                id: (*id).into(),
                title: (*title).into(),
                body: read_named_license_file(dir, filename, MAX_LICENSE_NOTICE_BYTES)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut packages = Vec::new();
    for filename in LICENSE_PACKAGE_FILES {
        packages.extend(read_compiled_license_packages(dir, filename)?);
    }
    Ok(LicenseCredits { notices, packages })
}

#[tauri::command]
pub fn get_license_credits(app: AppHandle) -> CommandResult<LicenseCredits> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|_| "Could not read license credits.".to_string())?;
    command_result(read_license_credits_from(&dir))
}

#[cfg(test)]
mod tests {
    use super::{
        read_license_credits_from, LICENSE_NOTICE_FILES, LICENSE_PACKAGE_FILES,
        MAX_LICENSE_NOTICE_BYTES,
    };
    use std::fs;

    fn write_required_files(dir: &std::path::Path) {
        for (id, _, filename) in LICENSE_NOTICE_FILES {
            fs::write(dir.join(filename), format!("{id} body")).unwrap();
        }
        fs::write(
            dir.join("licenses.json"),
            r#"{"alpha@1.0.0":{"licenses":"MIT","repository":"https://example.test/alpha","licenseText":"alpha text","packageManager":"npm"}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("licenses-cargo.json"),
            r#"{"cargo:beta@2.0.0":{"licenses":"Apache-2.0","licenseTextStatus":"not-packaged"}}"#,
        )
        .unwrap();
    }

    #[test]
    fn reads_notices_and_compiled_package_credits() {
        let directory = tempfile::tempdir().unwrap();
        write_required_files(directory.path());
        fs::write(directory.path().join("secret.txt"), "ignore").unwrap();
        let credits = read_license_credits_from(directory.path()).unwrap();
        assert_eq!(credits.notices.len(), LICENSE_NOTICE_FILES.len());
        assert_eq!(credits.notices[0].id, "mpl");
        assert_eq!(credits.notices[0].title, "Mozilla Public License 2.0");
        assert_eq!(credits.notices[0].body, "mpl body");
        assert_eq!(credits.packages.len(), 2);
        assert_eq!(credits.packages[0].id, "alpha@1.0.0");
        assert_eq!(
            credits.packages[0].license_text.as_deref(),
            Some("alpha text")
        );
        assert_eq!(credits.packages[1].id, "cargo:beta@2.0.0");
        assert_eq!(
            credits.packages[1].license_text_status.as_deref(),
            Some("not-packaged")
        );
        assert!(!credits
            .notices
            .iter()
            .any(|credit| credit.body.contains("ignore")));
        assert_eq!(LICENSE_PACKAGE_FILES.len(), 2);
    }

    #[test]
    fn fails_closed_when_a_license_file_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let error = read_license_credits_from(directory.path()).unwrap_err();
        assert_eq!(error, "Could not read license credits.");
    }

    #[test]
    fn fails_closed_when_compiled_package_json_is_invalid() {
        let directory = tempfile::tempdir().unwrap();
        write_required_files(directory.path());
        fs::write(directory.path().join("licenses.json"), "{not-json").unwrap();
        let error = read_license_credits_from(directory.path()).unwrap_err();
        assert_eq!(error, "Could not read license credits.");
    }

    #[test]
    fn fails_closed_when_a_license_file_is_too_large() {
        let directory = tempfile::tempdir().unwrap();
        write_required_files(directory.path());
        fs::write(
            directory.path().join("LICENSE"),
            vec![b'x'; MAX_LICENSE_NOTICE_BYTES + 1],
        )
        .unwrap();
        let error = read_license_credits_from(directory.path()).unwrap_err();
        assert_eq!(error, "Could not read license credits.");
    }
}
