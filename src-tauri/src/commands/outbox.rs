use crate::outbox_reason::OutboxReason;
use tauri::{AppHandle, State};

use super::{
    command_result, emit_draft_change, emit_folder_counts, emit_message_change, emit_outbox_change,
    release_attachment_tokens, resolve_draft_files, validate_owned_compose, wake, AppState,
    CommandResult,
};

/// Automatic tries after "try later" replies before the user decides.
const MAX_AUTOMATIC_RETRIES: u32 = 8;
const SENT_COPY_PENDING_DETAIL: OutboxReason = OutboxReason::SentCopyPending;
const ARCHIVE_PENDING_DETAIL: OutboxReason = OutboxReason::ArchivePending;
const ARCHIVE_SOURCE_UNAVAILABLE_DETAIL: OutboxReason = OutboxReason::ArchiveSourceUnavailable;
const CONFIRMED_SEND_STATUS_ERROR: &str =
    "Message sent. Postal Snap could not save its follow-up status. It will not resend automatically; check Sent and Outbox before retrying.";

/// Next state and reason after a definite "not sent" reply, given the
/// deferred-retry bookkeeping result. A failed retry-count write still parks
/// the row in needs_attention with DeliveryUncertain: the row must never stay
/// in `sending`, and the queue cannot honestly claim an automatic retry is
/// scheduled when the wait was never recorded.
fn not_sent_retry_state(defer: Result<bool, String>) -> (&'static str, OutboxReason) {
    match defer {
        Ok(true) => ("queued", OutboxReason::RetryPending),
        Ok(false) => ("needs_attention", OutboxReason::RetryExhausted),
        Err(_) => ("needs_attention", OutboxReason::RetryUnavailable),
    }
}

fn persist_confirmed_send_state(
    state: &AppState,
    outbox_id: &str,
    account_id: &str,
    next_state: &str,
    detail: OutboxReason,
) -> bool {
    if matches!(
        state
            .db
            .set_outbox_reason_durable(outbox_id, account_id, next_state, Some(detail)),
        Ok(true)
    ) {
        return true;
    }
    state
        .db
        .set_outbox_reason(outbox_id, account_id, next_state, Some(detail))
        .unwrap_or(false)
}

async fn archive_source_after_delivery(
    source: Result<Option<crate::db::outbox::OutboxArchiveSource>, String>,
    account_id: &str,
    account: &crate::models::AccountRecord,
    password: &str,
    app: &AppHandle,
    state: &AppState,
    dedupe_existing: bool,
) -> Option<OutboxReason> {
    let source = match source {
        Ok(Some(source)) => source,
        Ok(None) => return None,
        Err(_) => return Some(OutboxReason::ArchiveFailed),
    };
    let message_id = source.message_id;
    let source_id = source.source_mailbox_id;
    // Which warning to keep is a value, never a comparison of wording.
    enum ArchiveFailure {
        SourceMoved,
        Failed,
    }
    let result = async {
        let (destination_id, destination) = state
            .db
            .mailbox_for_role(account_id, "archive")
            .map_err(|_| ArchiveFailure::Failed)?
            .ok_or(ArchiveFailure::Failed)?;
        if source.current_mailbox_id == Some(destination_id) && source.pending_move_to.is_none() {
            return Ok(());
        }
        if source.current_mailbox_id != Some(source_id) || source.pending_move_to.is_some() {
            return Err(ArchiveFailure::SourceMoved);
        }
        let (owner_id, source, uid) = state
            .db
            .message_location(message_id)
            .map_err(|_| ArchiveFailure::Failed)?;
        if owner_id != account_id {
            return Err(ArchiveFailure::Failed);
        }
        let (source_owner_id, recorded_source) = state
            .db
            .mailbox(source_id)
            .map_err(|_| ArchiveFailure::Failed)?;
        if source_owner_id != account_id || source != recorded_source {
            return Err(ArchiveFailure::Failed);
        }
        if source_id == destination_id {
            return Ok(());
        }
        let validity = state
            .db
            .mailbox_uid_validity(account_id, &source)
            .map_err(|_| ArchiveFailure::Failed)?
            .ok_or(ArchiveFailure::Failed)?;
        // Keyword writes land on the source first; the move carries them to
        // the archive copy. A transient failure keeps the message in place.
        if super::replied::finish_source_keywords(
            &state.db,
            account_id,
            message_id,
            |operation| async move {
                mail::set_remote_keyword(
                    account,
                    password,
                    &operation.mailbox,
                    operation.uid,
                    operation.uid_validity,
                    operation.keyword,
                )
                .await
            },
        )
        .await
        .is_err()
        {
            return Err(ArchiveFailure::Failed);
        }
        let remote_id = state.db.message_rfc_id(message_id).ok().flatten();
        match mail::move_remote(
            account,
            password,
            &source,
            &destination,
            uid,
            Some(validity),
            mail::MoveOptions {
                message_id: remote_id.as_deref(),
                dedupe_existing,
                replay_flags: None,
            },
        )
        .await
        {
            Ok(()) => {
                super::messages::record_live_moves(
                    &state.db,
                    account_id,
                    &[message_id],
                    destination_id,
                    &destination,
                );
                let policy = super::sync::account_policy(state, account_id).unwrap_or_default();
                let _ = mail::refresh_mailbox_envelopes(
                    account,
                    password,
                    &destination,
                    &state.db,
                    &policy,
                )
                .await;
            }
            Err(_) => return Err(ArchiveFailure::Failed),
        }
        emit_message_change(app, account_id, Some(message_id), "moved");
        emit_folder_counts(app, account_id);
        Ok::<(), ArchiveFailure>(())
    }
    .await;
    match result {
        Ok(()) => None,
        Err(ArchiveFailure::SourceMoved) => Some(ARCHIVE_SOURCE_UNAVAILABLE_DETAIL),
        Err(ArchiveFailure::Failed) => Some(ARCHIVE_PENDING_DETAIL),
    }
}

#[allow(clippy::too_many_arguments)]
async fn finalize_sent_outbox(
    outbox_id: &str,
    account_id: &str,
    draft: &crate::models::ComposeDraft,
    account: &crate::models::AccountRecord,
    password: &str,
    archive_source: Result<Option<crate::db::outbox::OutboxArchiveSource>, String>,
    dedupe_existing: bool,
    app: &AppHandle,
    state: &AppState,
) -> Result<SendOutcome, String> {
    if let Some(draft_id) = draft.id.as_deref() {
        let _ = state.db.remove_draft(draft_id, account_id);
    }

    let archive_requested = !matches!(&archive_source, Ok(None));
    if archive_requested {
        // This durable state records confirmed SMTP success before any archive
        // network call can be interrupted by a restart.
        if !persist_confirmed_send_state(
            state,
            outbox_id,
            account_id,
            "archive_pending",
            ARCHIVE_PENDING_DETAIL,
        ) {
            emit_outbox_change(app, account_id, Some(outbox_id), Some("sent_copy_pending"));
            return Ok(SendOutcome {
                id: outbox_id.to_string(),
                state: "sent_copy_pending".into(),
                detail: Some(CONFIRMED_SEND_STATUS_ERROR.into()),
            });
        }
        emit_outbox_change(app, account_id, Some(outbox_id), Some("archive_pending"));

        if let Some(detail) = archive_source_after_delivery(
            archive_source,
            account_id,
            account,
            password,
            app,
            state,
            dedupe_existing,
        )
        .await
        {
            let _ = persist_confirmed_send_state(
                state,
                outbox_id,
                account_id,
                "archive_pending",
                detail,
            );
            emit_outbox_change(app, account_id, Some(outbox_id), Some("archive_pending"));
            release_attachment_tokens(
                state,
                account_id,
                draft.attachments.iter().map(|item| item.token.as_str()),
            )
            .await;
            return Ok(SendOutcome {
                id: outbox_id.to_string(),
                state: "archive_pending".into(),
                detail: Some(detail.into()),
            });
        }
    }

    state.db.remove_outbox(outbox_id, account_id)?;
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
use crate::{
    mail,
    models::{validate_compose_draft, ComposeDraft, OutboxSummary, SendOutcome},
};

#[tauri::command(async)]
pub fn list_outbox(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<OutboxSummary>> {
    state.db.account(&account_id)?;
    command_result(state.db.list_outbox(&account_id))
}

#[tauri::command(async)]
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
    if outbox_state == "archive_pending" {
        return Err("This message was sent. Retry or dismiss its archive warning.".into());
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
    let draft = state.db.restore_outbox_as_draft(&outbox_id, &account_id)?;
    emit_outbox_change(&app, &account_id, Some(&outbox_id), Some("removed"));
    if let Some(draft_id) = draft.id.as_deref() {
        emit_draft_change(&app, &account_id, Some(draft_id), Some("localPending"));
    }
    let _ = state.request(&account_id, wake::DRAFTS);
    Ok(draft)
}

#[tauri::command]
pub async fn retry_outbox(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    // Check the outbox state under the account lock so a concurrent retry or
    // sync replay cannot flip the row between the check and the delivery try.
    let _guard = state.lock_account(&account_id).await?;
    let (mut draft, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    let account = state.db.account(&account_id)?;
    draft.html_body = crate::html_sanitize::sanitize_compose_html(&draft.html_body);
    validate_owned_compose(&draft, &account)?;
    if outbox_state != "needs_attention" {
        return Err("Only messages needing attention can be retried.".into());
    }
    command_result(
        deliver_outbox_locked(
            &outbox_id,
            &draft.account_id,
            "needs_attention",
            &app,
            &state,
        )
        .await,
    )
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

#[tauri::command]
pub async fn retry_archive_after_send(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SendOutcome> {
    let _guard = state.lock_account(&account_id).await?;
    let (_, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    if outbox_state != "archive_pending" {
        return Err("Only a pending post-send archive can be retried.".into());
    }
    command_result(retry_archive_after_send_locked(&outbox_id, &account_id, &app, &state).await)
}

#[tauri::command]
pub async fn dismiss_archive_warning(
    outbox_id: String,
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    let (draft, outbox_state) = state.db.outbox(&outbox_id, &account_id)?;
    if outbox_state != "archive_pending" {
        return Err("Only a post-send archive warning can be dismissed.".into());
    }
    state.db.dismiss_archive_warning(&outbox_id, &account_id)?;
    release_attachment_tokens(
        &state,
        &account_id,
        draft.attachments.iter().map(|item| item.token.as_str()),
    )
    .await;
    emit_outbox_change(&app, &account_id, Some(&outbox_id), Some("removed"));
    Ok(())
}

/// Deliver one outbox row. The caller holds the account lock and checked,
/// under that lock, that the row is in `from_state`; the claim fails if it
/// is not.
pub(crate) async fn deliver_outbox_locked(
    outbox_id: &str,
    account_id: &str,
    from_state: &str,
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
        let prepared = if draft.source_kind == Some(crate::models::DraftSourceKind::Redirect) {
            let Some(source_id) = draft.source_message_id else {
                return outbox_preparation_failed(
                    outbox_id,
                    account_id,
                    app,
                    state,
                    "Choose a message to redirect.".into(),
                );
            };
            let raw = match state.db.raw_message(source_id, account_id) {
                Ok(raw) => raw,
                Err(error) => {
                    return outbox_preparation_failed(outbox_id, account_id, app, state, error);
                }
            };
            match mail::prepare_redirect(&account, &draft, &raw) {
                Ok(prepared) => prepared,
                Err(error) => {
                    return outbox_preparation_failed(outbox_id, account_id, app, state, error);
                }
            }
        } else {
            // The queue keeps the unsigned draft for Undo; sign what goes out.
            let above_quote = state
                .settings
                .get()
                .map(|settings| settings.signature_above_quote)
                .unwrap_or(true);
            let signed = if draft.include_signature {
                mail::send::apply_signature_with_html(
                    draft.clone(),
                    &account.summary.signature,
                    &account.summary.signature_html,
                    above_quote,
                )
            } else {
                draft.clone()
            };
            let resolved = match resolve_draft_files(&state.db, &signed) {
                Ok(draft) => draft,
                Err(error) => {
                    return outbox_preparation_failed(outbox_id, account_id, app, state, error);
                }
            };
            match mail::prepare_message(&account, &resolved).await {
                Ok(prepared) => prepared,
                Err(error) => {
                    return outbox_preparation_failed(outbox_id, account_id, app, state, error);
                }
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
    let password = match crate::oauth::session_secret(&account).await {
        Ok(password) => password,
        Err(error) => {
            return outbox_preparation_failed(outbox_id, account_id, app, state, error);
        }
    };
    let Some(_delivery_guard) = state.try_start_delivery() else {
        return Ok(SendOutcome {
            id: outbox_id.to_string(),
            state: from_state.into(),
            detail: Some("Delivery is paused while Postal Snap installs an update.".into()),
        });
    };
    if !state
        .db
        .claim_outbox_delivery(outbox_id, account_id, from_state)?
    {
        return Err("This message is already sending.".into());
    }
    let sent = mail::send_prepared(&account, &password, &draft, &mime_bytes).await;
    let confirmation = sent.as_ref().map(|_| ()).map_err(|error| error.kind);
    match sent {
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
            let archive_source = state.db.outbox_archive_source(outbox_id, account_id);
            // SMTP accepted the message. Persist a non-sendable state before
            // Sent-copy or archive work can be interrupted by a restart.
            if !persist_confirmed_send_state(
                state,
                outbox_id,
                account_id,
                "sent_copy_pending",
                SENT_COPY_PENDING_DETAIL,
            ) {
                emit_outbox_change(app, account_id, Some(outbox_id), Some("sending"));
                return Ok(SendOutcome {
                    id: outbox_id.to_string(),
                    state: "sent_copy_pending".into(),
                    detail: Some(CONFIRMED_SEND_STATUS_ERROR.into()),
                });
            }
            emit_outbox_change(app, account_id, Some(outbox_id), Some("sent_copy_pending"));
            let sent_mailbox = state.db.mailbox_for_role(account_id, "sent").ok().flatten();
            let copy_result = match sent_mailbox {
                Some((_, mailbox)) => {
                    mail::ensure_sent_copy(&account, &password, &mailbox, &message_id, &mime_bytes)
                        .await
                }
                None => Err("This account has no confirmed Sent mailbox.".into()),
            };
            if copy_result.is_err() {
                if let Some(draft_id) = draft.id.as_deref() {
                    let _ = state.db.set_one_draft_sync_warning(
                        draft_id,
                        account_id,
                        "Message sent. This draft removes itself once the Sent copy is saved.",
                    );
                }
                // Row is final first, so a stalled IMAP flag call cannot leave a
                // delivered message in `sending` (restart would ask to resend).
                super::replied::mark_source_after_send(
                    app,
                    state,
                    &account,
                    &password,
                    &draft,
                    &confirmation,
                )
                .await;
                emit_outbox_change(app, account_id, Some(outbox_id), Some("sent_copy_pending"));
                return Ok(SendOutcome {
                    id: outbox_id.to_string(),
                    state: "sent_copy_pending".into(),
                    detail: Some(SENT_COPY_PENDING_DETAIL.into()),
                });
            }
            super::replied::mark_source_after_send(
                app,
                state,
                &account,
                &password,
                &draft,
                &confirmation,
            )
            .await;
            finalize_sent_outbox(
                outbox_id,
                account_id,
                &draft,
                &account,
                &password,
                archive_source,
                false,
                app,
                state,
            )
            .await
        }
        Err(error) => {
            // Only a definite "not accepted" may go back in the queue; an
            // uncertain send waits for the user so it is never sent twice.
            let (next_state, detail) = match error.kind {
                mail::SendFailure::NotSentRetry => not_sent_retry_state(
                    state
                        .db
                        .defer_outbox_retry(outbox_id, account_id, MAX_AUTOMATIC_RETRIES),
                ),
                mail::SendFailure::NotSentRefused => ("needs_attention", OutboxReason::SendRefused),
                mail::SendFailure::Uncertain => {
                    ("needs_attention", OutboxReason::DeliveryUncertain)
                }
            };
            state
                .db
                .set_outbox_reason(outbox_id, account_id, next_state, Some(detail))?;
            emit_outbox_change(app, account_id, Some(outbox_id), Some(next_state));
            Ok(SendOutcome {
                id: outbox_id.to_string(),
                state: next_state.into(),
                detail: Some(detail.into()),
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
    let password = crate::oauth::session_secret(&account).await?;
    let (_, mailbox) = state
        .db
        .mailbox_for_role(account_id, "sent")?
        .ok_or_else(|| "This account has no confirmed Sent mailbox.".to_string())?;
    let Some(_delivery_guard) = state.try_start_delivery() else {
        return Ok(SendOutcome {
            id: outbox_id.to_string(),
            state: "sent_copy_pending".into(),
            detail: Some("Sent copy is paused while Postal Snap installs an update.".into()),
        });
    };
    mail::ensure_sent_copy(&account, &password, &mailbox, &message_id, &mime_bytes).await?;
    let archive_source = state.db.outbox_archive_source(outbox_id, account_id);
    finalize_sent_outbox(
        outbox_id,
        account_id,
        &draft,
        &account,
        &password,
        archive_source,
        true,
        app,
        state,
    )
    .await
}

pub(crate) async fn retry_archive_after_send_locked(
    outbox_id: &str,
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<SendOutcome, String> {
    let (draft, state_name, _, _) = state.db.outbox_delivery(outbox_id, account_id)?;
    if state_name != "archive_pending" {
        return Err("Only a pending post-send archive can be retried.".into());
    }
    let account = state.db.account(account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let Some(_delivery_guard) = state.try_start_delivery() else {
        return Ok(SendOutcome {
            id: outbox_id.into(),
            state: "archive_pending".into(),
            detail: Some(ARCHIVE_PENDING_DETAIL.into()),
        });
    };

    let source = state.db.outbox_archive_source(outbox_id, account_id);
    let warning = match source {
        Ok(Some(source)) => {
            archive_source_after_delivery(
                Ok(Some(source)),
                account_id,
                &account,
                &password,
                app,
                state,
                true,
            )
            .await
        }
        Ok(None) => Some(ARCHIVE_SOURCE_UNAVAILABLE_DETAIL),
        Err(_) => Some(ARCHIVE_PENDING_DETAIL),
    };
    if let Some(detail) = warning {
        let _ =
            persist_confirmed_send_state(state, outbox_id, account_id, "archive_pending", detail);
        emit_outbox_change(app, account_id, Some(outbox_id), Some("archive_pending"));
        return Ok(SendOutcome {
            id: outbox_id.into(),
            state: "archive_pending".into(),
            detail: Some(detail.into()),
        });
    }

    state.db.remove_outbox(outbox_id, account_id)?;
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
    const DETAIL: OutboxReason = OutboxReason::PreparationFailed;
    let changed =
        state
            .db
            .set_outbox_reason(outbox_id, account_id, "needs_attention", Some(DETAIL))?;
    if changed {
        emit_outbox_change(app, account_id, Some(outbox_id), Some("needs_attention"));
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_sent_retry_state_parks_when_the_retry_wait_cannot_be_recorded() {
        assert_eq!(
            not_sent_retry_state(Ok(true)),
            ("queued", OutboxReason::RetryPending)
        );
        assert_eq!(
            not_sent_retry_state(Ok(false)),
            ("needs_attention", OutboxReason::RetryExhausted)
        );
        assert_eq!(
            not_sent_retry_state(Err("A queued message failed to wait.".into())),
            ("needs_attention", OutboxReason::RetryUnavailable)
        );
    }
}
