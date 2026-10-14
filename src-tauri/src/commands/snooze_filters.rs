use tauri::State;

use super::sync::apply_filter_rules;
use super::{command_result, wake, AppState, CommandResult};
use crate::models::{validate_filter_rule, FilterMatchPreview, FilterRule, SnoozedSummary};

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

#[tauri::command(async)]
pub fn snooze_messages(
    account_id: String,
    message_ids: Vec<i64>,
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
            .snooze_messages(&account_id, &message_ids, &until.to_rfc3339()),
    )
}

#[tauri::command(async)]
pub fn unsnooze_message(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    command_result(state.db.unsnooze_message(&account_id, message_id))
}

#[tauri::command(async)]
pub fn list_filter_rules(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<FilterRule>> {
    state.db.account(&account_id)?;
    command_result(state.db.list_filter_rules(&account_id))
}

#[tauri::command]
pub async fn create_filter_rule(
    rule: FilterRule,
    state: State<'_, AppState>,
) -> CommandResult<FilterRule> {
    state.db.account(&rule.account_id)?;
    // Filing mail queues moves; hold the account so a sync pass cannot
    // replay or reconcile the same messages at the same time.
    let _guard = state.lock_account(&rule.account_id).await?;
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
    // Queued rule moves replay on the next pass; run it now.
    let _ = state.request(&rule.account_id, wake::SYNC);
    Ok(created)
}

#[tauri::command]
pub async fn update_filter_rule(
    rule: FilterRule,
    state: State<'_, AppState>,
) -> CommandResult<FilterRule> {
    state.db.account(&rule.account_id)?;
    // Filing mail queues moves; hold the account so a sync pass cannot
    // replay or reconcile the same messages at the same time.
    let _guard = state.lock_account(&rule.account_id).await?;
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
    // Queued rule moves replay on the next pass; run it now.
    let _ = state.request(&rule.account_id, wake::SYNC);
    Ok(updated)
}

#[tauri::command(async)]
pub fn delete_filter_rule(
    account_id: String,
    rule_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    command_result(state.db.delete_filter_rule(&account_id, &rule_id))
}

#[tauri::command(async)]
pub fn reorder_filter_rules(
    account_id: String,
    ordered_ids: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<FilterRule>> {
    state.db.account(&account_id)?;
    command_result(state.db.reorder_filter_rules(&account_id, &ordered_ids))
}

#[tauri::command(async)]
pub fn preview_filter_rule(
    mut rule: FilterRule,
    state: State<'_, AppState>,
) -> CommandResult<FilterMatchPreview> {
    state.db.account(&rule.account_id)?;
    if rule.name.trim().is_empty() {
        rule.name = "Preview".into();
    }
    validate_filter_rule(&rule, &rule.account_id)?;
    if rule.action == "move_mailbox" {
        let target = rule
            .target_mailbox
            .as_deref()
            .ok_or_else(|| "Choose the folder to move matching mail into.".to_string())?;
        let target_id: i64 = target
            .parse()
            .map_err(|_| "Choose the folder to move matching mail into.".to_string())?;
        let (owner, _) = state.db.mailbox(target_id)?;
        if owner != rule.account_id {
            return Err("Folder does not belong to this account.".into());
        }
    }
    command_result(state.db.preview_rule_matches(&rule.account_id, &rule))
}

#[tauri::command]
pub async fn mute_conversation(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<Vec<i64>> {
    state.db.account(&account_id)?;
    // Filing mail queues moves; hold the account so a sync pass cannot
    // replay the same messages at the same time.
    let _guard = state.lock_account(&account_id).await?;
    if state.db.mailbox_for_role(&account_id, "archive")?.is_none() {
        return Err("Choose an Archive folder in Settings before muting a conversation.".into());
    }
    state
        .db
        .remember_muted_conversation(&account_id, message_id)?;
    let filed = state.db.file_muted_inbox(&account_id)?;
    let _ = state.request(&account_id, wake::SYNC);
    Ok(filed)
}

#[tauri::command(async)]
pub fn unmute_conversation(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.db.account(&account_id)?;
    command_result(state.db.forget_muted_conversation(&account_id, message_id))
}

#[tauri::command(async)]
pub fn list_snoozed(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<SnoozedSummary>> {
    state.db.account(&account_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    command_result(state.db.list_snoozed(&account_id, &now))
}
