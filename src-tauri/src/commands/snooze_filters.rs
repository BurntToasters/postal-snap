use tauri::State;

use super::sync::apply_filter_rules;
use super::{command_result, AppState, CommandResult};
use crate::models::{validate_filter_rule, FilterRule, SnoozedSummary};

#[tauri::command]
pub async fn snooze_message(
    account_id: String,
    message_id: i64,
    until_iso: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    use chrono::{DateTime, Utc};
    state.db.account(&account_id)?;
    let until = DateTime::parse_from_rfc3339(&until_iso)
        .map_err(|_| "Pick a valid date and time.".to_string())?
        .with_timezone(&Utc);
    let now = Utc::now();
    if until <= now - chrono::Duration::minutes(1) {
        return Err("Pick a future date and time.".into());
    }
    if until > now + chrono::Duration::days(365) {
        return Err("Snooze up to a year ahead.".into());
    }
    command_result(
        state
            .db
            .snooze_message(&account_id, message_id, &until.to_rfc3339()),
    )
}

#[tauri::command]
pub fn unsnooze_message(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    command_result(state.db.unsnooze_message(&account_id, message_id))
}

#[tauri::command]
pub fn list_filter_rules(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<FilterRule>> {
    state.db.account(&account_id)?;
    command_result(state.db.list_filter_rules(&account_id))
}

#[tauri::command(async)]
pub fn create_filter_rule(
    rule: FilterRule,
    state: State<'_, AppState>,
) -> CommandResult<FilterRule> {
    state.db.account(&rule.account_id)?;
    validate_filter_rule(&rule, &rule.account_id.clone())?;
    if rule.action == "move_mailbox" {
        if let Some(target) = rule.target_mailbox.as_deref() {
            let target_id: i64 = target
                .parse()
                .map_err(|_| "Choose the folder to move matching mail into.".to_string())?;
            let (owner, _) = state.db.mailbox(target_id)?;
            if owner != rule.account_id {
                return Err("Folder does not belong to this account.".into());
            }
        } else {
            return Err("Choose the folder to move matching mail into.".into());
        }
    }
    let created = state.db.create_filter_rule(&rule)?;
    // A new rule applies to existing unread mail immediately.
    if let Ok(account) = state.db.account(&rule.account_id) {
        apply_filter_rules(&state.db, &account, None);
    }
    Ok(created)
}

#[tauri::command(async)]
pub fn update_filter_rule(
    rule: FilterRule,
    state: State<'_, AppState>,
) -> CommandResult<FilterRule> {
    state.db.account(&rule.account_id)?;
    validate_filter_rule(&rule, &rule.account_id.clone())?;
    if rule.action == "move_mailbox" {
        if let Some(target) = rule.target_mailbox.as_deref() {
            let target_id: i64 = target
                .parse()
                .map_err(|_| "Choose the folder to move matching mail into.".to_string())?;
            let (owner, _) = state.db.mailbox(target_id)?;
            if owner != rule.account_id {
                return Err("Folder does not belong to this account.".into());
            }
        } else {
            return Err("Choose the folder to move matching mail into.".into());
        }
    }
    let updated = state.db.update_filter_rule(&rule)?;
    if let Ok(account) = state.db.account(&rule.account_id) {
        apply_filter_rules(&state.db, &account, None);
    }
    Ok(updated)
}

#[tauri::command]
pub fn delete_filter_rule(
    account_id: String,
    rule_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    command_result(state.db.delete_filter_rule(&account_id, &rule_id))
}

#[tauri::command]
pub fn list_snoozed(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<SnoozedSummary>> {
    state.db.account(&account_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    command_result(state.db.list_snoozed(&account_id, &now))
}
