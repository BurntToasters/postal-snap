use tauri::{AppHandle, State};

use super::{
    command_result, emit_outbox_change, release_attachment_tokens, resolve_draft_files,
    validate_owned_compose, AppState, CommandResult,
};
use crate::{
    credentials, mail,
    models::{validate_compose_draft, ComposeDraft, OutboxSummary, SendOutcome},
};

#[tauri::command]
pub fn list_outbox(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<OutboxSummary>> {
    state.db.account(&account_id)?;
    command_result(state.db.list_outbox(&account_id))
}

#[tauri::command]
pub fn get_outbox(
    outbox_id: String,
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<ComposeDraft> {
    command_result(
        state
            .db
            .outbox(&outbox_id, &account_id)
            .map(|(draft, _)| draft),
    )
}

#[tauri::command]
pub async fn delete_outbox(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    let (draft, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    if outbox_state == "sending" {
        return Err("This message is already sending and cannot be stopped.".into());
    }
    state
        .db
        .remove_outbox_for_account(&outbox_id, &account_id)?;
    release_attachment_tokens(
        &state,
        &account_id,
        draft.attachments.iter().map(|item| item.token.as_str()),
    )
    .await;
    emit_outbox_change(&app, &account_id, Some(&outbox_id), Some("removed"));
    Ok(())
}

#[tauri::command]
pub async fn restore_outbox(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<ComposeDraft> {
    let _guard = state.lock_account(&account_id).await?;
    let (draft, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    if outbox_state == "sending" {
        return Err("This message is already sending and cannot be stopped.".into());
    }
    if !matches!(
        outbox_state.as_str(),
        "scheduled" | "queued" | "needs_attention"
    ) {
        return Err("This message cannot be restored.".into());
    }
    state
        .db
        .remove_outbox_for_account(&outbox_id, &account_id)?;
    emit_outbox_change(&app, &account_id, Some(&outbox_id), Some("removed"));
    Ok(draft)
}

#[tauri::command]
pub async fn retry_outbox(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    let (mut draft, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    let account = state.db.account(&account_id)?;
    draft.html_body = crate::html_sanitize::sanitize_compose_html(&draft.html_body);
    validate_owned_compose(&draft, &account)?;
    if outbox_state != "needs_attention" {
        return Err("Only messages needing attention can be retried.".into());
    }
    command_result(deliver_outbox(&outbox_id, &draft.account_id, &app, &state).await)
}

#[tauri::command]
pub async fn retry_sent_copy(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    let (_, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    if outbox_state != "sent_copy_pending" {
        return Err("Only a pending Sent copy can be saved again.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    command_result(retry_sent_copy_locked(&outbox_id, &account_id, &app, &state).await)
}

pub(crate) async fn deliver_outbox(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<SendOutcome, String> {
    let _guard = match state.lock_account(account_id).await {
        Ok(guard) => guard,
        Err(error) => {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
    };
    deliver_outbox_locked(outbox_id, account_id, app, state).await
}

pub(crate) async fn deliver_outbox_locked(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<SendOutcome, String> {
    let (mut draft, _state_name, mut message_id, mut mime_bytes) =
        match state.db.outbox_delivery(outbox_id, account_id) {
            Ok(value) => value,
            Err(error) => {
                return outbox_preparation_failed(outbox_id, account_id, app, state, error);
            }
        };
    draft.html_body = crate::html_sanitize::sanitize_compose_html(&draft.html_body);
    if let Err(error) = validate_compose_draft(&draft) {
        return outbox_preparation_failed(outbox_id, account_id, app, state, error);
    }
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return outbox_preparation_failed(
            outbox_id,
            account_id,
            app,
            state,
            "Add at least one recipient.".into(),
        );
    }
    let account = match state.db.account(account_id) {
        Ok(account) => account,
        Err(error) => {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
    };
    if let Err(error) = validate_owned_compose(&draft, &account) {
        return outbox_preparation_failed(outbox_id, account_id, app, state, error);
    }
    if message_id.is_empty() || mime_bytes.is_empty() {
        let resolved = match resolve_draft_files(&state.db, &draft) {
            Ok(draft) => draft,
            Err(error) => {
                return outbox_preparation_failed(outbox_id, account_id, app, state, error);
            }
        };
        let prepared = match mail::prepare_message(&account, &resolved).await {
            Ok(prepared) => prepared,
            Err(error) => {
                return outbox_preparation_failed(outbox_id, account_id, app, state, error);
            }
        };
        if let Err(error) = state.db.prepare_queued_outbox(
            outbox_id,
            account_id,
            &prepared.message_id,
            &prepared.bytes,
        ) {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
        message_id = prepared.message_id;
        mime_bytes = prepared.bytes;
    }
    let password = match credentials::load(account_id) {
        Ok(password) => password,
        Err(error) => {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
    };
    if !state.db.claim_outbox_delivery(outbox_id, account_id)? {
        return Err("This message is already sending.".into());
    }
    match mail::send_prepared(&account, &password, &draft, &mime_bytes).await {
        Ok(()) => {
            let history: Vec<(String, String)> = draft
                .to
                .iter()
                .chain(&draft.cc)
                .chain(&draft.bcc)
                .filter_map(|raw| {
                    raw.trim()
                        .parse::<lettre::message::Mailbox>()
                        .ok()
                        .map(|mailbox| {
                            (mailbox.email.to_string(), mailbox.name.unwrap_or_default())
                        })
                })
                .collect();
            let _ = state.db.record_recipients(account_id, &history);
            let sent_mailbox = state.db.mailbox_for_role(account_id, "sent")?;
            let copy_result = match sent_mailbox {
                Some((_, mailbox)) => {
                    mail::ensure_sent_copy(&account, &password, &mailbox, &message_id, &mime_bytes)
                        .await
                }
                None => Err("This account has no confirmed Sent mailbox.".into()),
            };
            if copy_result.is_err() {
                const DETAIL: &str =
                    "Message sent. Its Sent-folder copy is waiting for a safe retry.";
                state
                    .db
                    .set_outbox_state(outbox_id, "sent_copy_pending", Some(DETAIL))?;
                if let Some(draft_id) = draft.id.as_deref() {
                    let _ = state.db.set_one_draft_sync_warning(
                        draft_id,
                        account_id,
                        "Message sent. This draft removes itself once the Sent copy is saved.",
                    );
                }
                emit_outbox_change(app, account_id, Some(outbox_id), Some("sent_copy_pending"));
                return Ok(SendOutcome {
                    id: outbox_id.to_string(),
                    state: "sent_copy_pending".into(),
                    detail: Some(DETAIL.into()),
                });
            }
            state.db.remove_outbox(outbox_id)?;
            if let Some(draft_id) = draft.id.as_deref() {
                let _ = state.db.remove_draft(draft_id, account_id);
            }
            release_attachment_tokens(
                state,
                account_id,
                draft.attachments.iter().map(|item| item.token.as_str()),
            )
            .await;
            emit_outbox_change(app, account_id, Some(outbox_id), Some("sent"));
            Ok(SendOutcome {
                id: outbox_id.to_string(),
                state: "sent".into(),
                detail: None,
            })
        }
        Err(_) => {
            const DETAIL: &str =
                "Delivery could not be confirmed. Postal Snap will not resend automatically.";
            state
                .db
                .set_outbox_state(outbox_id, "needs_attention", Some(DETAIL))?;
            emit_outbox_change(app, account_id, Some(outbox_id), Some("needs_attention"));
            Ok(SendOutcome {
                id: outbox_id.to_string(),
                state: "needs_attention".into(),
                detail: Some(DETAIL.into()),
            })
        }
    }
}

pub(crate) async fn retry_sent_copy_locked(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<SendOutcome, String> {
    let (draft, state_name, message_id, mime_bytes) =
        state.db.outbox_delivery(outbox_id, account_id)?;
    if state_name != "sent_copy_pending" {
        return Err("Only a pending Sent copy can be saved again.".into());
    }
    let account = state.db.account(account_id)?;
    let password = credentials::load(account_id)?;
    let (_, mailbox) = state
        .db
        .mailbox_for_role(account_id, "sent")?
        .ok_or_else(|| "This account has no confirmed Sent mailbox.".to_string())?;
    mail::ensure_sent_copy(&account, &password, &mailbox, &message_id, &mime_bytes).await?;
    state.db.remove_outbox(outbox_id)?;
    if let Some(draft_id) = draft.id.as_deref() {
        let _ = state.db.remove_draft(draft_id, account_id);
    }
    release_attachment_tokens(
        state,
        account_id,
        draft.attachments.iter().map(|item| item.token.as_str()),
    )
    .await;
    emit_outbox_change(app, account_id, Some(outbox_id), Some("sent"));
    Ok(SendOutcome {
        id: outbox_id.into(),
        state: "sent".into(),
        detail: None,
    })
}

fn outbox_preparation_failed(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
    error: String,
) -> Result<SendOutcome, String> {
    const DETAIL: &str =
        "The message was not sent. Check its attachments and account, then try again.";
    state
        .db
        .set_outbox_state(outbox_id, "needs_attention", Some(DETAIL))?;
    emit_outbox_change(app, account_id, Some(outbox_id), Some("needs_attention"));
    Err(error)
}
