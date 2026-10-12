//! Mail storage root selection and one-time legacy migration.

use std::path::{Path, PathBuf};

use tauri::Manager;

const DATABASE_FILE: &str = "postal-snap.sqlite3";
const WAL_FILE: &str = "postal-snap.sqlite3-wal";
const SHM_FILE: &str = "postal-snap.sqlite3-shm";
pub const ATTACHMENT_DIR: &str = "draft-attachments";

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
/// directory) into the new location. Returns `Ok(true)` when files moved.
///
/// All-or-nothing: the companions and attachments move first and the main
/// database moves last. Any failure restores what already moved, so the
/// legacy location stays intact and the next run retries. Idempotent: an
/// existing target database is never overwritten.
pub fn migrate_legacy_mail_data(legacy: &Path, target: &Path) -> Result<bool, String> {
    migrate_with(legacy, target, |from, to| std::fs::rename(from, to))
}

fn migrate_with<F>(legacy: &Path, target: &Path, mut rename: F) -> Result<bool, String>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    if legacy == target
        || target.join(DATABASE_FILE).exists()
        || !legacy.join(DATABASE_FILE).exists()
    {
        return Ok(false);
    }
    // Only an empty attachment folder can be a leftover; a real one blocks.
    let _ = std::fs::remove_dir(target.join(ATTACHMENT_DIR));
    std::fs::create_dir_all(target)
        .map_err(|_| "Could not create the mail data folder.".to_string())?;

    let steps: Vec<&str> = [WAL_FILE, SHM_FILE, ATTACHMENT_DIR, DATABASE_FILE]
        .into_iter()
        .filter(|name| legacy.join(name).exists())
        .collect();
    if steps.iter().any(|name| target.join(name).exists()) {
        return Err("Mail data folder already has partial files; keeping legacy data.".into());
    }

    let mut moved: Vec<&str> = Vec::new();
    for name in steps {
        if rename(&legacy.join(name), &target.join(name)).is_err() {
            let restored = restore(legacy, target, &moved, &mut rename);
            return Err(if restored {
                "Could not move mail data; it stays in its previous location.".into()
            } else {
                "Could not move mail data and restoring it also failed.".into()
            });
        }
        moved.push(name);
    }
    Ok(true)
}

/// Move already-moved entries back to the legacy folder, newest first.
fn restore<F>(legacy: &Path, target: &Path, moved: &[&str], rename: &mut F) -> bool
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    moved
        .iter()
        .rev()
        .all(|name| rename(&target.join(name), &legacy.join(name)).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure modes covered by these tests (migration is all-or-nothing):
    // 1. The WAL rename fails first: nothing moves, legacy intact, retry works.
    // 2. The SHM rename fails after the WAL moved: the WAL is restored, retry works.
    // 3. The database rename (commit step) fails: everything is restored and
    //    no target database is created, so legacy data is never hidden.
    // 4. A target database already exists: never overwritten, no moves.
    // 5. The target holds stray companions without a database: refuse, move nothing.
    // 6. No legacy database: no-op.
    // 7. A restore step fails: reported as an error, nothing is silently lost.

    /// A rename that fails only when the source file has the given name.
    fn fail_on(name: &'static str) -> impl FnMut(&Path, &Path) -> std::io::Result<()> {
        move |from: &Path, to: &Path| {
            if from.file_name().and_then(|value| value.to_str()) == Some(name) {
                Err(std::io::Error::other("simulated lock"))
            } else {
                std::fs::rename(from, to)
            }
        }
    }

    fn legacy_fixture(root: &Path) -> (PathBuf, PathBuf) {
        let legacy = root.join("roaming");
        let target = root.join("local");
        std::fs::create_dir_all(legacy.join(ATTACHMENT_DIR)).unwrap();
        std::fs::write(legacy.join(DATABASE_FILE), b"db").unwrap();
        std::fs::write(legacy.join(WAL_FILE), b"wal").unwrap();
        std::fs::write(legacy.join(SHM_FILE), b"shm").unwrap();
        std::fs::write(legacy.join("draft-attachments/a.bin"), b"attachment").unwrap();
        (legacy, target)
    }

    fn assert_legacy_intact(legacy: &Path, target: &Path) {
        assert_eq!(std::fs::read(legacy.join(DATABASE_FILE)).unwrap(), b"db");
        assert_eq!(std::fs::read(legacy.join(WAL_FILE)).unwrap(), b"wal");
        assert_eq!(std::fs::read(legacy.join(SHM_FILE)).unwrap(), b"shm");
        assert!(legacy.join("draft-attachments/a.bin").exists());
        assert!(!target.join(DATABASE_FILE).exists());
        assert!(!target.join(WAL_FILE).exists());
        assert!(!target.join(SHM_FILE).exists());
    }

    #[test]
    fn migrates_legacy_database_attachments_and_wal_once() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("roaming");
        let target = root.path().join("local");
        std::fs::create_dir_all(legacy.join("draft-attachments")).unwrap();
        std::fs::write(legacy.join(DATABASE_FILE), b"db").unwrap();
        std::fs::write(legacy.join("postal-snap.sqlite3-wal"), b"wal").unwrap();
        std::fs::write(legacy.join("draft-attachments/a.bin"), b"attachment").unwrap();

        assert!(migrate_legacy_mail_data(&legacy, &target).unwrap());

        assert!(target.join(DATABASE_FILE).exists());
        assert!(target.join("postal-snap.sqlite3-wal").exists());
        assert!(target.join("draft-attachments/a.bin").exists());
        assert!(!legacy.join(DATABASE_FILE).exists());

        // A second run must not clobber the migrated copy.
        std::fs::write(target.join(DATABASE_FILE), b"newer").unwrap();
        assert!(!migrate_legacy_mail_data(&legacy, &target).unwrap());
        assert_eq!(std::fs::read(target.join(DATABASE_FILE)).unwrap(), b"newer");
    }

    #[test]
    fn wal_rename_failure_keeps_legacy_and_retries_next_run() {
        let root = tempfile::tempdir().unwrap();
        let (legacy, target) = legacy_fixture(root.path());

        let result = migrate_with(&legacy, &target, fail_on(WAL_FILE));
        assert!(result.is_err());
        assert_legacy_intact(&legacy, &target);

        assert!(migrate_legacy_mail_data(&legacy, &target).unwrap());
        assert!(target.join(DATABASE_FILE).exists());
        assert!(target.join(WAL_FILE).exists());
        assert!(target.join("draft-attachments/a.bin").exists());
    }

    #[test]
    fn shm_failure_after_wal_restores_wal_and_retries_next_run() {
        let root = tempfile::tempdir().unwrap();
        let (legacy, target) = legacy_fixture(root.path());

        let result = migrate_with(&legacy, &target, fail_on(SHM_FILE));
        assert!(result.is_err());
        assert_legacy_intact(&legacy, &target);

        assert!(migrate_legacy_mail_data(&legacy, &target).unwrap());
        assert!(target.join(DATABASE_FILE).exists());
    }

    #[test]
    fn database_rename_failure_restores_everything_and_creates_no_target_db() {
        let root = tempfile::tempdir().unwrap();
        let (legacy, target) = legacy_fixture(root.path());

        let result = migrate_with(&legacy, &target, fail_on(DATABASE_FILE));
        assert!(result.is_err());
        assert_legacy_intact(&legacy, &target);
        assert!(!target.join("draft-attachments").exists());
    }

    #[test]
    fn stray_target_companions_block_migration_without_moving() {
        let root = tempfile::tempdir().unwrap();
        let (legacy, target) = legacy_fixture(root.path());
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(WAL_FILE), b"stale").unwrap();

        assert!(migrate_legacy_mail_data(&legacy, &target).is_err());
        assert_eq!(std::fs::read(legacy.join(WAL_FILE)).unwrap(), b"wal");
        assert!(!target.join(DATABASE_FILE).exists());
    }

    #[test]
    fn existing_target_database_is_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let (legacy, target) = legacy_fixture(root.path());
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(DATABASE_FILE), b"current").unwrap();

        assert!(!migrate_with(&legacy, &target, fail_on(DATABASE_FILE)).unwrap());
        assert_eq!(
            std::fs::read(target.join(DATABASE_FILE)).unwrap(),
            b"current"
        );
        assert_eq!(std::fs::read(legacy.join(WAL_FILE)).unwrap(), b"wal");
    }

    #[test]
    fn restore_failure_is_reported_as_error() {
        let root = tempfile::tempdir().unwrap();
        let (legacy, target) = legacy_fixture(root.path());
        // The database rename fails, and every rollback rename fails too.
        let result = migrate_with(&legacy, &target, |from: &Path, to: &Path| {
            if to.starts_with(&legacy)
                || from.file_name().and_then(|v| v.to_str()) == Some(DATABASE_FILE)
            {
                Err(std::io::Error::other("simulated lock"))
            } else {
                std::fs::rename(from, to)
            }
        });
        assert_eq!(
            result.unwrap_err(),
            "Could not move mail data and restoring it also failed."
        );
    }

    #[test]
    fn skips_when_no_legacy_database_exists() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("roaming");
        let target = root.path().join("local");
        std::fs::create_dir_all(&legacy).unwrap();
        assert!(!migrate_legacy_mail_data(&legacy, &target).unwrap());
        assert!(!target.join(DATABASE_FILE).exists());
    }
}
