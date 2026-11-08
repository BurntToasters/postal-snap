use tauri::{AppHandle, State};

use super::messages::{bulk_apply_flags, MAX_BULK_MESSAGES};
use super::{command_result, emit_folder_counts, emit_message_change, AppState, CommandResult};
use crate::mail::keywords::ColorChange;

/// Flags messages with a color (0 to 6), or clears the flag when `color` is None.
#[tauri::command]
pub async fn set_messages_flag_color(
    account_id: String,
    message_ids: Vec<i64>,
    color: Option<u8>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    if color.is_some_and(|value| value > 6) {
        return Err("Choose a flag color from the list.".into());
    }
    if message_ids.len() > MAX_BULK_MESSAGES {
        return Err("Select up to 200 messages at a time.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let mut items = Vec::new();
    for id in message_ids {
        let Ok((owner, mailbox, uid)) = state.db.message_location(id) else {
            continue;
        };
        if owner != account_id {
            return Err("Message does not belong to this account.".into());
        }
        items.push((id, mailbox, uid));
    }
    let (is_starred, change) = match color {
        Some(value) => (Some(true), ColorChange::Set(value)),
        None => (Some(false), ColorChange::Clear),
    };
    bulk_apply_flags(&state, &account_id, &items, None, is_starred, Some(change)).await?;
    emit_message_change(&app, &account_id, None, "flags");
    emit_folder_counts(&app, &account_id);
    Ok(())
}

#[tauri::command(async)]
pub fn set_account_notifications(
    account_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    command_result(
        state
            .db
            .set_account_notifications(&account_id, enabled)
            .map(|_| ()),
    )
}
