use tauri::{AppHandle, State};

use super::outbox::deliver_outbox_locked;
use super::{
    cleanup_unreferenced_attachments, command_result, emit_draft_change, emit_outbox_change,
    prepare_owned_compose, release_attachment_tokens, resolve_draft_files, wake, AppState,
    CommandResult,
};
use crate::{
    mail,
    models::{
        receipt_mailbox, BodyFormat, ComposeDraft, DraftSaveOutcome, DraftSourceKind, DraftSummary,
        SendOutcome,
    },
    oauth,
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

/// The draft to keep in the outbox, and the signed copy to send.
pub(crate) fn sign_for_outbox(
    draft: ComposeDraft,
    signature: &str,
    above_quote: bool,
) -> (ComposeDraft, ComposeDraft) {
    let signature = if draft.include_signature {
        signature
    } else {
        ""
    };
    let signed = mail::apply_signature(draft.clone(), signature, above_quote);
    (draft, signed)
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
    let draft = prepare_owned_compose(draft, &account)?;
    // The queue stores the unsigned draft so Undo Send and editing never
    // repeat the signature; the prepared MIME carries it.
    let settings = state.settings.get()?;
    let (draft, signed) = sign_for_outbox(
        draft,
        &account.summary.signature,
        settings.signature_above_quote,
    );
    let prepared = if draft.source_kind == Some(DraftSourceKind::Redirect) {
        let source_id = draft
            .source_message_id
            .ok_or_else(|| "Choose a message to redirect.".to_string())?;
        super::messages::ensure_message_content(&draft.account_id, source_id, &state).await?;
        let raw = state.db.raw_message(source_id, &draft.account_id)?;
        mail::prepare_redirect(&account, &draft, &raw)?
    } else {
        let resolved_draft = resolve_draft_files(&state.db, &signed)?;
        mail::prepare_message(&account, &resolved_draft).await?
    };
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

fn mailbox_is_ours(account: &crate::models::AccountRecord, value: &str) -> bool {
    let Some(mailbox) = receipt_mailbox(value) else {
        return false;
    };
    std::iter::once(account.summary.email.as_str())
        .chain(account.summary.aliases.iter().map(String::as_str))
        .filter_map(receipt_mailbox)
        .any(|candidate| candidate == mailbox)
}

fn receipt_draft(account_id: &str, to: String) -> ComposeDraft {
    ComposeDraft {
        id: None,
        account_id: account_id.to_string(),
        from: None,
        to: vec![to],
        cc: vec![],
        bcc: vec![],
        subject: String::new(),
        html_body: String::new(),
        text_body: String::new(),
        attachments: vec![],
        in_reply_to: None,
        references: None,
        send_at: None,
        body_format: BodyFormat::Plain,
        source_message_id: None,
        source_kind: None,
        include_signature: false,
        importance: String::new(),
        request_receipt: false,
        reply_to: None,
    }
}

#[tauri::command]
pub async fn decline_read_receipt(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let _guard = state.lock_account(&account_id).await?;
    command_result(
        state
            .db
            .set_receipt_choice(message_id, &account_id, "declined"),
    )
}

#[tauri::command]
pub async fn send_read_receipt(
    account_id: String,
    message_id: i64,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let _guard = state.lock_account(&account_id).await?;
    command_result(deliver_read_receipt(&account_id, message_id, &state).await)
}

async fn deliver_read_receipt(
    account_id: &str,
    message_id: i64,
    state: &AppState,
) -> Result<String, String> {
    let account = state.db.account(account_id)?;
    let detail = state.db.message_detail(message_id, account_id)?;
    if detail.receipt_choice == "sent" || detail.receipt_choice == "declined" {
        return Ok(detail.receipt_choice);
    }
    let raw = state.db.raw_message(message_id, account_id)?;
    let head = &raw[..raw.len().min(16 * 1024)];
    let asked =
        crate::mail::parse::disposition_notification_address(&String::from_utf8_lossy(head));
    if asked.is_empty()
        || mailbox_is_ours(&account, &asked)
        || mailbox_is_ours(&account, &detail.summary.sender_address)
    {
        return Err("This message did not ask for a read receipt.".into());
    }
    let from = receipt_mailbox(&account.summary.email)
        .ok_or_else(|| "The sender address is invalid.".to_string())?;
    let bytes = mail::send::read_receipt_bytes(
        &from,
        &asked,
        detail.summary.message_id.as_deref(),
        &detail.summary.subject,
    )?;
    let draft = receipt_draft(account_id, asked);
    let password = oauth::session_secret(&account).await?;
    match mail::send_prepared(&account, &password, &draft, &bytes).await {
        Ok(()) => state.db.set_receipt_choice(message_id, account_id, "sent"),
        Err(error) => Err(match error.kind {
            mail::SendFailure::Uncertain => {
                "Delivery could not be confirmed. You can try sending the receipt again.".into()
            }
            mail::SendFailure::NotSentRefused => "The mail server refused the read receipt.".into(),
            mail::SendFailure::NotSentRetry => {
                "The read receipt could not be sent. You can try again.".into()
            }
        }),
    }
}
