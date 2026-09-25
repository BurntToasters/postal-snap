use tauri::{AppHandle, State};

use super::outbox::deliver_outbox_locked;
use super::{
    cleanup_unreferenced_attachments, command_result, emit_draft_change, emit_outbox_change,
    prepare_owned_compose, release_attachment_tokens, resolve_draft_files, wake, AppState,
    CommandResult,
};
use crate::{
    mail,
    models::{ComposeDraft, DraftSaveOutcome, DraftSummary, SendOutcome},
};

#[tauri::command]
pub async fn save_draft(
    draft: ComposeDraft,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<DraftSaveOutcome> {
    // Serialize with delete_draft (and other account work) so a save racing a
    // discard cannot resurrect a just-deleted draft.
    let _guard = state.lock_account(&draft.account_id).await?;
    let account = state.db.account(&draft.account_id)?;
    let draft = prepare_owned_compose(draft, &account)?;
    let id = state.db.save_draft(&draft)?;
    cleanup_unreferenced_attachments(&state, &draft.account_id).await;
    // No wake-up here: autosave runs every few seconds while typing. The
    // worker pushes pending drafts within a minute of the last save.
    emit_draft_change(&app, &draft.account_id, Some(&id), Some("localPending"));
    Ok(DraftSaveOutcome {
        id,
        sync_state: "localPending".into(),
    })
}

#[tauri::command]
pub fn list_drafts(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<DraftSummary>> {
    state.db.account(&account_id)?;
    command_result(state.db.list_drafts(&account_id))
}

#[tauri::command]
pub fn get_draft(
    draft_id: String,
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<ComposeDraft> {
    command_result(state.db.draft(&draft_id, &account_id))
}

#[tauri::command]
pub async fn delete_draft(
    draft_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    let draft = state.db.draft(&draft_id, &account_id)?;
    state.db.remove_draft(&draft_id, &account_id)?;
    release_attachment_tokens(
        &state,
        &account_id,
        draft.attachments.iter().map(|item| item.token.as_str()),
    )
    .await;
    state.request(&account_id, wake::DRAFTS)?;
    emit_draft_change(&app, &account_id, Some(&draft_id), Some("deletePending"));
    Ok(())
}

/// Validate an explicit Send Later time. Returns the normalized RFC 3339
/// timestamp, or `None` when the composer did not request scheduling.
pub(crate) fn resolve_requested_send_at(send_at: Option<&str>) -> Result<Option<String>, String> {
    let requested = send_at.map(str::trim).filter(|value| !value.is_empty());
    let Some(requested) = requested else {
        return Ok(None);
    };
    let when = chrono::DateTime::parse_from_rfc3339(requested)
        .map_err(|_| "Scheduled send time is invalid.".to_string())?
        .with_timezone(&chrono::Utc);
    let now = chrono::Utc::now();
    if when <= now {
        return Err("Scheduled send time must be in the future.".to_string());
    }
    if when > now + chrono::Duration::days(365) {
        return Err("Scheduled send time is too far in the future.".to_string());
    }
    Ok(Some(when.to_rfc3339()))
}

#[tauri::command]
pub async fn send_message(
    draft: ComposeDraft,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    let account = state.db.account(&draft.account_id)?;
    let draft = mail::apply_signature(draft, &account.summary.signature);
    let draft = prepare_owned_compose(draft, &account)?;
    let resolved_draft = resolve_draft_files(&state.db, &draft)?;
    let prepared = mail::prepare_message(&account, &resolved_draft).await?;
    let settings = state.settings.get()?;
    let delay = settings.undo_send_seconds.min(30);
    let offline = account.summary.sync_state == "offline";
    let initial_detail = offline.then_some("Waiting for a secure mail connection.");
    if let Some(send_at) = resolve_requested_send_at(draft.send_at.as_deref())? {
        let detail = if offline {
            "Waiting for a secure mail connection."
        } else {
            "Scheduled to send."
        };
        let outbox_id = state.db.queue_outbox(
            &draft,
            "scheduled",
            Some(detail),
            &prepared.message_id,
            &prepared.bytes,
            Some(&send_at),
        )?;
        state.request(&draft.account_id, wake::OUTBOX)?;
        emit_outbox_change(&app, &draft.account_id, Some(&outbox_id), Some("scheduled"));
        return Ok(SendOutcome {
            id: outbox_id,
            state: "scheduled".into(),
            detail: Some(detail.into()),
        });
    }
    if delay > 0 {
        let send_at =
            (chrono::Utc::now() + chrono::Duration::seconds(i64::from(delay))).to_rfc3339();
        let detail = if offline {
            "Waiting for a secure mail connection."
        } else {
            "Held for review. Undo anytime before it sends."
        };
        let outbox_id = state.db.queue_outbox(
            &draft,
            "scheduled",
            Some(detail),
            &prepared.message_id,
            &prepared.bytes,
            Some(&send_at),
        )?;
        state.request(&draft.account_id, wake::OUTBOX)?;
        emit_outbox_change(&app, &draft.account_id, Some(&outbox_id), Some("scheduled"));
        return Ok(SendOutcome {
            id: outbox_id,
            state: "scheduled".into(),
            detail: Some(detail.into()),
        });
    }
    if offline {
        let outbox_id = state.db.queue_outbox(
            &draft,
            "queued",
            initial_detail,
            &prepared.message_id,
            &prepared.bytes,
            None,
        )?;
        state.request(&draft.account_id, wake::OUTBOX)?;
        emit_outbox_change(&app, &draft.account_id, Some(&outbox_id), Some("queued"));
        return Ok(SendOutcome {
            id: outbox_id,
            state: "queued".into(),
            detail: initial_detail.map(Into::into),
        });
    }
    let _guard = state.lock_account(&draft.account_id).await?;
    let outbox_id = state.db.queue_outbox(
        &draft,
        "queued",
        initial_detail,
        &prepared.message_id,
        &prepared.bytes,
        None,
    )?;
    command_result(
        deliver_outbox_locked(&outbox_id, &draft.account_id, "queued", &app, &state).await,
    )
}

#[tauri::command]
pub async fn send_scheduled_outbox(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    let account = state.db.account(&account_id)?;
    // The account worker delivers due messages on its own timer; the window's
    // undo-send timer can ask at the same moment. Whichever arrives second
    // sees the result here instead of sending again.
    let _guard = state.lock_account(&account_id).await?;
    let outbox_state = match state.db.outbox(&outbox_id, &account_id) {
        Ok((_, outbox_state)) => outbox_state,
        Err(_) => {
            return Ok(SendOutcome {
                id: outbox_id,
                state: "removed".into(),
                detail: None,
            });
        }
    };
    if outbox_state != "scheduled" {
        return Ok(SendOutcome {
            id: outbox_id,
            state: outbox_state,
            detail: None,
        });
    }
    if account.summary.sync_state == "offline" {
        return Ok(SendOutcome {
            id: outbox_id,
            state: "scheduled".into(),
            detail: Some("Waiting for a secure mail connection.".into()),
        });
    }
    command_result(deliver_outbox_locked(&outbox_id, &account_id, "scheduled", &app, &state).await)
}
