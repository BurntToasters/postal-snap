use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::messages::ensure_message_content;
use super::{
    managed_account_dir, release_attachment_tokens, write_managed_file, AppState, CommandResult,
};
use crate::{
    mail,
    models::{AttachmentPreview, ComposeAttachment},
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

#[tauri::command]
pub async fn prepare_forward_attachments(
    account_id: String,
    message_id: i64,
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
    let result = async {
        let mut total = 0usize;
        for attachment in detail.attachments.into_iter() {
            let (_, bytes) = mail::extract_attachment(&raw, &attachment.id)?;
            total = total.saturating_add(bytes.len());
            if total > mail::MAX_MESSAGE_BYTES {
                return Err("Forwarded attachments are too large to prepare safely.".into());
            }
            let token = write_managed_file(&state, &account_id, &account_dir, &bytes).await?;
            created_tokens.push(token.clone());
            prepared.push(ComposeAttachment {
                token,
                filename: attachment.filename,
                content_type: Some(attachment.content_type),
                inline: false,
                content_id: None,
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
    let mut attachments = Vec::new();
    let mut created_tokens = Vec::new();
    let result = async {
        if selected.len() > 100 {
            return Err("Choose no more than 100 attachments.".into());
        }
        let mut total = 0usize;
        for selected in selected {
            let path = selected
                .into_path()
                .map_err(|_| "That selected file is unavailable.".to_string())?;
            let metadata = tokio::fs::symlink_metadata(&path)
                .await
                .map_err(|_| "That selected file is unavailable.".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("That selected file is unavailable.".into());
            }
            if metadata.len() > mail::MAX_MESSAGE_BYTES as u64 {
                return Err("That attachment is too large.".into());
            }
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|_| "That selected file is unavailable.".to_string())?;
            total = total.saturating_add(bytes.len());
            if total > mail::MAX_OUTGOING_BYTES {
                return Err("The selected attachments are too large.".into());
            }
            let token = write_managed_file(&state, &account_id, &account_dir, &bytes).await?;
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
        release_attachment_tokens(
            &state,
            &account_id,
            created_tokens.iter().map(String::as_str),
        )
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
