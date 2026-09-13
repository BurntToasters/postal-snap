use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{
    command_result, emit_folder_counts, emit_message_change, emit_sync, AppState, CommandResult,
};
use crate::{
    credentials, mail,
    models::{MessageCursor, MessageDetail, MessagePage, MessageSummary, SearchQuery},
};

#[tauri::command]
pub fn list_messages(
    account_id: String,
    mailbox_id: i64,
    cursor: Option<MessageCursor>,
    limit: u32,
    state: State<'_, AppState>,
) -> CommandResult<MessagePage> {
    let (owner, _) = state.db.mailbox(mailbox_id)?;
    if owner != account_id {
        return Err("Mailbox does not belong to this account.".into());
    }
    command_result(
        state
            .db
            .list_messages(mailbox_id, cursor.as_ref(), limit.clamp(1, 200)),
    )
}

pub(crate) async fn ensure_message_content(
    account_id: &str,
    message_id: i64,
    state: &AppState,
) -> Result<(), String> {
    let (owner_id, ..) = state.db.message_fetch_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    if state.db.message_content_cached(message_id, account_id)? {
        return Ok(());
    }
    let _guard = state.lock_account(account_id).await?;
    let (owner_id, mailbox_id, mailbox, uid, size) = state.db.message_fetch_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    if state.db.message_content_cached(message_id, account_id)? {
        return Ok(());
    }
    let uid_validity = state.db.mailbox_uid_validity(account_id, &mailbox)?;
    let account = state.db.account(account_id)?;
    let password = credentials::load(account_id)?;
    let cached_received_at = state.db.message_received_at(message_id).ok().flatten();
    let message = mail::download_message(
        &account,
        &password,
        &mailbox,
        uid,
        size,
        uid_validity,
        cached_received_at.as_deref(),
    )
    .await?;
    state.db.upsert_message(account_id, mailbox_id, &message)?;
    let id = message
        .message_id
        .clone()
        .unwrap_or_else(|| crate::db::synthetic_thread_id(mailbox_id, message.uid));
    let _ = state.db.repair_thread_roots(account_id, &[id]);
    Ok(())
}

#[tauri::command]
pub async fn get_message(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<MessageDetail> {
    ensure_message_content(&account_id, message_id, &state).await?;
    let db = state.db.clone();
    let account_id_for_detail = account_id.clone();
    let mut detail =
        tokio::task::spawn_blocking(move || db.message_detail(message_id, &account_id_for_detail))
            .await
            .map_err(|_| "Postal Snap could not read this message.".to_string())??;
    detail.references = state.db.message_references(message_id, &account_id)?;
    Ok(detail)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlagOperation {
    pub(crate) message_id: i64,
    pub(crate) uid: u32,
    pub(crate) mailbox: String,
    #[serde(default)]
    pub(crate) uid_validity: Option<u32>,
    pub(crate) is_read: Option<bool>,
    pub(crate) is_starred: Option<bool>,
}

#[tauri::command]
pub async fn set_message_flags(
    account_id: String,
    message_id: i64,
    is_read: Option<bool>,
    is_starred: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    let (owner_id, mailbox, uid) = state.db.message_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    let uid_validity = state
        .db
        .mailbox_uid_validity(&account_id, &mailbox)?
        .ok_or_else(|| {
            "Mailbox identity is unavailable; refresh mail and try again.".to_string()
        })?;
    state.db.set_flags(message_id, is_read, is_starred)?;
    let operation = FlagOperation {
        message_id,
        uid,
        mailbox: mailbox.clone(),
        uid_validity: Some(uid_validity),
        is_read,
        is_starred,
    };
    let remote_result = {
        let account = state.db.account(&account_id)?;
        let password = credentials::load(&account_id)?;
        mail::set_remote_flags(
            &account,
            &password,
            &mailbox,
            uid,
            Some(uid_validity),
            is_read,
            is_starred,
        )
        .await
    };
    if remote_result.is_err() {
        let dedupe_key = format!(
            "flags:{message_id}:{}:{}",
            is_read.is_some(),
            is_starred.is_some()
        );
        state
            .db
            .queue_operation(&account_id, "flags", &operation, Some(&dedupe_key))?;
    }
    emit_message_change(&app, &account_id, Some(message_id), "flags");
    emit_folder_counts(&app, &account_id);
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveOperation {
    pub(crate) message_id: i64,
    pub(crate) uid: u32,
    pub(crate) source: String,
    pub(crate) destination: String,
    #[serde(default)]
    pub(crate) uid_validity: Option<u32>,
}

#[tauri::command]
pub async fn move_message(
    account_id: String,
    message_id: i64,
    role: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    if !matches!(role.as_str(), "archive" | "trash" | "junk") {
        return Err("Unsupported destination.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (owner_id, source, uid) = state.db.message_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    let (destination_id, destination) = state
        .db
        .mailbox_for_role(&account_id, &role)?
        .ok_or_else(|| format!("This account does not have a {role} mailbox."))?;
    if source == destination {
        return Ok(());
    }
    command_result(
        move_message_inner(
            message_id,
            account_id,
            source,
            uid,
            destination_id,
            destination,
            &app,
            &state,
        )
        .await,
    )
}

#[tauri::command]
pub async fn move_message_to_mailbox(
    account_id: String,
    message_id: i64,
    destination_mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    let (owner_id, source, uid) = state.db.message_location(message_id)?;
    if owner_id != account_id {
        return Err("Message does not belong to this account.".into());
    }
    let (destination_account_id, destination) = state.db.mailbox(destination_mailbox_id)?;
    if destination_account_id != account_id {
        return Err("Messages cannot be moved between accounts.".into());
    }
    if source == destination {
        return Ok(());
    }
    command_result(
        move_message_inner(
            message_id,
            account_id,
            source,
            uid,
            destination_mailbox_id,
            destination,
            &app,
            &state,
        )
        .await,
    )
}

#[allow(clippy::too_many_arguments)]
async fn move_message_inner(
    message_id: i64,
    account_id: String,
    source: String,
    uid: u32,
    destination_id: i64,
    destination: String,
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let operation = MoveOperation {
        message_id,
        uid,
        source: source.clone(),
        destination: destination.clone(),
        uid_validity: Some(
            state
                .db
                .mailbox_uid_validity(&account_id, &source)?
                .ok_or_else(|| {
                    "Mailbox identity is unavailable; refresh mail and try again.".to_string()
                })?,
        ),
    };
    let account = state.db.account(&account_id)?;
    let password = credentials::load(&account_id)?;
    let remote_result = mail::move_remote(
        &account,
        &password,
        &source,
        &destination,
        uid,
        operation.uid_validity,
    )
    .await;
    if remote_result.is_err() {
        let dedupe_key = format!("move:{message_id}");
        state
            .db
            .queue_operation(&account_id, "move", &operation, Some(&dedupe_key))?;
        state.db.mark_pending_move(message_id, destination_id)?;
    } else {
        // UIDs are scoped to a mailbox. Remove the old cached row, then fetch
        // dest envelopes so archive/trash is not empty until the next IDLE.
        state.db.mark_pending_move(message_id, destination_id)?;
        state.db.remove_message(message_id)?;
        let policy = state
            .settings
            .get()
            .map(|settings| settings.cache_policy)
            .unwrap_or_default();
        let _ =
            mail::refresh_mailbox_envelopes(&account, &password, &destination, &state.db, &policy)
                .await;
    }
    emit_message_change(app, &account_id, Some(message_id), "moved");
    emit_folder_counts(app, &account_id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkOutcome {
    pub updated: usize,
    pub queued: usize,
    pub failed: usize,
}

/// Apply flag changes to many messages with one IMAP round trip per mailbox.
/// Stale rows are skipped; only messages that fail locally count as failed.
async fn bulk_apply_flags(
    state: &AppState,
    account_id: &str,
    items: &[(i64, String, u32)],
    is_read: Option<bool>,
    is_starred: Option<bool>,
) -> Result<BulkOutcome, String> {
    let mut groups: std::collections::HashMap<String, Vec<(i64, u32)>> =
        std::collections::HashMap::new();
    for (id, mailbox, uid) in items {
        groups.entry(mailbox.clone()).or_default().push((*id, *uid));
    }
    let mut mailboxes: Vec<_> = groups.into_iter().collect();
    mailboxes.sort_by(|left, right| left.0.cmp(&right.0));
    let account = state.db.account(account_id)?;
    let password = credentials::load(account_id)?;
    let mut updated = 0usize;
    let mut queued = 0usize;
    let mut failed = 0usize;
    for (mailbox, entries) in mailboxes {
        let ids: Vec<i64> = entries.iter().map(|(id, _)| *id).collect();
        let uids: Vec<u32> = entries.iter().map(|(_, uid)| *uid).collect();
        let Some(validity) = state.db.mailbox_uid_validity(account_id, &mailbox)? else {
            failed += ids.len();
            continue;
        };
        if state.db.set_flags_bulk(&ids, is_read, is_starred).is_err() {
            failed += ids.len();
            continue;
        }
        let remote = mail::set_remote_uid_flags(
            &account,
            &password,
            &mailbox,
            &uids,
            Some(validity),
            is_read,
            is_starred,
        )
        .await;
        if remote.is_err() {
            for (id, uid) in &entries {
                let operation = FlagOperation {
                    message_id: *id,
                    uid: *uid,
                    mailbox: mailbox.clone(),
                    uid_validity: Some(validity),
                    is_read,
                    is_starred,
                };
                let dedupe_key =
                    format!("flags:{id}:{}:{}", is_read.is_some(), is_starred.is_some());
                let _ =
                    state
                        .db
                        .queue_operation(account_id, "flags", &operation, Some(&dedupe_key));
            }
            queued += ids.len();
        } else {
            updated += ids.len();
        }
    }
    Ok(BulkOutcome {
        updated,
        queued,
        failed,
    })
}

#[tauri::command]
pub async fn set_messages_flags(
    account_id: String,
    message_ids: Vec<i64>,
    is_read: Option<bool>,
    is_starred: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<BulkOutcome> {
    if message_ids.len() > 200 {
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
    let outcome = bulk_apply_flags(&state, &account_id, &items, is_read, is_starred).await?;
    emit_message_change(&app, &account_id, None, "flags");
    emit_folder_counts(&app, &account_id);
    Ok(outcome)
}

#[tauri::command]
pub async fn move_messages_to_mailbox(
    account_id: String,
    message_ids: Vec<i64>,
    destination_mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<BulkOutcome> {
    if message_ids.len() > 200 {
        return Err("Select up to 200 messages at a time.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    // Resolve the destination inside the lock so a concurrent folder rename
    // cannot send the IMAP move at a stale name.
    let (destination_account_id, destination) = state.db.mailbox(destination_mailbox_id)?;
    if destination_account_id != account_id {
        return Err("Messages cannot be moved between accounts.".into());
    }
    let mut groups: std::collections::HashMap<String, Vec<(i64, u32)>> =
        std::collections::HashMap::new();
    for id in message_ids {
        let Ok((owner, source, uid)) = state.db.message_location(id) else {
            continue;
        };
        if owner != account_id {
            return Err("Message does not belong to this account.".into());
        }
        if source == destination {
            continue;
        }
        groups.entry(source).or_default().push((id, uid));
    }
    let mut sources: Vec<_> = groups.into_iter().collect();
    sources.sort_by(|left, right| left.0.cmp(&right.0));
    let account = state.db.account(&account_id)?;
    let password = credentials::load(&account_id)?;
    let mut updated = 0usize;
    let mut queued = 0usize;
    let mut failed = 0usize;
    for (source, entries) in sources {
        let Some(validity) = state.db.mailbox_uid_validity(&account_id, &source)? else {
            failed += entries.len();
            continue;
        };
        let uids: Vec<u32> = entries.iter().map(|(_, uid)| *uid).collect();
        let remote = mail::move_remote_uids(
            &account,
            &password,
            &source,
            &destination,
            &uids,
            Some(validity),
        )
        .await;
        if remote.is_ok() {
            for (id, _) in &entries {
                let _ = state.db.mark_pending_move(*id, destination_mailbox_id);
                let _ = state.db.remove_message(*id);
            }
            updated += entries.len();
        } else {
            for (id, uid) in &entries {
                let operation = MoveOperation {
                    message_id: *id,
                    uid: *uid,
                    source: source.clone(),
                    destination: destination.clone(),
                    uid_validity: Some(validity),
                };
                let dedupe_key = format!("move:{id}");
                let _ =
                    state
                        .db
                        .queue_operation(&account_id, "move", &operation, Some(&dedupe_key));
                let _ = state.db.mark_pending_move(*id, destination_mailbox_id);
            }
            queued += entries.len();
        }
    }
    if updated > 0 {
        let policy = state
            .settings
            .get()
            .map(|settings| settings.cache_policy)
            .unwrap_or_default();
        let _ =
            mail::refresh_mailbox_envelopes(&account, &password, &destination, &state.db, &policy)
                .await;
    }
    emit_message_change(&app, &account_id, None, "moved");
    emit_folder_counts(&app, &account_id);
    Ok(BulkOutcome {
        updated,
        queued,
        failed,
    })
}

#[tauri::command]
pub async fn mark_mailbox_read(
    account_id: String,
    mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<BulkOutcome> {
    let (owner, _) = state.db.mailbox(mailbox_id)?;
    if owner != account_id {
        return Err("Mailbox does not belong to this account.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let unread = state.db.unread_message_ids(mailbox_id)?;
    let items: Vec<(i64, String, u32)> = {
        let (_, name) = state.db.mailbox(mailbox_id)?;
        unread
            .into_iter()
            .take(200)
            .map(|(id, uid)| (id, name.clone(), uid))
            .collect()
    };
    let outcome = bulk_apply_flags(&state, &account_id, &items, Some(true), None).await?;
    emit_message_change(&app, &account_id, None, "flags");
    emit_folder_counts(&app, &account_id);
    Ok(outcome)
}

#[tauri::command]
pub fn search_cached_messages(
    query: SearchQuery,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MessageSummary>> {
    if let Some(mailbox_id) = query.mailbox_id {
        let (owner, _) = state.db.mailbox(mailbox_id)?;
        if owner != query.account_id {
            return Err("Mailbox does not belong to this account.".into());
        }
    } else {
        state.db.account(&query.account_id)?;
    }
    command_result(state.db.search(&query))
}

#[tauri::command]
pub async fn search_server_messages(
    query: SearchQuery,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MessageSummary>> {
    let _guard = state.lock_account(&query.account_id).await?;
    let account = state.db.account(&query.account_id)?;
    let password = credentials::load(&query.account_id)?;
    emit_sync(
        &app,
        &query.account_id,
        "syncing",
        Some("Searching the mail server…"),
        None,
    );
    match mail::server_search(&state.db, &account, &password, &query).await {
        Ok(results) => {
            emit_sync(
                &app,
                &query.account_id,
                "idle",
                Some("Search complete"),
                None,
            );
            Ok(results)
        }
        Err(error) => {
            emit_sync(
                &app,
                &query.account_id,
                "error",
                Some("Server search failed"),
                None,
            );
            Err(error.into())
        }
    }
}
