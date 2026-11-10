use std::{
    collections::HashMap,
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, PoisonError,
    },
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{io::AsyncWriteExt, sync::mpsc};

use super::messages::{ensure_message_content_for, Need};
use super::{wake, AppState, CommandResult};
use crate::{
    bounded_file::{self, BoundedFileError},
    download_mark,
    mail::{self, failure::FailureKind},
    mbox::{self, MboxError, MboxReader, Record, MAX_EXPORT_BYTES, MAX_IMPORT_BYTES, MAX_RECORDS},
    models::{MessageCursor, MessageListFilter, MessageListSort},
};

/// Messages per IMAP APPEND batch.
const APPEND_BATCH: usize = 50;
/// Bytes per batch, so 50 large messages cannot hold gigabytes at once.
const BATCH_BYTES: usize = 32 * 1024 * 1024;
const PROGRESS_STEP: u32 = 20;

type Registry = Mutex<HashMap<String, Arc<AtomicBool>>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn locked_registry() -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>> {
    registry().lock().unwrap_or_else(PoisonError::into_inner)
}

/// One running export or import. Dropping it removes it from the registry.
struct Operation {
    id: String,
    cancel: Arc<AtomicBool>,
}

impl Operation {
    fn start() -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        locked_registry().insert(id.clone(), cancel.clone());
        Self { id, cancel }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        locked_registry().remove(&self.id);
    }
}

/// Unknown or finished ids are ignored, so a late cancel is harmless.
fn cancel_operation(id: &str) {
    if let Some(flag) = locked_registry().get(id) {
        flag.store(true, Ordering::SeqCst);
    }
}

fn check_cancelled(operation: &Operation, action: &str) -> Result<(), String> {
    if operation.cancelled() {
        Err(format!("{action} was cancelled."))
    } else {
        Ok(())
    }
}

fn io_failure() -> String {
    MboxError::Io.to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MboxExportResult {
    /// None when the save dialog was dismissed; nothing ran.
    pub operation_id: Option<String>,
    pub exported: u32,
    pub skipped: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MboxImportResult {
    /// None when the open dialog was dismissed; nothing ran.
    pub operation_id: Option<String>,
    pub imported: u32,
    pub skipped: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MboxProgress {
    operation_id: String,
    done: u32,
    total: u32,
}

fn report(app: &AppHandle, operation: &Operation, done: u32, total: u32) {
    if done.is_multiple_of(PROGRESS_STEP) || done >= total {
        let _ = app.emit(
            "mbox-progress",
            MboxProgress {
                operation_id: operation.id.clone(),
                done,
                total,
            },
        );
    }
}

#[tauri::command]
pub async fn export_mailbox_mbox(
    account_id: String,
    mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<MboxExportResult> {
    state.db.account(&account_id)?;
    let (owner, _) = state.db.mailbox(mailbox_id)?;
    if owner != account_id {
        return Err("That mailbox does not belong to this account.".into());
    }
    let total = state.db.cached_message_count(mailbox_id)?;
    if total as usize > MAX_RECORDS {
        return Err(
            "This mailbox has too many messages to export at once. The limit is 10,000.".into(),
        );
    }
    let Some(path) = pick_export_destination(&app).await? else {
        return Ok(MboxExportResult {
            operation_id: None,
            exported: 0,
            skipped: 0,
        });
    };
    let (temp, file) = create_export_temp(&path).await?;
    let operation = Operation::start();
    let outcome = export_messages(
        &app,
        &state,
        &account_id,
        mailbox_id,
        file,
        &operation,
        total,
    )
    .await;
    let (exported, skipped) = finish_export(&temp, &path, outcome).await?;
    download_mark::mark_downloaded(&path);
    Ok(MboxExportResult {
        operation_id: Some(operation.id.clone()),
        exported,
        skipped,
    })
}

/// Creates a new temp file beside the destination. The destination is not
/// opened, so a symlink or non-file there is refused and never written through.
async fn create_export_temp(destination: &Path) -> Result<(PathBuf, tokio::fs::File), String> {
    match tokio::fs::symlink_metadata(destination).await {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err(io_failure());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(io_failure()),
    }
    let parent = destination.parent().ok_or_else(io_failure)?;
    let temp = parent.join(format!(".postal-export-{}.partial", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options.open(&temp).await.map_err(|_| io_failure())?;
    Ok((temp, file))
}

/// Renames a finished export over the destination. A failed or cancelled
/// export removes only its temp file, so an earlier file survives.
async fn finish_export(
    temp: &Path,
    destination: &Path,
    outcome: Result<(u32, u32), String>,
) -> Result<(u32, u32), String> {
    let counts = match outcome {
        Ok(counts) => counts,
        Err(error) => {
            let _ = tokio::fs::remove_file(temp).await;
            return Err(error);
        }
    };
    if tokio::fs::rename(temp, destination).await.is_err() {
        let _ = tokio::fs::remove_file(temp).await;
        return Err(io_failure());
    }
    Ok(counts)
}

async fn pick_export_destination(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let picker = app.clone();
    let destination = tokio::task::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_file_name("Mailbox.mbox")
            .blocking_save_file()
    })
    .await
    .map_err(|_| "Could not open the save dialog.".to_string())?;
    let Some(destination) = destination else {
        return Ok(None);
    };
    destination
        .into_path()
        .map(Some)
        .map_err(|_| "Choose a valid save location.".to_string())
}

/// Oldest first. Each message is fetched through `ensure_message_content_for`,
/// which takes the account lock itself, so this loop cannot hold it.
async fn export_messages(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    mailbox_id: i64,
    mut file: tokio::fs::File,
    operation: &Operation,
    total: u32,
) -> Result<(u32, u32), String> {
    let mut exported = 0u32;
    let mut skipped = 0u32;
    let mut written = 0u64;
    let mut cursor: Option<MessageCursor> = None;
    let mut record = Vec::new();
    report(app, operation, 0, total);
    loop {
        check_cancelled(operation, "Export")?;
        let page = state.db.list_messages_filtered(
            mailbox_id,
            cursor.as_ref(),
            200,
            MessageListFilter::All,
            MessageListSort::DateOldest,
        )?;
        for item in &page.items {
            check_cancelled(operation, "Export")?;
            if exported + skipped >= MAX_RECORDS as u32 {
                return Err(MboxError::TooManyRecords.to_string());
            }
            let oversize_hint = item.size > mail::MAX_MESSAGE_BYTES as u64;
            let fetched = if oversize_hint {
                Err(())
            } else {
                match ensure_message_content_for(account_id, item.id, state, Need::Full).await {
                    Ok(()) => Ok(()),
                    // Network and storage failures stop the export, since
                    // skipping them would silently lose mail.
                    Err(error)
                        if matches!(
                            error.kind,
                            FailureKind::Connection
                                | FailureKind::SignInRejected
                                | FailureKind::LocalStorage
                        ) =>
                    {
                        return Err(error.message);
                    }
                    Err(_) => Err(()),
                }
            };
            let raw = match fetched
                .and_then(|()| state.db.raw_message(item.id, account_id).map_err(|_| ()))
            {
                Ok(raw) if raw.len() <= mail::MAX_MESSAGE_BYTES => raw,
                _ => {
                    skipped += 1;
                    report(app, operation, exported + skipped, total);
                    continue;
                }
            };
            record.clear();
            let len = mbox::write_record(&mut record, &raw, &mbox::asctime_for(&item.received_at))
                .map_err(|_| io_failure())?;
            written += len;
            if written > MAX_EXPORT_BYTES {
                return Err(MboxError::OutputTooLarge.to_string());
            }
            file.write_all(&record).await.map_err(|_| io_failure())?;
            exported += 1;
            report(app, operation, exported + skipped, total);
        }
        match page.next_cursor {
            Some(next) if page.has_more => cursor = Some(next),
            _ => break,
        }
    }
    file.flush().await.map_err(|_| io_failure())?;
    Ok((exported, skipped))
}

#[tauri::command]
pub async fn import_mbox(
    account_id: String,
    mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<MboxImportResult> {
    state.db.account(&account_id)?;
    let (owner, mailbox_name) = state.db.mailbox(mailbox_id)?;
    if owner != account_id {
        return Err("That mailbox does not belong to this account.".into());
    }
    let Some(path) = pick_import_source(&app).await? else {
        return Ok(MboxImportResult {
            operation_id: None,
            imported: 0,
            skipped: 0,
        });
    };
    let file = bounded_file::open_regular_for_stream(&path, MAX_IMPORT_BYTES)
        .map_err(|error| error.to_string())?;
    let operation = Operation::start();
    let outcome = import_messages(&app, &state, &account_id, &mailbox_name, file, &operation).await;
    // Imported batches stay on the server; wake a sync so they appear.
    let _ = state.request(&account_id, wake::SYNC);
    let (imported, skipped) = outcome?;
    Ok(MboxImportResult {
        operation_id: Some(operation.id.clone()),
        imported,
        skipped,
    })
}

async fn pick_import_source(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let picker = app.clone();
    let source = tokio::task::spawn_blocking(move || picker.dialog().file().blocking_pick_file())
        .await
        .map_err(|_| "Could not open the open dialog.".to_string())?;
    let Some(source) = source else {
        return Ok(None);
    };
    source
        .into_path()
        .map(Some)
        .map_err(|_| "Choose a valid file.".to_string())
}

/// Pass one: validate the mbox structure and count records. Nothing is
/// appended yet, so a bad or oversized file fails before any server change.
/// The file is rewound for pass two.
fn scan_records(mut file: File) -> Result<(File, u32), String> {
    let mut reader = MboxReader::new(BufReader::new((&mut file).take(MAX_IMPORT_BYTES + 1)));
    let mut count = 0u32;
    while reader
        .next_record()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        count += 1;
    }
    let limit_left = reader.into_inner().get_ref().limit();
    if limit_left == 0 {
        return Err(BoundedFileError::TooLarge.to_string());
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| io_failure())?;
    Ok((file, count))
}

#[derive(Default)]
struct Batch {
    messages: Vec<Vec<u8>>,
    bytes: usize,
    skipped: u32,
}

/// Pass two, on a blocking thread: parse each record and send batches. The
/// bounded channel keeps at most one batch waiting for the async side.
fn send_batches(
    file: File,
    sender: mpsc::Sender<Batch>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut reader = MboxReader::new(BufReader::new(file.take(MAX_IMPORT_BYTES + 1)));
    let mut batch = Batch::default();
    while let Some(record) = reader.next_record().map_err(|error| error.to_string())? {
        if cancel.load(Ordering::SeqCst) {
            return Err("Import was cancelled.".into());
        }
        match record {
            Record::Message(raw) if mail_parser::MessageParser::default().parse(&raw).is_some() => {
                batch.bytes += raw.len();
                batch.messages.push(raw);
            }
            _ => batch.skipped += 1,
        }
        if batch.messages.len() >= APPEND_BATCH || batch.bytes >= BATCH_BYTES {
            send_batch(&sender, std::mem::take(&mut batch))?;
        }
    }
    if reader.into_inner().get_ref().limit() == 0 {
        return Err(BoundedFileError::TooLarge.to_string());
    }
    send_batch(&sender, batch)
}

fn send_batch(sender: &mpsc::Sender<Batch>, batch: Batch) -> Result<(), String> {
    // A closed channel means the async side stopped (cancel or APPEND failure).
    sender
        .blocking_send(batch)
        .map_err(|_| "Import stopped.".to_string())
}

/// Returns (imported, skipped). Batches APPEND under the account lock, one
/// lock hold per batch so user actions can run between batches.
async fn import_messages(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    mailbox_name: &str,
    file: File,
    operation: &Operation,
) -> Result<(u32, u32), String> {
    let (file, total) = tokio::task::spawn_blocking(move || scan_records(file))
        .await
        .map_err(|_| io_failure())??;
    let account = state.db.account(account_id)?;
    let (sender, mut receiver) = mpsc::channel::<Batch>(1);
    let cancel = operation.cancel.clone();
    let reader = tokio::task::spawn_blocking(move || send_batches(file, sender, cancel));
    report(app, operation, 0, total);
    let mut imported = 0u32;
    let mut skipped = 0u32;
    let mut failure: Option<String> = None;
    while let Some(batch) = receiver.recv().await {
        if let Err(error) = check_cancelled(operation, "Import") {
            failure = Some(format!(
                "{error} Messages already added stay in the mailbox."
            ));
            break;
        }
        skipped += batch.skipped;
        if !batch.messages.is_empty() {
            let guard = match state.lock_account(account_id).await {
                Ok(guard) => guard,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            };
            let appended = match crate::oauth::session_secret(&account).await {
                Ok(password) => {
                    mail::append::append_seen(&account, &password, mailbox_name, &batch.messages)
                        .await
                }
                Err(error) => Err(error),
            };
            drop(guard);
            match appended {
                Ok(count) => imported += count,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        report(app, operation, imported + skipped, total);
    }
    // Closing the receiver lets the reader stop if it is still sending.
    drop(receiver);
    let reader_result = reader.await.map_err(|_| io_failure())?;
    if let Some(error) = failure {
        return Err(error);
    }
    reader_result?;
    Ok((imported, skipped))
}

#[tauri::command]
pub fn cancel_mbox_operation(operation_id: String) -> CommandResult<()> {
    // Parse before lookup so arbitrary text never reaches the registry.
    uuid::Uuid::parse_str(&operation_id)
        .map_err(|_| "That operation is not running.".to_string())?;
    cancel_operation(&operation_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn temp_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn cancel_flags_only_the_registered_operation_and_drop_unregisters_it() {
        let operation = Operation::start();
        assert!(!operation.cancelled());
        cancel_operation("not-a-running-operation");
        assert!(!operation.cancelled());
        cancel_operation(&operation.id);
        assert!(operation.cancelled());
        let id = operation.id.clone();
        drop(operation);
        assert!(!locked_registry().contains_key(&id));
    }

    #[test]
    fn cancel_command_rejects_text_that_is_not_an_operation_id() {
        assert!(cancel_mbox_operation("../../etc".into()).is_err());
        assert!(cancel_mbox_operation(uuid::Uuid::new_v4().to_string()).is_ok());
    }

    #[tokio::test]
    async fn cancelled_export_removes_only_its_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("Mailbox.mbox");
        let (temp, mut file) = create_export_temp(&destination).await.unwrap();
        file.write_all(b"From a\n\nfirst\n").await.unwrap();
        drop(file);
        let outcome = finish_export(&temp, &destination, Err("Export was cancelled.".into())).await;
        assert_eq!(outcome, Err("Export was cancelled.".into()));
        assert!(!temp.exists());
        assert!(!destination.exists());
    }

    #[tokio::test]
    async fn failed_export_keeps_a_preexisting_destination() {
        // Failure mode: a failed export deletes the user's earlier file.
        let dir = tempfile::tempdir().unwrap();
        let destination = temp_file(dir.path(), "Mailbox.mbox", b"earlier export");
        let (temp, file) = create_export_temp(&destination).await.unwrap();
        drop(file);
        let outcome = finish_export(&temp, &destination, Err("Export was cancelled.".into())).await;
        assert_eq!(outcome, Err("Export was cancelled.".into()));
        assert_eq!(std::fs::read(&destination).unwrap(), b"earlier export");
        assert!(!temp.exists());
    }

    #[tokio::test]
    async fn successful_export_replaces_the_destination() {
        let dir = tempfile::tempdir().unwrap();
        let destination = temp_file(dir.path(), "Mailbox.mbox", b"old");
        let (temp, mut file) = create_export_temp(&destination).await.unwrap();
        file.write_all(b"From new\n\n").await.unwrap();
        drop(file);
        let outcome = finish_export(&temp, &destination, Ok((1, 0))).await;
        assert_eq!(outcome, Ok((1, 0)));
        assert_eq!(std::fs::read(&destination).unwrap(), b"From new\n\n");
        assert!(!temp.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_refuses_a_symlink_destination() {
        // Failure mode: File::create follows the link and truncates its target.
        let dir = tempfile::tempdir().unwrap();
        let target = temp_file(dir.path(), "target.mbox", b"keep me");
        let link = dir.path().join("Mailbox.mbox");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(create_export_temp(&link).await.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn import_rejects_a_non_mbox_file_before_any_append() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_file(dir.path(), "plain.txt", b"Subject: not a mailbox\n\nbody\n");
        let file = File::open(path).unwrap();
        assert_eq!(
            scan_records(file).map(|(_, count)| count).unwrap_err(),
            MboxError::NotMbox.to_string()
        );
    }

    #[test]
    fn import_scan_counts_records_and_rewinds_for_the_send_pass() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_file(
            dir.path(),
            "two.mbox",
            b"From a\nSubject: a\n\nFrom b\nSubject: b\n\n",
        );
        let (mut file, count) = scan_records(File::open(path).unwrap()).unwrap();
        assert_eq!(count, 2);
        assert_eq!(file.stream_position().unwrap(), 0);
        let mut first = String::new();
        std::io::Read::read_to_string(&mut file, &mut first).unwrap();
        assert!(first.starts_with("From a"));
    }

    #[test]
    fn import_scan_fails_closed_past_the_record_cap_before_any_append() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = "From a\n\n".repeat(MAX_RECORDS + 1);
        let path = temp_file(dir.path(), "many.mbox", bytes.as_bytes());
        assert_eq!(
            scan_records(File::open(path).unwrap())
                .map(|(_, count)| count)
                .unwrap_err(),
            MboxError::TooManyRecords.to_string()
        );
    }

    #[test]
    fn import_stream_stops_when_the_operation_is_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_file(dir.path(), "cancel.mbox", b"From a\nSubject: a\n\n");
        let (sender, _receiver) = mpsc::channel::<Batch>(1);
        let cancel = Arc::new(AtomicBool::new(true));
        let result = send_batches(File::open(path).unwrap(), sender, cancel);
        assert_eq!(result, Err("Import was cancelled.".into()));
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_a_symlink_source() {
        let dir = tempfile::tempdir().unwrap();
        let target = temp_file(dir.path(), "target.mbox", b"From a\n\n");
        let link = dir.path().join("link.mbox");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(bounded_file::open_regular_for_stream(&link, MAX_IMPORT_BYTES).is_err());
    }
}
