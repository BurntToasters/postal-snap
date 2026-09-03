use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::{
    db::Database,
    models::{
        AppSettings, CachePolicy, PortableCachePolicy, PortableSettings, PortableSettingsFile,
    },
};

const MAX_SETTINGS_BYTES: usize = 64 * 1024;
const PORTABLE_APPLICATION: &str = "postal-snap";
const PORTABLE_FORMAT_VERSION: u32 = 1;

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<AppSettings>,
    startup_notice: Mutex<Option<String>>,
    write_lock: Mutex<()>,
    migration_pending: Mutex<bool>,
}

impl SettingsStore {
    pub fn load(path: PathBuf, db: &Database) -> Result<Self, String> {
        let mut startup_notice = None;
        let mut migration_pending = false;
        let settings = match read_bounded(&path) {
            Ok(Some(raw)) => match parse_and_validate(&raw) {
                Ok(settings) => settings,
                Err(_) => {
                    backup_invalid(&path)?;
                    startup_notice = Some(
                        "Postal Snap found damaged settings and restored safe defaults."
                            .to_string(),
                    );
                    let settings = AppSettings::default();
                    write_atomic(&path, &serialize(&settings)?)?;
                    settings
                }
            },
            Ok(None) => match db.legacy_settings().and_then(normalize_legacy) {
                Ok(settings) => {
                    write_atomic(&path, &serialize(&settings)?)?;
                    settings
                }
                Err(_) => {
                    migration_pending = true;
                    startup_notice = Some(
                        "Postal Snap could not migrate saved settings. Safe defaults are temporary; restart Postal Snap to try again."
                            .to_string(),
                    );
                    AppSettings::default()
                }
            },
            Err(_) => {
                backup_invalid(&path)?;
                startup_notice = Some(
                    "Postal Snap could not read settings and restored safe defaults.".to_string(),
                );
                let settings = AppSettings::default();
                write_atomic(&path, &serialize(&settings)?)?;
                settings
            }
        };
        Ok(Self {
            path,
            current: Mutex::new(settings),
            startup_notice: Mutex::new(startup_notice),
            write_lock: Mutex::new(()),
            migration_pending: Mutex::new(migration_pending),
        })
    }

    pub fn get(&self) -> Result<AppSettings, String> {
        let settings = self
            .current
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())?;
        Ok(settings.clone())
    }

    pub fn save(&self, settings: AppSettings) -> Result<AppSettings, String> {
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())?;
        if *self
            .migration_pending
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())?
        {
            return Err(
                "Saved application settings could not be migrated. Restart Postal Snap or import/reset settings."
                    .to_string(),
            );
        }
        self.save_locked(settings)
    }

    fn save_locked(&self, settings: AppSettings) -> Result<AppSettings, String> {
        validate(&settings)?;
        write_atomic(&self.path, &serialize(&settings)?)?;
        *self
            .current
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())? = settings.clone();
        *self
            .migration_pending
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())? = false;
        Ok(settings)
    }

    pub fn take_startup_notice(&self) -> Result<Option<String>, String> {
        let notice = self
            .startup_notice
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())?
            .take();
        Ok(notice)
    }

    pub fn export_to(&self, path: &Path) -> Result<(), String> {
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())?;
        let current = self.get()?;
        let portable = PortableSettingsFile {
            application: PORTABLE_APPLICATION.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            preferences: PortableSettings::from(&current),
        };
        let contents = serde_json::to_string_pretty(&portable)
            .map_err(|_| "Could not prepare settings export.".to_string())?;
        write_atomic(path, &contents)
    }

    pub fn import_from(&self, path: &Path) -> Result<AppSettings, String> {
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())?;
        let raw = read_bounded(path)?.ok_or_else(|| "Settings file was not found.".to_string())?;
        let portable: PortableSettingsFile = serde_json::from_str(&raw)
            .map_err(|_| "Settings export is invalid or unsupported.".to_string())?;
        if portable.application != PORTABLE_APPLICATION
            || portable.format_version != PORTABLE_FORMAT_VERSION
        {
            return Err("Settings export is invalid or unsupported.".to_string());
        }
        let current = self.get()?;
        let next = portable.preferences.apply_to(&current);
        self.save_locked(next)
    }

    pub fn reset_preferences(&self) -> Result<AppSettings, String> {
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())?;
        let current = self.get()?;
        let next = PortableSettings::default().apply_to(&current);
        self.save_locked(next)
    }
}

impl From<&AppSettings> for PortableSettings {
    fn from(settings: &AppSettings) -> Self {
        Self {
            reading_pane: settings.reading_pane.clone(),
            text_scale: settings.text_scale,
            private_notifications: settings.private_notifications,
            theme: settings.theme.clone(),
            density: settings.density.clone(),
            cache_policy: PortableCachePolicy::from(&settings.cache_policy),
            folder_pane_width: settings.folder_pane_width,
            message_pane_width: settings.message_pane_width,
            reader_pane_height: settings.reader_pane_height,
        }
    }
}

impl PortableSettings {
    fn apply_to(&self, current: &AppSettings) -> AppSettings {
        AppSettings {
            schema_version: 2,
            reading_pane: self.reading_pane.clone(),
            text_scale: self.text_scale,
            private_notifications: self.private_notifications,
            theme: self.theme.clone(),
            density: self.density.clone(),
            cache_policy: (&self.cache_policy).into(),
            last_account_id: current.last_account_id.clone(),
            last_mailbox_id: current.last_mailbox_id,
            folder_pane_width: self.folder_pane_width,
            message_pane_width: self.message_pane_width,
            reader_pane_height: self.reader_pane_height,
        }
    }
}

impl Default for PortableSettings {
    fn default() -> Self {
        Self::from(&AppSettings::default())
    }
}

impl From<&CachePolicy> for PortableCachePolicy {
    fn from(policy: &CachePolicy) -> Self {
        Self {
            mode: policy.mode.clone(),
            days: policy.days,
            max_bytes: policy.max_bytes,
        }
    }
}

impl From<&PortableCachePolicy> for CachePolicy {
    fn from(policy: &PortableCachePolicy) -> Self {
        Self {
            mode: policy.mode.clone(),
            days: policy.days,
            max_bytes: policy.max_bytes,
        }
    }
}

fn normalize_legacy(mut settings: AppSettings) -> Result<AppSettings, String> {
    settings.schema_version = 2;
    if !matches!(settings.density.as_str(), "comfortable" | "compact") {
        settings.density = "comfortable".into();
    }
    validate(&settings)?;
    Ok(settings)
}

fn parse_and_validate(raw: &str) -> Result<AppSettings, String> {
    let settings: AppSettings =
        serde_json::from_str(raw).map_err(|_| "Settings JSON is invalid.".to_string())?;
    let settings = if settings.schema_version == 1 {
        normalize_legacy(settings)?
    } else {
        settings
    };
    validate(&settings)?;
    Ok(settings)
}

fn validate(settings: &AppSettings) -> Result<(), String> {
    let valid_cache_max_bytes = settings.cache_policy.max_bytes == 0
        || (100 * 1024 * 1024..=100 * 1024 * 1024 * 1024)
            .contains(&settings.cache_policy.max_bytes);
    let valid_cache_days = if settings.cache_policy.mode == "full" {
        true
    } else {
        (1..=3650).contains(&settings.cache_policy.days)
    };
    if settings.schema_version != 2
        || !(0.85..=2.0).contains(&settings.text_scale)
        || !valid_cache_max_bytes
        || !valid_cache_days
        || !matches!(
            settings.reading_pane.as_str(),
            "right" | "bottom" | "hidden"
        )
        || !matches!(settings.theme.as_str(), "system" | "light" | "dark")
        || !matches!(settings.density.as_str(), "comfortable" | "compact")
        || !matches!(settings.cache_policy.mode.as_str(), "recent" | "full")
        || !(210..=420).contains(&settings.folder_pane_width)
        || !(300..=720).contains(&settings.message_pane_width)
        || !(240..=800).contains(&settings.reader_pane_height)
        || settings
            .last_account_id
            .as_ref()
            .is_some_and(|value| uuid::Uuid::parse_str(value).is_err())
    {
        return Err("Invalid application settings.".into());
    }
    Ok(())
}

fn serialize(settings: &AppSettings) -> Result<String, String> {
    serde_json::to_string_pretty(settings)
        .map_err(|_| "Could not serialize application settings.".to_string())
}

fn read_bounded(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not inspect application settings.".into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Settings path is not a regular file.".into());
    }
    if metadata.len() > MAX_SETTINGS_BYTES as u64 {
        return Err("Settings file is too large.".into());
    }
    let file =
        fs::File::open(path).map_err(|_| "Could not open application settings.".to_string())?;
    let mut raw = String::new();
    file.take((MAX_SETTINGS_BYTES + 1) as u64)
        .read_to_string(&mut raw)
        .map_err(|_| "Could not read application settings.".to_string())?;
    if raw.len() > MAX_SETTINGS_BYTES {
        return Err("Settings file is too large.".into());
    }
    Ok(Some(raw))
}

fn backup_invalid(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
            let backup = path.with_file_name(format!("settings.json.corrupt-{stamp}"));
            fs::rename(path, backup)
                .map_err(|_| "Could not preserve damaged application settings.".to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not inspect damaged application settings.".into()),
    }
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if contents.len() > MAX_SETTINGS_BYTES {
        return Err("Settings payload is too large.".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Settings path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Could not create application data directory.".to_string())?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Settings path is invalid.".to_string())?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Could not create temporary application settings.".to_string())?;
    if let Err(error) = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not save application settings: {error}"));
    }
    drop(file);
    fs::rename(&temporary, path).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        "Could not replace application settings.".to_string()
    })?;
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_and_validate() {
        let defaults = AppSettings::default();
        assert_eq!(
            parse_and_validate(&serialize(&defaults).unwrap())
                .unwrap()
                .density,
            "comfortable"
        );
    }

    #[test]
    fn rejects_invalid_density_and_oversized_files() {
        let settings = AppSettings {
            density: "tiny".into(),
            ..AppSettings::default()
        };
        assert!(validate(&settings).is_err());

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, vec![b'x'; MAX_SETTINGS_BYTES + 1]).unwrap();
        assert!(read_bounded(&path).is_err());
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        write_atomic(&path, "{\"schemaVersion\":2}").unwrap();
        write_atomic(&path, "{\"schemaVersion\":2,\"theme\":\"dark\"}").unwrap();
        assert!(fs::read_to_string(path).unwrap().contains("dark"));
    }

    #[test]
    fn atomic_failure_keeps_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path.clone(), &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(store
            .save(AppSettings {
                theme: "light".into(),
                ..AppSettings::default()
            })
            .is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
        assert!(path.is_dir());
    }

    #[test]
    fn corrupt_settings_are_preserved_and_replaced_with_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, "{not json").unwrap();
        let store = SettingsStore::load(path.clone(), &Database::memory()).unwrap();
        assert_eq!(store.get().unwrap().theme, "system");
        assert!(store.take_startup_notice().unwrap().is_some());
        assert!(store.take_startup_notice().unwrap().is_none());
        assert!(fs::read_dir(directory.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("settings.json.corrupt-")
        }));
        assert!(fs::read_to_string(path).unwrap().contains("schemaVersion"));
    }

    #[test]
    fn failed_legacy_migration_uses_temporary_defaults_without_committing_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let db = Database::memory();
        db.set_legacy_settings_raw_for_test("not-json");

        let store = SettingsStore::load(path.clone(), &db).unwrap();

        assert_eq!(store.get().unwrap().theme, "system");
        assert!(store.take_startup_notice().unwrap().is_some());
        assert!(!path.exists());
        assert!(store.save(AppSettings::default()).is_err());
        assert!(!path.exists());

        store.reset_preferences().unwrap();
        assert!(path.is_file());
        assert!(store.save(AppSettings::default()).is_ok());
    }

    #[test]
    fn portable_export_excludes_account_selection_and_round_trips_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("Postal Snap Settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                last_account_id: Some(uuid::Uuid::new_v4().to_string()),
                last_mailbox_id: Some(42),
                ..AppSettings::default()
            })
            .unwrap();

        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(!raw.contains("lastAccountId"));
        assert!(!raw.contains("lastMailboxId"));
        assert_eq!(
            serde_json::from_str::<PortableSettingsFile>(&raw)
                .unwrap()
                .preferences
                .theme,
            "dark"
        );

        let imported = store.import_from(&export_path).unwrap();
        assert_eq!(imported.theme, "dark");
        assert_eq!(imported.last_mailbox_id, Some(42));
    }

    #[test]
    fn portable_import_rejects_invalid_data_without_mutating_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let import_path = directory.path().join("invalid.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        let mut value = serde_json::to_value(PortableSettingsFile {
            application: PORTABLE_APPLICATION.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            preferences: PortableSettings::from(&store.get().unwrap()),
        })
        .unwrap();
        value["formatVersion"] = serde_json::json!(99);
        fs::write(&import_path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert!(store.import_from(&import_path).is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
    }

    #[test]
    fn portable_import_rejects_foreign_application_without_mutating_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let import_path = directory.path().join("foreign.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        let mut value = serde_json::to_value(PortableSettingsFile {
            application: PORTABLE_APPLICATION.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            preferences: PortableSettings::from(&store.get().unwrap()),
        })
        .unwrap();
        value["application"] = serde_json::json!("another-app");
        fs::write(&import_path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert!(store.import_from(&import_path).is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
    }

    #[test]
    fn portable_import_rejects_partial_cache_policy_without_mutating_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let import_path = directory.path().join("partial.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        let mut value = serde_json::to_value(PortableSettingsFile {
            application: PORTABLE_APPLICATION.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            preferences: PortableSettings::from(&store.get().unwrap()),
        })
        .unwrap();
        value["preferences"]["cachePolicy"]
            .as_object_mut()
            .unwrap()
            .remove("days");
        fs::write(&import_path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert!(store.import_from(&import_path).is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
    }

    #[test]
    fn portable_import_rejects_oversized_files_without_mutating_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let import_path = directory.path().join("oversized.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        fs::write(&import_path, vec![b'x'; MAX_SETTINGS_BYTES + 1]).unwrap();

        assert!(store.import_from(&import_path).is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
    }

    #[test]
    fn reset_preferences_preserves_account_selection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let account_id = uuid::Uuid::new_v4().to_string();
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                density: "compact".into(),
                last_account_id: Some(account_id.clone()),
                last_mailbox_id: Some(42),
                ..AppSettings::default()
            })
            .unwrap();

        let reset = store.reset_preferences().unwrap();
        assert_eq!(reset.theme, "system");
        assert_eq!(reset.density, "comfortable");
        assert_eq!(reset.last_account_id, Some(account_id));
        assert_eq!(reset.last_mailbox_id, Some(42));
    }

    #[test]
    fn unlimited_storage_and_full_mode_pass_validation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        let settings = AppSettings {
            cache_policy: CachePolicy {
                mode: "full".into(),
                days: 0,
                max_bytes: 0,
            },
            ..AppSettings::default()
        };
        store.save(settings).unwrap();
        let loaded = store.get().unwrap();
        assert_eq!(loaded.cache_policy.mode, "full");
        assert_eq!(loaded.cache_policy.max_bytes, 0);
        assert!(loaded.cache_policy.is_unlimited());
    }
}
