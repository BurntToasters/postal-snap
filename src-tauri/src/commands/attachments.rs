use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

use super::messages::ensure_message_content;
use super::{
    managed_account_dir, release_attachment_tokens, write_managed_file, AppState, CommandResult,
};
use crate::{
    mail,
    models::{Attachment, AttachmentPreview, ComposeAttachment},
    security,
};

#[tauri::command]
pub async fn save_attachment(
    account_id: String,
    message_id: i64,
    attachment_id: String,
    suggested_filename: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let suggested = security::safe_filename(&suggested_filename);
    let picker = app.clone();
    let destination = tokio::task::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_file_name(suggested)
            .blocking_save_file()
    })
    .await
    .map_err(|_| "Could not open the save dialog.".to_string())?;
    let Some(destination) = destination else {
        return Ok(());
    };
    let destination = destination
        .into_path()
        .map_err(|_| "Choose a valid save location.".to_string())?;
    ensure_message_content(&account_id, message_id, &state).await?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    let (_, bytes) = mail::extract_attachment(&raw, &attachment_id)?;
    tokio::fs::write(destination, bytes)
        .await
        .map_err(|_| "Could not save the attachment at that location.".into())
}

fn chosen_message_files(
    attachments: &[Attachment],
    attachment_ids: &[String],
) -> Result<Vec<Attachment>, String> {
    if attachment_ids.is_empty() || attachment_ids.len() > 100 {
        return Err("Choose a file from this message.".into());
    }
    let mut seen = HashSet::new();
    for id in attachment_ids {
        if id.trim().is_empty() || !seen.insert(id.as_str()) {
            return Err("Choose a file from this message.".into());
        }
    }
    let chosen: Vec<Attachment> = attachments
        .iter()
        .filter(|item| !item.inline && seen.contains(item.id.as_str()))
        .cloned()
        .collect();
    if chosen.len() != seen.len() {
        return Err("Choose a file from this message.".into());
    }
    Ok(chosen)
}

/// Save the chosen regular attachments into one folder the user picks.
#[tauri::command]
pub async fn save_chosen_attachments(
    account_id: String,
    message_id: i64,
    attachment_ids: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<u32> {
    state.db.account(&account_id)?;
    ensure_message_content(&account_id, message_id, &state).await?;
    let detail = state.db.message_detail(message_id, &account_id)?;
    chosen_message_files(&detail.attachments, &attachment_ids)?;
    let Some(folder) = pick_folder(&app).await? else {
        return Ok(0);
    };
    let detail = state.db.message_detail(message_id, &account_id)?;
    let chosen = chosen_message_files(&detail.attachments, &attachment_ids)?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    let mut used = HashSet::new();
    let saved = write_message_files(&folder, &raw, &chosen, &mut used).await?;
    Ok(saved)
}

/// Save every regular attachment into one folder the user picks.
#[tauri::command]
pub async fn save_all_attachments(
    account_id: String,
    message_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<u32> {
    state.db.account(&account_id)?;
    let preview = state.db.message_detail(message_id, &account_id)?;
    if !preview.attachments.iter().any(|item| !item.inline) {
        return Err("This message has no files to save.".into());
    }
    let Some(folder) = pick_folder(&app).await? else {
        return Ok(0);
    };
    ensure_message_content(&account_id, message_id, &state).await?;
    let detail = state.db.message_detail(message_id, &account_id)?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    let mut used = HashSet::new();
    let saved = write_message_files(&folder, &raw, &detail.attachments, &mut used).await?;
    Ok(saved)
}

/// Save every regular file from the loaded messages into one chosen folder.
#[tauri::command]
pub async fn save_conversation_attachments(
    account_id: String,
    message_ids: Vec<i64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<u32> {
    let ids = normalize_conversation_ids(&message_ids)?;
    state.db.account(&account_id)?;
    let mut loaded = Vec::with_capacity(ids.len());
    for id in &ids {
        ensure_message_content(&account_id, *id, &state).await?;
        loaded.push(state.db.message_detail(*id, &account_id)?);
    }
    if !loaded
        .iter()
        .any(|detail| detail.attachments.iter().any(|item| !item.inline))
    {
        return Err("This conversation has no files to save.".into());
    }
    let Some(folder) = pick_folder(&app).await? else {
        return Ok(0);
    };
    let mut used = HashSet::new();
    let mut saved = 0u32;
    for detail in &loaded {
        let raw = state.db.raw_message(detail.summary.id, &account_id)?;
        saved += write_message_files(&folder, &raw, &detail.attachments, &mut used).await?;
    }
    if saved == 0 {
        return Err("This conversation has no files to save.".into());
    }
    Ok(saved)
}

/// Save each message's original source as an `.eml` file in one chosen folder.
#[tauri::command]
pub async fn save_messages_eml(
    account_id: String,
    message_ids: Vec<i64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<u32> {
    let ids = normalize_conversation_ids(&message_ids)?;
    state.db.account(&account_id)?;
    let mut loaded = Vec::with_capacity(ids.len());
    for id in &ids {
        ensure_message_content(&account_id, *id, &state).await?;
        let detail = state.db.message_detail(*id, &account_id)?;
        let raw = state.db.raw_message(detail.summary.id, &account_id)?;
        loaded.push((detail.summary.subject, raw));
    }
    let Some(folder) = pick_folder(&app).await? else {
        return Ok(0);
    };
    let mut used = HashSet::new();
    for (subject, raw) in &loaded {
        write_message_eml(&folder, subject, raw, &mut used).await?;
    }
    Ok(loaded.len() as u32)
}

fn normalize_conversation_ids(message_ids: &[i64]) -> Result<Vec<i64>, String> {
    if message_ids.is_empty() {
        return Err("Choose a message to save.".into());
    }
    let mut ids = Vec::new();
    for id in message_ids {
        if !ids.contains(id) {
            ids.push(*id);
        }
    }
    if ids.len() > 200 {
        return Err("Select up to 200 messages at a time.".into());
    }
    Ok(ids)
}

async fn pick_folder(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let picker = app.clone();
    let destination =
        tokio::task::spawn_blocking(move || picker.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| "Could not open the save dialog.".to_string())?;
    let Some(destination) = destination else {
        return Ok(None);
    };
    let folder = destination
        .into_path()
        .map_err(|_| "Choose a valid save location.".to_string())?;
    if !folder.is_dir() {
        return Err("Choose a folder.".into());
    }
    Ok(Some(folder))
}

async fn write_message_files(
    folder: &Path,
    raw: &[u8],
    attachments: &[Attachment],
    used: &mut HashSet<String>,
) -> Result<u32, String> {
    let mut saved = 0u32;
    for attachment in attachments.iter().filter(|item| !item.inline) {
        let (_, bytes) = mail::extract_attachment(raw, &attachment.id)?;
        write_new_file(
            folder,
            &attachment.filename,
            &bytes,
            used,
            "Could not save the attachments in that folder.",
        )
        .await?;
        saved += 1;
    }
    Ok(saved)
}

/// Create a new file with a free name. Never follows or replaces an entry.
async fn write_new_file(
    folder: &Path,
    filename: &str,
    bytes: &[u8],
    used: &mut HashSet<String>,
    failure: &str,
) -> Result<PathBuf, String> {
    for _ in 0..1000 {
        let path = allocate_attachment_path(folder, filename, used)?;
        match create_new_file(&path).await {
            Ok(file) => {
                write_all_or_remove(file, &path, bytes)
                    .await
                    .map_err(|_| failure.to_string())?;
                return Ok(path);
            }
            // Something appeared after the name was chosen; the name is now in `used`.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(failure.into()),
        }
    }
    Err(failure.into())
}

/// Write and flush, then drop the handle. A failed write leaves no partial file.
async fn write_all_or_remove<W>(mut file: W, path: &Path, bytes: &[u8]) -> io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let result: io::Result<()> = async {
        file.write_all(bytes).await?;
        file.flush().await
    }
    .await;
    drop(file);
    if result.is_err() {
        let _ = tokio::fs::remove_file(path).await;
    }
    result
}

/// O_EXCL-style open: fails on any existing entry, including a symlink.
async fn create_new_file(path: &Path) -> io::Result<tokio::fs::File> {
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
}

/// A file name inside `folder` that does not replace an existing entry.
fn allocate_attachment_path(
    folder: &Path,
    filename: &str,
    used: &mut HashSet<String>,
) -> Result<PathBuf, String> {
    let safe = security::safe_filename(filename);
    for index in 1..1000 {
        let candidate = if index == 1 {
            safe.clone()
        } else {
            numbered_filename(&safe, index)
        };
        if used.contains(&candidate) || folder.join(&candidate).symlink_metadata().is_ok() {
            continue;
        }
        let path = folder.join(&candidate);
        if path.parent() != Some(folder) {
            return Err("Could not save the attachments.".into());
        }
        used.insert(candidate);
        return Ok(path);
    }
    Err("Could not save the attachments.".into())
}

async fn write_message_eml(
    folder: &Path,
    subject: &str,
    raw: &[u8],
    used: &mut HashSet<String>,
) -> Result<(), String> {
    write_new_file(
        folder,
        &forwarded_message_filename(subject),
        raw,
        used,
        "Could not save the messages in that folder.",
    )
    .await
    .map(|_| ())
}

fn numbered_filename(filename: &str, index: usize) -> String {
    match filename.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
            format!("{stem}-{index}.{extension}")
        }
        _ => format!("{filename}-{index}"),
    }
}

const MAX_PREVIEW_BYTES: usize = 10 * 1024 * 1024;

pub(crate) fn preview_text(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    if text
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return None;
    }
    Some(text.into_owned())
}

#[tauri::command]
pub async fn preview_attachment(
    account_id: String,
    message_id: i64,
    attachment_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AttachmentPreview> {
    ensure_message_content(&account_id, message_id, &state).await?;
    let detail = state.db.message_detail(message_id, &account_id)?;
    let attachment = detail
        .attachments
        .iter()
        .find(|item| item.id == attachment_id && !item.inline)
        .ok_or_else(|| "Attachment not found.".to_string())?;
    if attachment.size > MAX_PREVIEW_BYTES as u64 {
        return Err("This attachment is too large to preview.".into());
    }
    let raw = state.db.raw_message(message_id, &account_id)?;
    let (filename, bytes) = mail::extract_attachment(&raw, &attachment_id)?;
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err("This attachment is too large to preview.".into());
    }
    let content_type = attachment.content_type.as_str();
    if matches!(
        content_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        // Declared type alone is not trusted: sniff the bytes too.
        if security::detect_image_mime(&bytes) != Some(content_type) {
            return Err("This image format is not supported.".into());
        }
        return Ok(AttachmentPreview {
            filename,
            content_type: content_type.to_string(),
            size: bytes.len() as u64,
            text: None,
            image_data_url: Some(format!(
                "data:{content_type};base64,{}",
                STANDARD.encode(&bytes)
            )),
        });
    }
    if content_type == "text/plain" {
        let Some(text) = preview_text(&bytes) else {
            return Err("This text file cannot be previewed.".into());
        };
        return Ok(AttachmentPreview {
            filename,
            content_type: content_type.to_string(),
            size: bytes.len() as u64,
            text: Some(text.chars().take(200_000).collect()),
            image_data_url: None,
        });
    }
    Err("Only images and plain-text files can be previewed.".into())
}

/// Forward an inline image as inline only when the forwarded text shows it by
/// Content-ID; otherwise it would be invisible, so it travels as a file.
pub(crate) fn forward_as_inline(
    attachment: &crate::models::Attachment,
    html_body: Option<&str>,
) -> bool {
    let Some(content_id) = attachment.content_id.as_deref() else {
        return false;
    };
    let content_id = content_id
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    let content_id = content_id.to_ascii_lowercase();
    // Stored received HTML keeps the reference as data-inline-cid.
    attachment.inline
        && !content_id.is_empty()
        && html_body.is_some_and(|html| {
            let html = html.to_ascii_lowercase();
            html.contains(&format!("cid:{content_id}"))
                || html.contains(&format!("data-inline-cid=\"{content_id}\""))
        })
}

fn forwarded_message_filename(subject: &str) -> String {
    let safe = security::safe_filename(subject);
    let base = if safe == "attachment" {
        "message".to_string()
    } else {
        safe
    };
    if base.to_ascii_lowercase().ends_with(".eml") {
        base
    } else {
        format!("{base}.eml")
    }
}

#[tauri::command]
pub async fn prepare_forwarded_message(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<ComposeAttachment> {
    ensure_message_content(&account_id, message_id, &state).await?;
    let detail = state.db.message_detail(message_id, &account_id)?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    if raw.is_empty() {
        return Err("This message has not been downloaded yet.".into());
    }
    if raw.len() > mail::MAX_MESSAGE_BYTES {
        return Err("This message is too large to forward as an attachment.".into());
    }
    let account_dir = managed_account_dir(&state.attachment_dir, &account_id)?;
    tokio::fs::create_dir_all(&account_dir)
        .await
        .map_err(|_| "Could not create private draft storage.".to_string())?;
    let token = write_managed_file(&state, &account_id, &account_dir, &raw).await?;
    Ok(ComposeAttachment {
        token,
        filename: forwarded_message_filename(&detail.summary.subject),
        content_type: Some("message/rfc822".into()),
        inline: false,
        content_id: None,
        size: Some(raw.len()),
    })
}

/// File attachments a reply can include. Inline images stay with the original.
pub(crate) fn reply_files(attachments: &[Attachment]) -> Vec<&Attachment> {
    attachments.iter().filter(|item| !item.inline).collect()
}

#[tauri::command]
pub async fn prepare_forward_attachments(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ComposeAttachment>> {
    prepare_message_attachments(account_id, message_id, false, state).await
}

#[tauri::command]
pub async fn prepare_reply_attachments(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ComposeAttachment>> {
    prepare_message_attachments(account_id, message_id, true, state).await
}

async fn prepare_message_attachments(
    account_id: String,
    message_id: i64,
    files_only: bool,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ComposeAttachment>> {
    ensure_message_content(&account_id, message_id, &state).await?;
    let detail = state.db.message_detail(message_id, &account_id)?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    let account_dir = managed_account_dir(&state.attachment_dir, &account_id)?;
    tokio::fs::create_dir_all(&account_dir)
        .await
        .map_err(|_| "Could not create private draft storage.".to_string())?;
    let mut prepared = Vec::new();
    let mut created_tokens = Vec::new();
    let chosen: Vec<&Attachment> = if files_only {
        reply_files(&detail.attachments)
    } else {
        detail.attachments.iter().collect()
    };
    let result = async {
        let mut total = 0usize;
        for attachment in chosen {
            let inline = !files_only && forward_as_inline(attachment, detail.html_body.as_deref());
            let (_, bytes) = mail::extract_attachment(&raw, &attachment.id)?;
            total = total.saturating_add(bytes.len());
            if total > mail::MAX_MESSAGE_BYTES {
                return Err(if files_only {
                    "Those files are too large to attach."
                } else {
                    "Forwarded attachments are too large to prepare safely."
                }
                .into());
            }
            let token = write_managed_file(&state, &account_id, &account_dir, &bytes).await?;
            created_tokens.push(token.clone());
            prepared.push(ComposeAttachment {
                token,
                filename: attachment.filename.clone(),
                content_type: Some(attachment.content_type.clone()),
                inline,
                // The quoted text refers to it as cid:<id>; keep that id.
                content_id: inline.then(|| {
                    attachment
                        .content_id
                        .as_deref()
                        .unwrap_or_default()
                        .trim()
                        .trim_start_matches('<')
                        .trim_end_matches('>')
                        .to_string()
                }),
                size: Some(bytes.len()),
            });
        }
        Ok(prepared)
    }
    .await;
    if result.is_err() {
        release_attachment_tokens(
            &state,
            &account_id,
            created_tokens.iter().map(String::as_str),
        )
        .await;
    }
    result
}

/// Decoded pasted images stay at or under this size. Larger clipboard
/// payloads are refused before they are written.
pub const MAX_PASTED_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// Decode a pasted image. Accepts raw base64 or a data URL. The bytes are
/// sniffed, so a claimed type cannot smuggle another format.
pub fn pasted_image(data: &str) -> Result<(Vec<u8>, &'static str, String), String> {
    if data.len() > MAX_PASTED_IMAGE_BYTES * 2 {
        return Err("That image is too large.".into());
    }
    let payload = data
        .split_once(',')
        .filter(|(head, _)| head.to_ascii_lowercase().starts_with("data:image/"))
        .map(|(_, body)| body)
        .unwrap_or(data);
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| "Could not read that image.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err("That image is too large.".into());
    }
    let mime = security::detect_image_mime(&bytes)
        .ok_or_else(|| "Choose a PNG, JPEG, GIF, or WebP image.".to_string())?;
    let extension = match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    Ok((
        bytes,
        mime,
        security::safe_filename(&format!("Pasted image.{extension}")),
    ))
}

#[tauri::command]
pub async fn stage_pasted_image(
    account_id: String,
    data: String,
    state: State<'_, AppState>,
) -> CommandResult<ComposeAttachment> {
    state.db.account(&account_id)?;
    let (bytes, mime, filename) = pasted_image(&data)?;
    let account_dir = managed_account_dir(&state.attachment_dir, &account_id)?;
    tokio::fs::create_dir_all(&account_dir)
        .await
        .map_err(|_| "Could not create private draft storage.".to_string())?;
    #[cfg(unix)]
    tokio::fs::set_permissions(
        &account_dir,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .await
    .map_err(|_| "Could not secure private draft storage.".to_string())?;
    let token = write_managed_file(&state, &account_id, &account_dir, &bytes).await?;
    Ok(ComposeAttachment {
        token,
        filename,
        content_type: Some(mime.to_string()),
        inline: false,
        content_id: None,
        size: Some(bytes.len()),
    })
}

#[tauri::command]
pub async fn choose_attachments(
    account_id: String,
    inline: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ComposeAttachment>> {
    state.db.account(&account_id)?;
    let picker = app.clone();
    let selected = tokio::task::spawn_blocking(move || {
        let builder = picker.dialog().file();
        if inline {
            builder
                .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
                .blocking_pick_file()
                .into_iter()
                .collect::<Vec<_>>()
        } else {
            builder.blocking_pick_files().unwrap_or_default()
        }
    })
    .await
    .map_err(|_| "Could not open the file dialog.".to_string())?;
    let paths = selected
        .into_iter()
        .map(|item| {
            item.into_path()
                .map_err(|_| "That selected file is unavailable.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    stage_attachment_paths(&state, &account_id, paths, inline).await
}

/// Read one user-chosen file. Regular files only: no directories, no
/// symlinks, and nothing over `max_bytes`. Errors never name the path.
pub(crate) async fn read_attachment_source(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let unavailable = || "That selected file is unavailable.".to_string();
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| unavailable())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(unavailable());
    }
    if metadata.len() > max_bytes {
        return Err("That attachment is too large.".into());
    }
    tokio::fs::read(path).await.map_err(|_| unavailable())
}

/// Copy chosen or dropped files into private storage and return opaque
/// tokens. Shared by the picker and drag-drop; all or nothing.
pub(crate) async fn stage_attachment_paths(
    state: &AppState,
    account_id: &str,
    selected: Vec<PathBuf>,
    inline: bool,
) -> CommandResult<Vec<ComposeAttachment>> {
    let account_dir = managed_account_dir(&state.attachment_dir, account_id)?;
    tokio::fs::create_dir_all(&account_dir)
        .await
        .map_err(|_| "Could not create private draft storage.".to_string())?;
    #[cfg(unix)]
    tokio::fs::set_permissions(
        &account_dir,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .await
    .map_err(|_| "Could not secure private draft storage.".to_string())?;
    let mut attachments = Vec::new();
    let mut created_tokens = Vec::new();
    let result = async {
        if selected.len() > 100 {
            return Err("Choose no more than 100 attachments.".into());
        }
        let mut total = 0usize;
        for path in selected {
            let bytes = read_attachment_source(&path, mail::MAX_MESSAGE_BYTES as u64).await?;
            total = total.saturating_add(bytes.len());
            if total > mail::MAX_OUTGOING_BYTES {
                return Err("The selected attachments are too large.".into());
            }
            let token = write_managed_file(state, account_id, &account_dir, &bytes).await?;
            created_tokens.push(token.clone());
            attachments.push(ComposeAttachment {
                token,
                filename: security::safe_filename(
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("attachment"),
                ),
                content_type: Some(
                    mime_guess::from_path(&path)
                        .first_or_octet_stream()
                        .to_string(),
                ),
                inline,
                content_id: None,
                size: Some(bytes.len()),
            });
        }
        Ok(attachments)
    }
    .await;
    if result.is_err() {
        release_attachment_tokens(state, account_id, created_tokens.iter().map(String::as_str))
            .await;
    }
    result
}

#[tauri::command]
pub async fn read_message_inline_image(
    account_id: String,
    message_id: i64,
    attachment_id: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    ensure_message_content(&account_id, message_id, &state).await?;
    let detail = state.db.message_detail(message_id, &account_id)?;
    let attachment = detail
        .attachments
        .iter()
        .find(|item| item.id == attachment_id && item.inline && item.content_id.is_some())
        .ok_or_else(|| "Inline image not found.".to_string())?;
    if !matches!(
        attachment.content_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err("This inline image format is not supported.".into());
    }
    if attachment.size > 20 * 1024 * 1024 {
        return Err("This inline image is too large.".into());
    }
    let raw = state.db.raw_message(message_id, &account_id)?;
    let (_, bytes) = mail::extract_attachment(&raw, &attachment_id)?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("This inline image is too large.".into());
    }
    let sniffed = security::detect_image_mime(&bytes)
        .ok_or_else(|| "This inline image format is not supported.".to_string())?;
    if sniffed != attachment.content_type {
        return Err("This inline image format is not supported.".into());
    }
    Ok(format!("data:{sniffed};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn read_compose_image(
    token: String,
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let path = state.db.resolve_file(&token, &account_id)?;
    if !path.is_absolute() {
        return Err("Choose a valid image file.".into());
    }
    let metadata = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|_| "Choose a valid image file.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Choose a valid image file.".into());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| "Could not read that image.".to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("That image is too large.".into());
    }
    let mime = security::detect_image_mime(&bytes)
        .ok_or_else(|| "Choose a PNG, JPEG, GIF, or WebP image.".to_string())?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn release_compose_attachments(
    account_id: String,
    tokens: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    release_attachment_tokens(&state, &account_id, tokens.iter().map(String::as_str)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FailingWriter;

    impl tokio::io::AsyncWrite for FailingWriter {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            _: &[u8],
        ) -> std::task::Poll<io::Result<usize>> {
            std::task::Poll::Ready(Err(io::Error::other("disk full")))
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn failed_attachment_write_removes_partial_file() {
        // Ways this can fail: a failed write leaves a partial file behind, a
        // successful write is deleted, or the error is swallowed.
        let dir = std::env::temp_dir().join(format!("postal-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let failed = dir.join("failed.bin");
        std::fs::write(&failed, b"partial").unwrap();
        assert!(super::write_all_or_remove(FailingWriter, &failed, b"data")
            .await
            .is_err());
        assert!(!failed.exists());

        let kept = dir.join("kept.bin");
        std::fs::write(&kept, b"").unwrap();
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&kept)
            .await
            .unwrap();
        super::write_all_or_remove(file, &kept, b"hello")
            .await
            .unwrap();
        assert_eq!(std::fs::read(&kept).unwrap(), b"hello");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pasted_images_keep_real_picture_bytes() {
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let (bytes, mime, name) = pasted_image(png).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(name, "Pasted image.png");
        assert!(bytes.starts_with(b"\x89PNG"));
        assert_eq!(
            pasted_image("aGVsbG8=").unwrap_err(),
            "Choose a PNG, JPEG, GIF, or WebP image."
        );
        assert_eq!(
            pasted_image("%%%").unwrap_err(),
            "Could not read that image."
        );
        assert_eq!(
            pasted_image(&"A".repeat(MAX_PASTED_IMAGE_BYTES * 2 + 1)).unwrap_err(),
            "That image is too large."
        );
    }

    #[test]
    fn chosen_files_keep_only_the_requested_message_files() {
        let files = vec![
            file("notes", false),
            file("photo", true),
            file("budget", false),
        ];
        assert_eq!(
            chosen_message_files(&files, &["budget".into()])
                .unwrap()
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["budget"]
        );
        assert!(chosen_message_files(&files, &[]).is_err());
        assert!(chosen_message_files(&files, &["photo".into()]).is_err());
        assert!(chosen_message_files(&files, &["missing".into()]).is_err());
        assert!(chosen_message_files(&files, &["notes".into(), "notes".into()]).is_err());
    }

    fn file(id: &str, inline: bool) -> Attachment {
        Attachment {
            id: id.into(),
            filename: format!("{id}.bin"),
            content_type: "application/octet-stream".into(),
            size: 4,
            content_id: None,
            inline,
        }
    }

    #[test]
    fn forwarded_message_names_use_the_subject() {
        assert_eq!(forwarded_message_filename("Picnic plan"), "Picnic plan.eml");
        assert_eq!(forwarded_message_filename(""), "message.eml");
        assert_eq!(forwarded_message_filename("notes.eml"), "notes.eml");
        assert_eq!(forwarded_message_filename("a/b:c"), "abc.eml");
    }

    // Failure modes for attachment sources (picker and drop):
    // 1. A directory is accepted.
    // 2. A symlink is followed, so a link can smuggle another file in.
    // 3. A file over the per-file limit is read into memory first.
    // 4. A missing file panics or the error names the path.
    // 5. A regular file is refused or its bytes change.

    #[tokio::test]
    async fn regular_files_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.txt");
        std::fs::write(&path, b"hello").unwrap();
        assert_eq!(read_attachment_source(&path, 1024).await.unwrap(), b"hello");
    }

    #[tokio::test]
    async fn directories_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let error = read_attachment_source(dir.path(), 1024).await.unwrap_err();
        assert!(!error.contains(dir.path().to_str().unwrap()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.txt");
        std::fs::write(&target, b"secret").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read_attachment_source(&link, 1024).await.is_err());
    }

    #[tokio::test]
    async fn oversized_files_are_refused_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(2048).unwrap();
        let error = read_attachment_source(&path, 1024).await.unwrap_err();
        assert!(error.contains("too large"));
    }

    #[test]
    fn save_all_names_stay_in_the_chosen_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"keep").unwrap();
        let mut used = HashSet::new();
        let first = allocate_attachment_path(dir.path(), "../notes.txt", &mut used).unwrap();
        let second = allocate_attachment_path(dir.path(), "notes.txt", &mut used).unwrap();
        assert_eq!(first, dir.path().join("notes-2.txt"));
        assert_eq!(second, dir.path().join("notes-3.txt"));
        assert_eq!(first.parent(), Some(dir.path()));
        assert!(std::fs::read(dir.path().join("notes.txt")).unwrap() == b"keep");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn new_file_open_never_follows_a_symlink() {
        // Failure modes:
        // 1. A symlink at the name is followed and its target is truncated.
        // 2. A dangling symlink is followed and creates a file outside the folder.
        // 3. An existing regular file is truncated instead of refused.
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("secret.txt");
        let dangling = outside.path().join("missing.txt");
        std::fs::write(&target, b"secret").unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&dangling, dir.path().join("dangling.txt")).unwrap();
        std::fs::write(dir.path().join("kept.txt"), b"keep").unwrap();
        for name in ["link.txt", "dangling.txt", "kept.txt"] {
            let error = create_new_file(&dir.path().join(name)).await.err().unwrap();
            assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        }
        assert_eq!(std::fs::read(&target).unwrap(), b"secret");
        assert!(!dangling.exists());
        assert_eq!(std::fs::read(dir.path().join("kept.txt")).unwrap(), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn save_all_does_not_replace_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("secret.txt");
        std::fs::write(&target, b"secret").unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("notes.txt")).unwrap();
        let mut used = HashSet::new();
        let path = allocate_attachment_path(dir.path(), "notes.txt", &mut used).unwrap();
        assert_eq!(path, dir.path().join("notes-2.txt"));
        assert_eq!(std::fs::read(&target).unwrap(), b"secret");
    }

    #[tokio::test]
    async fn message_eml_files_stay_in_the_folder_and_keep_their_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mut used = HashSet::new();
        write_message_eml(
            dir.path(),
            "Weekend plans",
            b"From: Jane\r\n\r\nHi",
            &mut used,
        )
        .await
        .unwrap();
        write_message_eml(
            dir.path(),
            "Weekend plans",
            b"From: Ada\r\n\r\nLater",
            &mut used,
        )
        .await
        .unwrap();
        write_message_eml(dir.path(), "  ", b"From: Sam\r\n\r\nEmpty", &mut used)
            .await
            .unwrap();
        write_message_eml(
            dir.path(),
            "../../secret.eml",
            b"From: Pat\r\n\r\nStay",
            &mut used,
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("Weekend plans.eml")).unwrap(),
            b"From: Jane\r\n\r\nHi"
        );
        assert_eq!(
            std::fs::read(dir.path().join("Weekend plans-2.eml")).unwrap(),
            b"From: Ada\r\n\r\nLater"
        );
        assert_eq!(
            std::fs::read(dir.path().join("message.eml")).unwrap(),
            b"From: Sam\r\n\r\nEmpty"
        );
        let escaped = dir.path().join("secret.eml");
        assert_eq!(escaped.parent(), Some(dir.path()));
        assert_eq!(std::fs::read(&escaped).unwrap(), b"From: Pat\r\n\r\nStay");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn message_eml_does_not_replace_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("secret.eml");
        std::fs::write(&target, b"secret").unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("Weekend plans.eml")).unwrap();
        let mut used = HashSet::new();
        write_message_eml(
            dir.path(),
            "Weekend plans",
            b"From: Jane\r\n\r\nHi",
            &mut used,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"secret");
        assert_eq!(
            std::fs::read(dir.path().join("Weekend plans-2.eml")).unwrap(),
            b"From: Jane\r\n\r\nHi"
        );
    }

    #[test]
    fn conversation_save_ids_collapse_duplicates_and_stop_at_200() {
        assert_eq!(normalize_conversation_ids(&[4, 4, 9]).unwrap(), vec![4, 9]);
        assert!(normalize_conversation_ids(&[]).is_err());
        let too_many: Vec<i64> = (1..=201).collect();
        assert_eq!(
            normalize_conversation_ids(&too_many).unwrap_err(),
            "Select up to 200 messages at a time."
        );
    }

    #[tokio::test]
    async fn conversation_files_share_one_folder_and_skip_inline_parts() {
        let photo = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Photo\r\nContent-Type: multipart/mixed; boundary=postal\r\n\r\n--postal\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached\r\n--postal\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=\"photo.png\"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--postal\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename=\"logo.png\"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--postal--\r\n";
        let notes = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Notes\r\nContent-Type: multipart/mixed; boundary=postal\r\n\r\n--postal\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNotes\r\n--postal\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=\"photo.png\"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8h\r\n--postal\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nBring sandwiches\r\n--postal--\r\n";
        let first = mail::parse::parse_message(1, photo, true, false, None).unwrap();
        let second = mail::parse::parse_message(2, notes, true, false, None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut used = HashSet::new();
        let saved = write_message_files(dir.path(), photo, &first.attachments, &mut used)
            .await
            .unwrap()
            + write_message_files(dir.path(), notes, &second.attachments, &mut used)
                .await
                .unwrap();
        assert_eq!(saved, 3);
        assert_eq!(
            std::fs::read(dir.path().join("photo.png")).unwrap(),
            b"hello"
        );
        assert_eq!(
            std::fs::read(dir.path().join("photo-2.png")).unwrap(),
            b"hello!"
        );
        assert_eq!(
            std::fs::read(dir.path().join("notes.txt")).unwrap(),
            b"Bring sandwiches"
        );
        assert!(!dir.path().join("logo.png").exists());
    }

    #[test]
    fn reply_files_keep_attachments_and_skip_inline_images() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Photo\r\nContent-Type: multipart/mixed; boundary=postal\r\n\r\n--postal\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached\r\n--postal\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=\"photo.png\"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--postal\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename=\"logo.png\"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--postal--\r\n";
        let parsed = mail::parse::parse_message(1, raw, true, false, None).unwrap();
        let names: Vec<_> = super::reply_files(&parsed.attachments)
            .iter()
            .map(|item| item.filename.as_str())
            .collect();
        assert_eq!(names, vec!["photo.png"]);
    }

    #[tokio::test]
    async fn missing_files_give_a_plain_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gone.txt");
        let error = read_attachment_source(&path, 1024).await.unwrap_err();
        assert!(!error.contains("gone.txt"));
    }
}
