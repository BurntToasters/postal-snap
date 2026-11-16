use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use super::attachments::{
    confirm_risky_files, preview_bytes, risky_file_names, write_user_chosen_file, MAX_PREVIEW_BYTES,
};
use super::CommandResult;
use crate::{
    models::{AttachmentPreview, OpenedMessage},
    opened_mail, security,
};

/// Ask for one `.eml` file in a Rust dialog. `None` means the user cancelled.
#[tauri::command]
pub async fn open_eml_file(app: AppHandle) -> CommandResult<Option<OpenedMessage>> {
    let picker = app.clone();
    let selected = tokio::task::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .add_filter("Email Message", &["eml"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "Could not open the file dialog.".to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "That selected file is unavailable.".to_string())?;
    let raw = opened_mail::read_eml_file(&path).await?;
    let opened = tokio::task::spawn_blocking(move || opened_mail::open_bytes(raw))
        .await
        .map_err(|_| "Could not open that message.".to_string())??;
    Ok(Some(opened))
}

#[tauri::command(async)]
pub fn get_opened_message(token: String) -> CommandResult<OpenedMessage> {
    Ok(opened_mail::get_message(&token)?)
}

#[tauri::command(async)]
pub fn close_opened_message(token: String) -> CommandResult<()> {
    opened_mail::close_message(&token);
    Ok(())
}

/// Save one attachment of an opened message to a Rust-chosen path.
#[tauri::command]
pub async fn save_opened_attachment(
    token: String,
    attachment_id: String,
    app: AppHandle,
) -> CommandResult<()> {
    let found = opened_mail::lookup_attachment(&token, &attachment_id)?;
    let suggested = security::safe_filename(&found.attachment.filename);
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
    let chosen = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let mut risky = risky_file_names([found.attachment.filename.as_str(), chosen]);
    risky.dedup();
    if !confirm_risky_files(&app, risky).await? {
        return Ok(());
    }
    let bytes = opened_mail::part_bytes(&found.raw, found.index)?;
    write_user_chosen_file(&destination, &bytes).await?;
    crate::download_mark::mark_downloaded(&destination);
    Ok(())
}

#[tauri::command]
pub async fn preview_opened_attachment(
    token: String,
    attachment_id: String,
) -> CommandResult<AttachmentPreview> {
    let found = opened_mail::lookup_attachment(&token, &attachment_id)?;
    if found.attachment.inline {
        return Err("Attachment not found.".into());
    }
    if found.attachment.size > MAX_PREVIEW_BYTES as u64 {
        return Err("This attachment is too large to preview.".into());
    }
    let bytes = opened_mail::part_bytes(&found.raw, found.index)?;
    Ok(preview_bytes(
        found.attachment.filename,
        &found.attachment.content_type,
        bytes,
    )
    .await?)
}
