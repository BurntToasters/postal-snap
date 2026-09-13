//! Mail storage root selection and one-time legacy migration.

use std::path::{Path, PathBuf};

use tauri::Manager;

const DATABASE_FILE: &str = "postal-snap.sqlite3";

/// Directory that holds the mail database, downloaded bodies, and draft
/// attachments. Windows keeps this out of the roaming profile, which can be
/// synced at logon and is a poor fit for a multi-gigabyte WAL database.
pub fn mail_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        app.path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        app.path().app_data_dir().map_err(|error| error.to_string())
    }
}

/// Move a legacy roaming database (and its WAL companions and attachment
/// directory) into the new location. Idempotent: an existing target database
/// or attachment directory is never overwritten.
pub fn migrate_legacy_mail_data(legacy: &Path, target: &Path) {
    if legacy == target || target.join(DATABASE_FILE).exists() {
        return;
    }
    if !legacy.join(DATABASE_FILE).exists() {
        return;
    }
    if std::fs::create_dir_all(target).is_err() {
        return;
    }
    for name in [
        DATABASE_FILE,
        "postal-snap.sqlite3-wal",
        "postal-snap.sqlite3-shm",
    ] {
        let source = legacy.join(name);
        let destination = target.join(name);
        if source.exists() && !destination.exists() {
            let _ = std::fs::rename(&source, &destination);
        }
    }
    let attachments = legacy.join("draft-attachments");
    let destination_attachments = target.join("draft-attachments");
    if attachments.is_dir() && !destination_attachments.exists() {
        let _ = std::fs::rename(&attachments, &destination_attachments);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_database_attachments_and_wal_once() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("roaming");
        let target = root.path().join("local");
        std::fs::create_dir_all(legacy.join("draft-attachments")).unwrap();
        std::fs::write(legacy.join(DATABASE_FILE), b"db").unwrap();
        std::fs::write(legacy.join("postal-snap.sqlite3-wal"), b"wal").unwrap();
        std::fs::write(legacy.join("draft-attachments/a.bin"), b"attachment").unwrap();

        migrate_legacy_mail_data(&legacy, &target);

        assert!(target.join(DATABASE_FILE).exists());
        assert!(target.join("postal-snap.sqlite3-wal").exists());
        assert!(target.join("draft-attachments/a.bin").exists());
        assert!(!legacy.join(DATABASE_FILE).exists());

        // A second run must not clobber the migrated copy.
        std::fs::write(target.join(DATABASE_FILE), b"newer").unwrap();
        migrate_legacy_mail_data(&legacy, &target);
        assert_eq!(std::fs::read(target.join(DATABASE_FILE)).unwrap(), b"newer");
    }

    #[test]
    fn skips_when_no_legacy_database_exists() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("roaming");
        let target = root.path().join("local");
        std::fs::create_dir_all(&legacy).unwrap();
        migrate_legacy_mail_data(&legacy, &target);
        assert!(!target.join(DATABASE_FILE).exists());
    }
}
