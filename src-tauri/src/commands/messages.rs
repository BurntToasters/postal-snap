use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::sync::account_policy;
use super::{
    command_result, emit_folder_counts, emit_message_change, wake, AppState, CommandResult,
};
use crate::mail::sync::{body_fetch_for, BodyFetch, FetchedBody};
use crate::{
    db::{BodyState, CachedMessage, Database},
    mail::{
        self,
        failure::{FailureKind, MailError},
    },
    models::{
        MessageCursor, MessageDetail, MessageListFilter, MessageListSort, MessagePage,
        MessageSummary, SearchQuery,
    },
};

// Must match `BULK_LIMIT` in src/bulk.ts.
const MAX_BULK_MESSAGES: usize = 200;
/// Longest an undo-window move waits without a commit. The frontend commits
/// when its window closes; this only covers a commit that never arrives.
const UNDO_HOLD_SECONDS: i64 = 60;

#[tauri::command]
pub async fn list_messages(
    account_id: String,
    mailbox_id: i64,
    cursor: Option<MessageCursor>,
    limit: u32,
    filter: Option<MessageListFilter>,
    sort: Option<MessageListSort>,
    state: State<'_, AppState>,
) -> CommandResult<MessagePage> {
    let db = state.db.clone();
    let list_filter = filter.unwrap_or_default();
    let list_sort = sort.unwrap_or_default();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (owner, _) = db.mailbox(mailbox_id)?;
        if owner != account_id {
            return Err("Mailbox does not belong to this account.".to_string());
        }
        db.list_messages_filtered(
            mailbox_id,
            cursor.as_ref(),
            limit.clamp(1, 200),
            list_filter,
            list_sort,
        )
    })
    .await
    .map_err(|_| "Postal Snap could not list messages.".to_string())?;
    command_result(result)
}

/// A previous parse of this body never returned (the app stopped mid-parse).
pub(crate) const QUARANTINED: &str =
    "Postal Snap could not read this message safely, so it will not open it again. Read it in another mail app or delete it.";

/// What a caller needs from a stored body. `Text` accepts a stored prefix;
/// `Full` never does, so attachments, source and export see every byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Need {
    Text,
    Full,
}

/// Decision made from stored state before any network access.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContentPlan {
    Ready,
    Download(BodyFetch),
    /// Show the stored text, and upgrade to the whole message when online.
    UpgradeCid,
}

pub(crate) fn content_plan(
    need: Need,
    state: BodyState,
    size: u64,
    keep_attachments_offline: bool,
) -> ContentPlan {
    match (need, state.has_raw, state.body_partial) {
        (_, true, false) => ContentPlan::Ready,
        (Need::Full, _, _) => ContentPlan::Download(BodyFetch::Full),
        (Need::Text, _, true) if state.html_has_cid => ContentPlan::UpgradeCid,
        (Need::Text, _, true) => ContentPlan::Ready,
        (Need::Text, _, false) => {
            ContentPlan::Download(body_fetch_for(size, keep_attachments_offline))
        }
    }
}

/// Settles the parse count after a download that may have parsed.
fn settle_parse<T>(
    state: &AppState,
    mailbox_id: i64,
    uid: u32,
    parsing: bool,
    result: &Result<T, MailError>,
) -> Result<(), MailError> {
    if !parsing {
        return Ok(());
    }
    if matches!(result, Err(error) if error.kind == FailureKind::Unreadable) {
        state
            .db
            .quarantine_parse(mailbox_id, uid)
            .map_err(MailError::local_storage)?;
        return Err(MailError::new(FailureKind::Unreadable, QUARANTINED));
    }
    state
        .db
        .end_parse(mailbox_id, uid)
        .map_err(MailError::local_storage)
}

/// The message's download location, read under the account lock.
struct Location {
    message_id: i64,
    mailbox_id: i64,
    mailbox: String,
    uid: u32,
    size: u64,
}

async fn download_full_once(
    state: &AppState,
    account_id: &str,
    location: &Location,
    uid_validity: u32,
    cached_received_at: Option<&str>,
) -> Result<CachedMessage, MailError> {
    let account = state.db.account(account_id)?;
    let password = crate::oauth::session_secret(&account)
        .await
        .map_err(MailError::local_storage)?;
    let parsing = AtomicBool::new(false);
    let result = mail::download_message(
        &account,
        &password,
        &location.mailbox,
        location.uid,
        location.size,
        Some(uid_validity),
        cached_received_at,
        || {
            parsing.store(true, Ordering::SeqCst);
            state.db.begin_parse(location.mailbox_id, location.uid)
        },
    )
    .await;
    settle_parse(
        state,
        location.mailbox_id,
        location.uid,
        parsing.load(Ordering::SeqCst),
        &result,
    )?;
    result
}

async fn download_partial_once(
    state: &AppState,
    account_id: &str,
    location: &Location,
    uid_validity: u32,
    cached_received_at: Option<&str>,
) -> Result<FetchedBody, MailError> {
    let account = state.db.account(account_id)?;
    let password = crate::oauth::session_secret(&account)
        .await
        .map_err(MailError::local_storage)?;
    let parsing = AtomicBool::new(false);
    let result = mail::sync::download_partial_message(
        &account,
        &password,
        &location.mailbox,
        location.uid,
        location.size,
        Some(uid_validity),
        cached_received_at,
        || {
            parsing.store(true, Ordering::SeqCst);
            state.db.begin_parse(location.mailbox_id, location.uid)
        },
    )
    .await;
    settle_parse(
        state,
        location.mailbox_id,
        location.uid,
        parsing.load(Ordering::SeqCst),
        &result,
    )?;
    result
}

/// Store a body only if the row still belongs to the same mailbox generation.
fn store_body(
    state: &AppState,
    account_id: &str,
    location: &Location,
    uid_validity: u32,
    message: &CachedMessage,
    partial: bool,
) -> Result<(), MailError> {
    let stored = if partial {
        state
            .db
            .attach_partial_body_if_current(location.mailbox_id, uid_validity, message)
    } else {
        state
            .db
            .attach_body_if_current(location.mailbox_id, uid_validity, message)
    }
    .map_err(MailError::local_storage)?;
    if !stored {
        return Err("This message is no longer available on the server."
            .to_string()
            .into());
    }
    let id = message
        .message_id
        .clone()
        .unwrap_or_else(|| crate::db::synthetic_thread_id(location.mailbox_id, message.uid));
    let _ = state.db.repair_thread_roots(account_id, &[id]);
    Ok(())
}

async fn fetch_and_store(
    state: &AppState,
    account_id: &str,
    location: &Location,
    uid_validity: u32,
    plan: ContentPlan,
) -> Result<(), MailError> {
    let cached_received_at = state
        .db
        .message_received_at(location.message_id)
        .ok()
        .flatten();
    if !matches!(plan, ContentPlan::Download(BodyFetch::Partial)) {
        let message = download_full_once(
            state,
            account_id,
            location,
            uid_validity,
            cached_received_at.as_deref(),
        )
        .await?;
        return store_body(state, account_id, location, uid_validity, &message, false);
    }
    match download_partial_once(
        state,
        account_id,
        location,
        uid_validity,
        cached_received_at.as_deref(),
    )
    .await?
    {
        FetchedBody::Partial(message) => {
            store_body(state, account_id, location, uid_validity, &message, true)
        }
        FetchedBody::Full(message) => {
            store_body(state, account_id, location, uid_validity, &message, false)
        }
        FetchedBody::Fallback => {
            let message = download_full_once(
                state,
                account_id,
                location,
                uid_validity,
                cached_received_at.as_deref(),
            )
            .await?;
            store_body(state, account_id, location, uid_validity, &message, false)
        }
    }
}

/// Make the stored body satisfy `need`, downloading it when required.
pub(crate) async fn ensure_message_content_for(
    account_id: &str,
    message_id: i64,
    state: &AppState,
    need: Need,
) -> Result<(), MailError> {
    let storage = MailError::local_storage;
    let keep = state.db.keep_attachments_offline();
    let plan_now = || -> Result<ContentPlan, MailError> {
        let (owner_id, _, _, _, size) = state.db.message_fetch_location(message_id)?;
        if owner_id != account_id {
            return Err("Message does not belong to this account."
                .to_string()
                .into());
        }
        let body = state
            .db
            .body_state(message_id, account_id)
            .map_err(storage)?;
        Ok(content_plan(need, body, size, keep))
    };
    let plan = plan_now()?;
    if plan == ContentPlan::Ready {
        return Ok(());
    }
    let _guard = state.lock_account(account_id).await?;
    let plan = plan_now()?;
    if plan == ContentPlan::Ready {
        return Ok(());
    }
    if state
        .db
        .parse_quarantined(message_id, account_id)
        .map_err(storage)?
    {
        // A quarantined upgrade keeps the stored text; a body download cannot.
        return if plan == ContentPlan::UpgradeCid {
            Ok(())
        } else {
            Err(MailError::new(FailureKind::Unreadable, QUARANTINED))
        };
    }
    let (_, mailbox_id, mailbox, uid, size) = state.db.message_fetch_location(message_id)?;
    let uid_validity = state
        .db
        .mailbox_uid_validity(account_id, &mailbox)
        .map_err(storage)?
        .ok_or_else(|| {
            MailError::from(
                "Mailbox identity is unavailable; refresh mail and try again.".to_string(),
            )
        })?;
    let location = Location {
        message_id,
        mailbox_id,
        mailbox,
        uid,
        size,
    };
    let outcome = fetch_and_store(state, account_id, &location, uid_validity, plan).await;
    if plan == ContentPlan::UpgradeCid && outcome.is_err() {
        return Ok(());
    }
    outcome
}

/// Shorthand for callers that need the whole message.
pub(crate) async fn ensure_message_content(
    account_id: &str,
    message_id: i64,
    state: &AppState,
) -> Result<(), MailError> {
    ensure_message_content_for(account_id, message_id, state, Need::Full).await
}

#[tauri::command]
pub async fn get_message(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<MessageDetail> {
    // When the body cannot be downloaded right now (offline, sign-in needed,
    // too large), still open the envelope and say why the body is missing
    // instead of failing the whole message.
    let body_status =
        match ensure_message_content_for(&account_id, message_id, &state, Need::Text).await {
            Ok(()) => "available",
            Err(error) => match mail::failure::body_status(&error) {
                Some(status) => status,
                None => return Err(error.into()),
            },
        };
    message_detail_with_status(&state, account_id, message_id, body_status).await
}

/// Fetch the whole message, even when a prefix is stored, and return it.
#[tauri::command]
pub async fn download_full_message(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<MessageDetail> {
    ensure_message_content_for(&account_id, message_id, &state, Need::Full).await?;
    message_detail_with_status(&state, account_id, message_id, "available").await
}

async fn message_detail_with_status(
    state: &AppState,
    account_id: String,
    message_id: i64,
    body_status: &str,
) -> CommandResult<MessageDetail> {
    let db = state.db.clone();
    let account_id_for_detail = account_id.clone();
    let mut detail =
        tokio::task::spawn_blocking(move || db.message_detail(message_id, &account_id_for_detail))
            .await
            .map_err(|_| "Postal Snap could not read this message.".to_string())??;
    detail.references = state.db.message_references(message_id, &account_id)?;
    detail.body_status = body_status.into();
    Ok(detail)
}

fn header_message_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() > 254
        || trimmed.chars().any(|character| {
            character.is_control() || character.is_whitespace() || character == '"'
        })
    {
        return None;
    }
    let bare = trimmed.trim_start_matches('<').trim_end_matches('>');
    if bare.is_empty() || bare.contains('<') || bare.contains('>') || !bare.contains('@') {
        return None;
    }
    Some(format!("<{bare}>"))
}

/// The cached message with this Message-ID, if this account already has it.
#[tauri::command]
pub async fn find_cached_message(
    account_id: String,
    header_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Option<MessageSummary>> {
    let Some(header_id) = header_message_id(&header_id) else {
        return Ok(None);
    };
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.find_message_by_header_id(&account_id, &header_id))
        .await
        .map_err(|_| "Postal Snap could not look up that message.".to_string())?
        .map_err(Into::into)
}

/// Raw source for "Show original". Uses the same on-demand download as the
/// reader (size limit, account lock, ownership) and never renders it.
#[tauri::command]
pub async fn get_message_source(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<mail::source::MessageSource> {
    ensure_message_content_for(&account_id, message_id, &state, Need::Full).await?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    Ok(mail::source::build_source(&raw))
}

/// Save the original message to a destination the user picks.
#[tauri::command]
pub async fn save_message_eml(
    account_id: String,
    message_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    ensure_message_content_for(&account_id, message_id, &state, Need::Full).await?;
    let raw = state.db.raw_message(message_id, &account_id)?;
    let picker = app.clone();
    let destination = tokio::task::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_file_name("message.eml")
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
    tokio::fs::write(&destination, raw)
        .await
        .map_err(|_| "Could not save the message at that location.".to_string())?;
    // A saved message can carry attachments; mark it like saved files.
    crate::download_mark::mark_downloaded(&destination);
    Ok(())
}

/// RFC 8058 one-click unsubscribe. The URL comes from the stored header, never
/// from the frontend.
#[tauri::command]
pub async fn unsubscribe_one_click(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let db = state.db.clone();
    let detail =
        tauri::async_runtime::spawn_blocking(move || db.message_detail(message_id, &account_id))
            .await
            .map_err(|_| "Postal Snap could not read this message.".to_string())??;
    let url = detail
        .list_unsubscribe
        .as_deref()
        .and_then(|list| {
            mail::list_unsubscribe::one_click_url(list, detail.list_unsubscribe_post.as_deref())
        })
        .ok_or_else(|| "This message does not support one-click unsubscribe.".to_string())?;
    let block_threats = state.settings.get()?.block_reported_threats;
    command_result(crate::unsubscribe::send_one_click(&url, block_threats).await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadOlderOutcome {
    pub added: u32,
    pub has_more: bool,
}

/// Fetch one batch of envelopes older than anything cached in a folder, past
/// the Recent cutoff if needed. Bodies still download on open.
#[tauri::command]
pub async fn load_older_messages(
    account_id: String,
    mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<LoadOlderOutcome> {
    let (owner, _) = state.db.mailbox(mailbox_id)?;
    if owner != account_id {
        return Err("Mailbox does not belong to this account.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (_, name) = state.db.mailbox(mailbox_id)?;
    let account = state.db.account(&account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let (added, has_more) =
        mail::load_older_messages(&state.db, &account, &password, &name).await?;
    emit_message_change(&app, &account_id, None, "synced");
    Ok(LoadOlderOutcome { added, has_more })
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
        let password = crate::oauth::session_secret(&account).await?;
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
    match remote_result {
        Ok(()) => {
            state
                .db
                .record_flag_change(&account_id, message_id, is_read, is_starred, None)?
        }
        Err(error) if error.terminal => return Err(error.message.into()),
        Err(_) => {
            let queued = serde_json::to_value(&operation)
                .map_err(|_| "Could not queue the flag change.".to_string())?;
            state.db.record_flag_change(
                &account_id,
                message_id,
                is_read,
                is_starred,
                Some(&queued),
            )?;
        }
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
    undo_token: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Option<i64>> {
    if !matches!(role.as_str(), "archive" | "trash" | "junk") {
        return Err("Unsupported destination.".into());
    }
    if let Some(token) = undo_token.as_deref() {
        validate_undo_token(token)?;
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
        return Ok(None);
    }
    if let Some(token) = undo_token.as_deref() {
        let operation =
            move_operation_for(&state, &account_id, message_id, &source, uid, &destination)?;
        state.db.defer_moves(
            &account_id,
            &[(message_id, operation, destination_id)],
            token,
            undo_not_before(),
        )?;
        emit_message_change(&app, &account_id, Some(message_id), "moved");
        emit_folder_counts(&app, &account_id);
        return Ok(None);
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
    undo_token: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    if let Some(token) = undo_token.as_deref() {
        validate_undo_token(token)?;
    }
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
    if let Some(token) = undo_token.as_deref() {
        let operation =
            move_operation_for(&state, &account_id, message_id, &source, uid, &destination)?;
        state.db.defer_moves(
            &account_id,
            &[(message_id, operation, destination_mailbox_id)],
            token,
            undo_not_before(),
        )?;
        emit_message_change(&app, &account_id, Some(message_id), "moved");
        emit_folder_counts(&app, &account_id);
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
    .map(|_| ())
}

#[tauri::command]
pub async fn copy_message_to_mailbox(
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
        return Err("Messages cannot be copied between accounts.".into());
    }
    if source == destination {
        return Ok(());
    }
    command_result(
        copy_message_inner(
            message_id,
            account_id,
            source,
            uid,
            destination,
            &app,
            &state,
        )
        .await,
    )
}

async fn copy_message_inner(
    message_id: i64,
    account_id: String,
    source: String,
    uid: u32,
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
    let password = crate::oauth::session_secret(&account).await?;
    let remote_message_id = state.db.message_rfc_id(message_id).ok().flatten();
    let remote_result = mail::copy_remote(
        &account,
        &password,
        &source,
        &destination,
        uid,
        operation.uid_validity,
        mail::CopyOptions {
            message_id: remote_message_id.as_deref(),
            dedupe_existing: false,
        },
    )
    .await;
    if let Err(error) = remote_result {
        if error.terminal {
            return Err(error.message);
        }
        let dedupe_key = format!("copy:{message_id}:{destination}");
        state
            .db
            .queue_operation(&account_id, "copy", &operation, Some(&dedupe_key))?;
        return Err(
            "The copy could not be finished. It will be tried again when this account reconnects."
                .into(),
        );
    }
    let policy = account_policy(state, &account_id).unwrap_or_default();
    let _ = mail::refresh_mailbox_envelopes(&account, &password, &destination, &state.db, &policy)
        .await;
    emit_message_change(app, &account_id, Some(message_id), "copied");
    emit_folder_counts(app, &account_id);
    Ok(())
}

/// Builds the replayable move for one message, including the source identity.
fn move_operation_for(
    state: &AppState,
    account_id: &str,
    message_id: i64,
    source: &str,
    uid: u32,
    destination: &str,
) -> Result<MoveOperation, String> {
    Ok(MoveOperation {
        message_id,
        uid,
        source: source.to_string(),
        destination: destination.to_string(),
        uid_validity: Some(
            state
                .db
                .mailbox_uid_validity(account_id, source)?
                .ok_or_else(|| {
                    "Mailbox identity is unavailable; refresh mail and try again.".to_string()
                })?,
        ),
    })
}

fn undo_not_before() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now() + chrono::TimeDelta::seconds(UNDO_HOLD_SECONDS)
}

/// Undo tokens come from the frontend. Keep them short and plain.
fn validate_undo_token(token: &str) -> Result<(), String> {
    if token.is_empty()
        || token.len() > 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("This undo request is no longer valid.".into());
    }
    Ok(())
}

/// Local bookkeeping after the server committed a live move. The copies are
/// removed and their snoozes follow to the destination, like replayed moves.
/// Best effort: a database error must not report a completed move as failed.
pub(crate) fn record_live_moves(
    db: &crate::db::Database,
    account_id: &str,
    row_ids: &[i64],
    destination_mailbox_id: i64,
    destination: &str,
) {
    for &row_id in row_ids {
        let _ = db.mark_pending_move(row_id, destination_mailbox_id);
    }
    let _ = db.remove_moved_messages(account_id, row_ids, destination);
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
) -> Result<Option<i64>, String> {
    let operation = move_operation_for(state, &account_id, message_id, &source, uid, &destination)?;
    let account = state.db.account(&account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let remote_message_id = state.db.message_rfc_id(message_id).ok().flatten();
    let remote_result = mail::move_remote(
        &account,
        &password,
        &source,
        &destination,
        uid,
        operation.uid_validity,
        mail::MoveOptions {
            message_id: remote_message_id.as_deref(),
            dedupe_existing: false,
            replay_flags: None,
        },
    )
    .await;
    let remote_succeeded = remote_result.is_ok();
    if let Err(error) = remote_result {
        if error.terminal {
            return Err(error.message);
        }
        let dedupe_key = format!("move:{message_id}");
        state
            .db
            .queue_operation(&account_id, "move", &operation, Some(&dedupe_key))?;
        if let Err(error) = state.db.mark_pending_move(message_id, destination_id) {
            let _ = state
                .db
                .remove_operation_by_dedupe(&account_id, &dedupe_key);
            return Err(error);
        }
    } else {
        record_live_moves(
            &state.db,
            &account_id,
            &[message_id],
            destination_id,
            &destination,
        );
        let policy = account_policy(state, &account_id).unwrap_or_default();
        let _ =
            mail::refresh_mailbox_envelopes(&account, &password, &destination, &state.db, &policy)
                .await;
    }
    emit_message_change(app, &account_id, Some(message_id), "moved");
    emit_folder_counts(app, &account_id);
    if !remote_succeeded || remote_message_id.is_none() {
        return Ok(None);
    }
    Ok(state
        .db
        .find_message_by_header_id_in_mailbox(
            &account_id,
            destination_id,
            remote_message_id.as_deref().unwrap_or_default(),
        )
        .ok()
        .flatten()
        .map(|summary| summary.id))
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
    let password = crate::oauth::session_secret(&account).await?;
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
        match remote {
            Ok(()) => {
                for (id, _) in &entries {
                    if state
                        .db
                        .record_flag_change(account_id, *id, is_read, is_starred, None)
                        .is_ok()
                    {
                        updated += 1;
                    } else {
                        failed += 1;
                    }
                }
            }
            Err(error) if error.terminal => failed += ids.len(),
            Err(_) => {
                for (id, uid) in &entries {
                    let operation = FlagOperation {
                        message_id: *id,
                        uid: *uid,
                        mailbox: mailbox.clone(),
                        uid_validity: Some(validity),
                        is_read,
                        is_starred,
                    };
                    let payload = serde_json::to_value(&operation)
                        .map_err(|_| "Could not queue the flag change.".to_string())?;
                    if state
                        .db
                        .record_flag_change(account_id, *id, is_read, is_starred, Some(&payload))
                        .is_ok()
                    {
                        queued += 1;
                    } else {
                        failed += 1;
                    }
                }
            }
        }
    }
    Ok(BulkOutcome {
        updated,
        queued,
        failed,
    })
}

#[tauri::command]
pub async fn set_messages_pinned(
    account_id: String,
    message_ids: Vec<i64>,
    pinned: bool,
    state: State<'_, AppState>,
) -> CommandResult<u32> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.set_pinned(&account_id, &message_ids, pinned)
    })
    .await
    .map_err(|_| "Postal Snap could not pin those messages.".to_string())?;
    command_result(result)
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
    undo_token: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<BulkOutcome> {
    if message_ids.len() > MAX_BULK_MESSAGES {
        return Err("Select up to 200 messages at a time.".into());
    }
    if let Some(token) = undo_token.as_deref() {
        validate_undo_token(token)?;
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
    if let Some(token) = undo_token.as_deref() {
        let outcome = defer_bulk_moves(
            &state.db,
            &account_id,
            &sources,
            destination_mailbox_id,
            &destination,
            token,
        );
        emit_message_change(&app, &account_id, None, "moved");
        emit_folder_counts(&app, &account_id);
        return Ok(outcome);
    }
    let account = state.db.account(&account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
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
            let ids: Vec<i64> = entries.iter().map(|(id, _)| *id).collect();
            record_live_moves(
                &state.db,
                &account_id,
                &ids,
                destination_mailbox_id,
                &destination,
            );
            updated += entries.len();
        } else if remote.as_ref().is_err_and(|error| error.terminal) {
            failed += entries.len();
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
                let queued_ok = state
                    .db
                    .queue_operation(&account_id, "move", &operation, Some(&dedupe_key))
                    .is_ok();
                let marked_ok = queued_ok
                    && state
                        .db
                        .mark_pending_move(*id, destination_mailbox_id)
                        .is_ok();
                if marked_ok {
                    queued += 1;
                } else {
                    if queued_ok {
                        let _ = state
                            .db
                            .remove_operation_by_dedupe(&account_id, &dedupe_key);
                    }
                    failed += 1;
                }
            }
        }
    }
    if updated > 0 {
        let policy = account_policy(&state, &account_id).unwrap_or_default();
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

/// Queue a bulk move behind the undo window. Nothing touches the network, and
/// one transaction covers the whole group.
fn defer_bulk_moves(
    db: &Database,
    account_id: &str,
    sources: &[(String, Vec<(i64, u32)>)],
    destination_mailbox_id: i64,
    destination: &str,
    undo_token: &str,
) -> BulkOutcome {
    let mut failed = 0usize;
    let mut entries = Vec::new();
    for (source, messages) in sources {
        let Ok(Some(validity)) = db.mailbox_uid_validity(account_id, source) else {
            failed += messages.len();
            continue;
        };
        for (id, uid) in messages {
            let operation = MoveOperation {
                message_id: *id,
                uid: *uid,
                source: source.clone(),
                destination: destination.to_string(),
                uid_validity: Some(validity),
            };
            entries.push((*id, operation, destination_mailbox_id));
        }
    }
    let total = entries.len();
    match db.defer_moves(account_id, &entries, undo_token, undo_not_before()) {
        Ok(()) => BulkOutcome {
            updated: 0,
            queued: total,
            failed,
        },
        Err(_) => BulkOutcome {
            updated: 0,
            queued: 0,
            failed: failed + total,
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoDeferredOutcome {
    pub restored: usize,
    pub already_committed: bool,
}

/// Start the frontend's undo session and replay moves left by an older page.
#[tauri::command]
pub async fn begin_undo_session(state: State<'_, AppState>) -> CommandResult<String> {
    let session = state.db.begin_undo_session()?;
    for account in state.db.list_accounts()? {
        let _ = state.request(&account.id, wake::REPLAY);
    }
    Ok(session)
}

/// Cancel a queued move from its undo window. Works offline: it only edits
/// the local queue and the local row.
#[tauri::command]
pub async fn undo_deferred(
    account_id: String,
    undo_token: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<UndoDeferredOutcome> {
    validate_undo_token(&undo_token)?;
    let _guard = state.lock_account(&account_id).await?;
    let (restored, already_committed) = state.db.undo_deferred(&account_id, &undo_token)?;
    if restored > 0 {
        emit_message_change(&app, &account_id, None, "moved");
        emit_folder_counts(&app, &account_id);
    }
    Ok(UndoDeferredOutcome {
        restored,
        already_committed,
    })
}

/// Make a window's moves due now and wake the worker to replay them.
#[tauri::command]
pub async fn commit_deferred(
    account_id: String,
    undo_token: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    validate_undo_token(&undo_token)?;
    let _guard = state.lock_account(&account_id).await?;
    state.db.commit_deferred(&account_id, &undo_token)?;
    state.request(&account_id, wake::REPLAY)?;
    Ok(())
}

#[tauri::command]
pub async fn copy_messages_to_mailbox(
    account_id: String,
    message_ids: Vec<i64>,
    destination_mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<BulkOutcome> {
    if message_ids.len() > MAX_BULK_MESSAGES {
        return Err("Select up to 200 messages at a time.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (destination_account_id, destination) = state.db.mailbox(destination_mailbox_id)?;
    if destination_account_id != account_id {
        return Err("Messages cannot be copied between accounts.".into());
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
    let password = crate::oauth::session_secret(&account).await?;
    let mut updated = 0usize;
    let mut queued = 0usize;
    let mut failed = 0usize;
    for (source, entries) in sources {
        let Some(validity) = state.db.mailbox_uid_validity(&account_id, &source)? else {
            failed += entries.len();
            continue;
        };
        let uids: Vec<u32> = entries.iter().map(|(_, uid)| *uid).collect();
        let remote = mail::copy_remote_uids(
            &account,
            &password,
            &source,
            &destination,
            &uids,
            Some(validity),
        )
        .await;
        if remote.is_ok() {
            updated += entries.len();
        } else if remote.as_ref().is_err_and(|error| error.terminal) {
            failed += entries.len();
        } else {
            for (id, uid) in &entries {
                let operation = MoveOperation {
                    message_id: *id,
                    uid: *uid,
                    source: source.clone(),
                    destination: destination.clone(),
                    uid_validity: Some(validity),
                };
                let dedupe_key = format!("copy:{id}:{destination}");
                if state
                    .db
                    .queue_operation(&account_id, "copy", &operation, Some(&dedupe_key))
                    .is_ok()
                {
                    queued += 1;
                } else {
                    failed += 1;
                }
            }
        }
    }
    if updated > 0 {
        let policy = account_policy(&state, &account_id).unwrap_or_default();
        let _ =
            mail::refresh_mailbox_envelopes(&account, &password, &destination, &state.db, &policy)
                .await;
    }
    emit_message_change(&app, &account_id, None, "copied");
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
    let (_, name) = state.db.mailbox(mailbox_id)?;
    let mut outcome = BulkOutcome {
        updated: 0,
        queued: 0,
        failed: 0,
    };
    for chunk in unread.chunks(200) {
        let items: Vec<(i64, String, u32)> = chunk
            .iter()
            .map(|(id, uid)| (*id, name.clone(), *uid))
            .collect();
        let batch = bulk_apply_flags(&state, &account_id, &items, Some(true), None).await?;
        outcome.updated += batch.updated;
        outcome.queued += batch.queued;
        outcome.failed += batch.failed;
    }
    // Only cached rows were flagged above; older unread mail exists only on
    // the server. Mark everything up to the current UIDNEXT there too, so the
    // authoritative STATUS count agrees on the next refresh.
    if let Ok(account) = state.db.account(&account_id) {
        let Ok(password) = crate::oauth::session_secret(&account).await else {
            emit_message_change(&app, &account_id, None, "flags");
            emit_folder_counts(&app, &account_id);
            return Ok(outcome);
        };
        if let Some(validity) = state.db.mailbox_uid_validity(&account_id, &name)? {
            if mail::mark_folder_read(&account, &password, &name, validity)
                .await
                .is_ok()
            {
                let policy = account_policy(&state, &account_id).unwrap_or_default();
                let _ =
                    mail::refresh_mailbox_envelopes(&account, &password, &name, &state.db, &policy)
                        .await;
            }
        }
    }
    emit_message_change(&app, &account_id, None, "flags");
    emit_folder_counts(&app, &account_id);
    Ok(outcome)
}

#[tauri::command]
pub async fn list_recent_searches(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || db.list_recent_searches(&account_id))
        .await
        .map_err(|_| "Postal Snap could not open recent searches.".to_string())?;
    command_result(result)
}

#[tauri::command]
pub async fn remember_search(
    account_id: String,
    query: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    let db = state.db.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || db.remember_search(&account_id, &query))
            .await
            .map_err(|_| "Postal Snap could not save this search.".to_string())?;
    command_result(result)
}

#[tauri::command]
pub async fn forget_recent_search(
    account_id: String,
    query: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    let db = state.db.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || db.forget_recent_search(&account_id, &query))
            .await
            .map_err(|_| "Postal Snap could not remove this search.".to_string())?;
    command_result(result)
}

#[tauri::command]
pub async fn forget_recent_searches(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let db = state.db.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || db.forget_recent_searches(&account_id))
            .await
            .map_err(|_| "Postal Snap could not clear recent searches.".to_string())?;
    command_result(result)
}

#[tauri::command]
pub async fn search_cached_messages(
    query: SearchQuery,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MessageSummary>> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(mailbox_id) = query.mailbox_id {
            let (owner, _) = db.mailbox(mailbox_id)?;
            if owner != query.account_id {
                return Err("Mailbox does not belong to this account.".to_string());
            }
        } else {
            db.account(&query.account_id)?;
        }
        db.search(&query)
    })
    .await
    .map_err(|_| "Postal Snap could not search the local cache.".to_string())?;
    command_result(result)
}

#[tauri::command]
pub async fn search_server_messages(
    query: SearchQuery,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MessageSummary>> {
    // Search progress is shown by the search UI. It must not overwrite the
    // account's sync state, which may be reporting "Sign-in failed".
    let actor = state.actor(&query.account_id)?;
    actor.request(super::wake::OPERATION);
    let guard = actor.acquire().await;
    let mut hooks = SearchHooks {
        actor,
        guard: Some(guard),
    };
    let account = state.db.account(&query.account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    command_result(mail::server_search(&state.db, &account, &password, &query, &mut hooks).await)
}

/// Lets a server search hand the account to waiting user actions between
/// mailboxes.
struct SearchHooks {
    actor: std::sync::Arc<super::AccountActor>,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl mail::SyncHooks for SearchHooks {
    fn contended(&self) -> bool {
        self.actor.contended()
    }

    async fn yield_account(&mut self) {
        self.guard.take();
        tokio::task::yield_now().await;
        self.guard = Some(self.actor.acquire().await);
    }

    fn progress(&mut self, _folder: &str) {}
}

#[cfg(test)]
mod content_plan_tests {
    use super::{content_plan, ContentPlan, Need};
    use crate::db::BodyState;
    use crate::mail::sync::BodyFetch;

    const LARGE: u64 = 3 * 1024 * 1024;

    fn state(has_raw: bool, body_partial: bool, html_has_cid: bool) -> BodyState {
        BodyState {
            has_raw,
            body_partial,
            html_has_cid,
        }
    }

    // Failure modes for lazy attachments:
    // 1. An attachment or source action reads a prefix (E6).
    // 2. A partial message with inline images never upgrades when online (E10).
    // 3. A row with a complete body downloads again.
    #[test]
    fn full_need_on_a_partial_row_downloads_the_whole_message() {
        assert_eq!(
            content_plan(Need::Full, state(false, true, false), LARGE, false),
            ContentPlan::Download(BodyFetch::Full)
        );
        assert_eq!(
            content_plan(Need::Full, state(false, false, false), LARGE, false),
            ContentPlan::Download(BodyFetch::Full)
        );
        assert_eq!(
            content_plan(Need::Full, state(true, false, false), LARGE, false),
            ContentPlan::Ready
        );
    }

    #[test]
    fn text_need_is_ready_for_a_partial_row_without_inline_images() {
        assert_eq!(
            content_plan(Need::Text, state(false, true, false), LARGE, false),
            ContentPlan::Ready
        );
        assert_eq!(
            content_plan(Need::Text, state(false, true, true), LARGE, false),
            ContentPlan::UpgradeCid
        );
    }

    #[test]
    fn text_need_on_an_envelope_fetches_a_prefix_only_for_large_messages() {
        assert_eq!(
            content_plan(Need::Text, state(false, false, false), LARGE, false),
            ContentPlan::Download(BodyFetch::Partial)
        );
        assert_eq!(
            content_plan(Need::Text, state(false, false, false), 4096, false),
            ContentPlan::Download(BodyFetch::Full)
        );
        assert_eq!(
            content_plan(Need::Text, state(false, false, false), LARGE, true),
            ContentPlan::Download(BodyFetch::Full)
        );
    }
}

#[cfg(test)]
mod undo_session_tls_tests {
    use chrono::{Duration as ChronoDuration, Utc};
    use tempfile::TempDir;

    use crate::{
        db::Database,
        mail,
        models::{
            AccountRecord, AccountSummary, BodyFormat, CachePolicy, ProviderKind, ServerConfig,
            TlsMode,
        },
    };

    const PASSWORD: &str = "mail-test-password";
    const EMAIL: &str = "user@example.test";

    struct Fixture {
        db: Database,
        _directory: TempDir,
        account: AccountRecord,
        account_id: String,
        message_id: String,
        row_id: i64,
        uid: u32,
        uid_validity: u32,
        archive_id: i64,
    }

    fn account() -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                id: uuid::Uuid::new_v4().to_string(),
                provider: ProviderKind::Manual,
                email: EMAIL.into(),
                display_name: "Undo session integration fixture".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                signature_html: String::new(),
                reply_to: String::new(),
                color: None,
                default_body_format: BodyFormat::Plain,
            },
            imap: ServerConfig {
                host: "localhost".into(),
                port: 3993,
                tls_mode: TlsMode::Tls,
                username: EMAIL.into(),
                trusted_certificate: None,
            },
            smtp: ServerConfig {
                host: "localhost".into(),
                port: 3465,
                tls_mode: TlsMode::Tls,
                username: EMAIL.into(),
                trusted_certificate: None,
            },
        }
    }

    async fn fixture() -> Fixture {
        assert_eq!(
            std::env::var("POSTAL_SNAP_MAIL_INTEGRATION").as_deref(),
            Ok("1")
        );
        let account = account();
        let account_id = account.summary.id.clone();
        let directory = tempfile::tempdir().expect("temporary database directory");
        let database_path = directory.path().join("mail.sqlite3");
        let db = Database::open(&database_path).expect("open temporary database");
        db.insert_account(&account)
            .expect("insert synthetic account");

        let message_id = format!("<undo-session-{}@example.test>", uuid::Uuid::new_v4());
        let raw = format!(
            "From: sender@example.test\r\nTo: {EMAIL}\r\nSubject: Undo session fixture\r\nMessage-ID: {message_id}\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic undo session body."
        );
        let mut session = mail::connect::connect_imap(&account.imap, PASSWORD)
            .await
            .expect("connect to synthetic GreenMail over verified TLS");
        let _ = session.create("Archive").await;
        session
            .append("INBOX", None, None, raw.as_bytes())
            .await
            .expect("append synthetic message");
        session.logout().await.expect("close setup session");

        mail::sync::sync_account(
            &db,
            &account,
            PASSWORD,
            &CachePolicy::default(),
            &mut mail::sync::Uncontended,
        )
        .await
        .expect("sync the synthetic message");
        let inbox_id = db
            .mailbox_id_for_name(&account_id, "INBOX")
            .expect("look up Inbox")
            .expect("Inbox was synced");
        let cached = db
            .list_messages(inbox_id, None, 100)
            .expect("list cached messages")
            .items
            .into_iter()
            .find(|message| message.message_id.as_deref() == Some(message_id.as_str()))
            .expect("synthetic message was cached");
        let uid_validity = db
            .mailbox_uid_validity(&account_id, "INBOX")
            .expect("read Inbox UIDVALIDITY")
            .expect("GreenMail reports UIDVALIDITY");
        let archive_id = db
            .mailbox_id_for_name(&account_id, "Archive")
            .expect("look up Archive")
            .expect("Archive was synced");

        Fixture {
            db,
            _directory: directory,
            account,
            account_id,
            message_id,
            row_id: cached.id,
            uid: cached.uid,
            uid_validity,
            archive_id,
        }
    }

    fn defer(fixture: &Fixture, token: &str, not_before: chrono::DateTime<Utc>) {
        let operation = serde_json::json!({
            "messageId": fixture.row_id,
            "uid": fixture.uid,
            "source": "INBOX",
            "destination": "Archive",
            "uidValidity": fixture.uid_validity,
        });
        fixture
            .db
            .defer_moves(
                &fixture.account_id,
                &[(fixture.row_id, operation, fixture.archive_id)],
                token,
                not_before,
            )
            .expect("defer synthetic move");
    }

    async fn replay(fixture: &Fixture) -> bool {
        super::super::replay_offline_operations_with_notification(
            &fixture.db,
            &fixture.account,
            PASSWORD,
            &CachePolicy::default(),
            |_, _| {},
        )
        .await
        .expect("run production offline replay")
    }

    async fn server_count(fixture: &Fixture, mailbox: &str) -> usize {
        let mut session = mail::connect::connect_imap(&fixture.account.imap, PASSWORD)
            .await
            .expect("connect to synthetic GreenMail to verify state");
        session
            .select(mailbox)
            .await
            .expect("select synthetic mailbox");
        let matches = session
            .search(format!("HEADER Message-ID \"{}\"", fixture.message_id))
            .await
            .expect("search synthetic message ID");
        session.logout().await.expect("close verification session");
        matches.len()
    }

    // Failure modes for A19: a live frontend's move replays at its expired
    // deadline; offline Undo leaves a replayable move behind; startup leaves
    // an abandoned hold permanent; stale enqueue races rotation; or replay
    // moves the message more than once.
    #[tokio::test]
    #[ignore = "requires npm run test:mail-integration"]
    async fn greenmail_undo_session_holds_expired_move_then_recovers_once_on_restart() {
        let fixture = fixture().await;
        let live_session = fixture.db.begin_undo_session().unwrap();
        let live_token = format!("{live_session}{}", "c".repeat(32));
        defer(
            &fixture,
            &live_token,
            Utc::now() - ChronoDuration::seconds(1),
        );

        assert!(fixture
            .db
            .queued_operations(&fixture.account_id)
            .unwrap()
            .is_empty());
        assert!(fixture
            .db
            .next_deferred_due(&fixture.account_id)
            .unwrap()
            .is_none());
        assert!(!replay(&fixture).await);
        assert_eq!(server_count(&fixture, "INBOX").await, 1);
        assert_eq!(server_count(&fixture, "Archive").await, 0);

        assert_eq!(
            fixture
                .db
                .undo_deferred(&fixture.account_id, &live_token)
                .unwrap(),
            (1, false),
            "undo edits the local queue while the account is offline"
        );
        assert!(!replay(&fixture).await);
        assert_eq!(server_count(&fixture, "INBOX").await, 1);
        assert_eq!(server_count(&fixture, "Archive").await, 0);

        let restart_token = format!("{live_session}{}", "d".repeat(32));
        defer(
            &fixture,
            &restart_token,
            Utc::now() + ChronoDuration::minutes(5),
        );
        let database_path = fixture._directory.path().join("mail.sqlite3");
        let account_id = fixture.account_id.clone();
        let account = fixture.account.clone();
        let message_id = fixture.message_id.clone();
        let row_id = fixture.row_id;
        let uid = fixture.uid;
        let uid_validity = fixture.uid_validity;
        let archive_id = fixture.archive_id;
        let Fixture {
            db,
            _directory: directory,
            ..
        } = fixture;
        drop(db);

        let db = Database::open(&database_path).expect("reopen durable mail database");
        let restarted_session = db.begin_undo_session().unwrap();
        assert_ne!(restarted_session, live_session);
        assert_eq!(db.queued_operations(&account_id).unwrap().len(), 1);
        assert!(db
            .defer_moves::<serde_json::Value>(
                &account_id,
                &[],
                &restart_token,
                Utc::now() + ChronoDuration::minutes(5),
            )
            .is_err());
        let reopened = Fixture {
            db,
            _directory: directory,
            account,
            account_id,
            message_id,
            row_id,
            uid,
            uid_validity,
            archive_id,
        };
        assert!(!replay(&reopened).await);
        assert_eq!(server_count(&reopened, "INBOX").await, 0);
        assert_eq!(server_count(&reopened, "Archive").await, 1);
        assert!(!replay(&reopened).await);
        assert_eq!(server_count(&reopened, "INBOX").await, 0);
        assert_eq!(server_count(&reopened, "Archive").await, 1);
    }
}
