use tauri::State;

use super::{AppState, CommandResult};
use crate::strings::NOT_AVAILABLE_YET;

#[tauri::command(async)]
pub fn start_attachment_drag(
    account_id: String,
    message_id: i64,
    attachment_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    let _ = (message_id, attachment_id);
    Err(NOT_AVAILABLE_YET.into())
}

#[tauri::command(async)]
pub fn start_message_drag(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    let _ = message_id;
    Err(NOT_AVAILABLE_YET.into())
}
