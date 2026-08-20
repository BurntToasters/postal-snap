use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::{db::Database, models::AppSettings};

const MAX_SETTINGS_BYTES: usize = 64 * 1024;

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<AppSettings>,
    startup_notice: Mutex<Option<String>>,
}

impl SettingsStore {
    pub fn load(path: PathBuf, db: &Database) -> Result<Self, String> {
        let mut startup_notice = None;
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
            Ok(None) => {
                let settings = db.legacy_settings().unwrap_or_default();
                let settings = normalize_legacy(settings);
                write_atomic(&path, &serialize(&settings)?)?;
                settings
            }
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
        validate(&settings)?;
        write_atomic(&self.path, &serialize(&settings)?)?;
        *self
            .current
            .lock()
            .map_err(|_| "Application settings are unavailable.".to_string())? = settings.clone();
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
}

fn normalize_legacy(mut settings: AppSettings) -> AppSettings {
    settings.schema_version = 2;
    if !matches!(settings.density.as_str(), "comfortable" | "compact") {
        settings.density = "comfortable".into();
    }
    if validate(&settings).is_ok() {
        settings
    } else {
        AppSettings::default()
    }
}

fn parse_and_validate(raw: &str) -> Result<AppSettings, String> {
    let settings: AppSettings =
        serde_json::from_str(raw).map_err(|_| "Settings JSON is invalid.".to_string())?;
    let settings = if settings.schema_version == 1 {
        normalize_legacy(settings)
    } else {
        settings
    };
    validate(&settings)?;
    Ok(settings)
}

fn validate(settings: &AppSettings) -> Result<(), String> {
    if settings.schema_version != 2
        || !(0.85..=2.0).contains(&settings.text_scale)
        || settings.cache_policy.max_bytes < 100 * 1024 * 1024
        || settings.cache_policy.max_bytes > 100 * 1024 * 1024 * 1024
        || !(1..=3650).contains(&settings.cache_policy.days)
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
}
