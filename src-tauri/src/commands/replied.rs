use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{emit_message_change, validate_queued_operation, AppState, ValidatedReplay};
use crate::{
    db::Database,
    mail::{self, MailboxOperationError, SendFailure},
    models::{AccountRecord, ComposeDraft, DraftSourceKind},
};

pub(crate) use crate::mail::SourceKeyword;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeywordOperation {
    pub(crate) message_id: i64,
    pub(crate) uid: u32,
    pub(crate) mailbox: String,
    #[serde(default)]
    pub(crate) uid_validity: Option<u32>,
    pub(crate) keyword: SourceKeyword,
}

pub(crate) struct SourceTarget {
    pub(crate) mailbox: String,
    pub(crate) uid: u32,
    pub(crate) uid_validity: Option<u32>,
}

/// Which keyword a finished send earns. Only a confirmed SMTP acceptance
/// counts: refused, retry, and uncertain sends earn nothing.
pub(crate) fn keyword_after_send(
    kind: Option<DraftSourceKind>,
    sent: &Result<(), SendFailure>,
) -> Option<SourceKeyword> {
    if sent.is_err() {
        return None;
    }
    match kind? {
        DraftSourceKind::Reply | DraftSourceKind::ReplyAll => Some(SourceKeyword::Answered),
        DraftSourceKind::Forward => Some(SourceKeyword::Forwarded),
        DraftSourceKind::Redirect => None,
    }
}

/// The source message, only when it belongs to the sending account.
pub(crate) fn resolve_source(
    db: &Database,
    account_id: &str,
    message_id: i64,
) -> Result<Option<SourceTarget>, String> {
    let Ok((owner, mailbox, uid)) = db.message_location(message_id) else {
        return Ok(None);
    };
    if owner != account_id {
        return Ok(None);
    }
    let uid_validity = db.mailbox_uid_validity(account_id, &mailbox)?;
    Ok(Some(SourceTarget {
        mailbox,
        uid,
        uid_validity,
    }))
}

/// Finishes queued keyword writes for one message before archiving moves it.
/// The move gives the message a new UID and removes the local row, so a queued
/// write could no longer replay. A transient failure returns `Err` and keeps
/// the write queued so the archive waits. Stale or terminal writes are dropped.
pub(crate) async fn finish_source_keywords<Set, Fut>(
    db: &Database,
    account_id: &str,
    message_id: i64,
    mut set: Set,
) -> Result<(), MailboxOperationError>
where
    Set: FnMut(KeywordOperation) -> Fut,
    Fut: std::future::Future<Output = Result<(), MailboxOperationError>>,
{
    let queued = db
        .queued_operations(account_id)
        .map_err(MailboxOperationError::transient)?;
    for (id, kind, payload) in queued {
        if kind != "keyword" {
            continue;
        }
        let Ok(operation) = serde_json::from_str::<KeywordOperation>(&payload) else {
            continue;
        };
        if operation.message_id != message_id {
            continue;
        }
        let validated = validate_queued_operation(db, account_id, &kind, &payload)
            .map_err(MailboxOperationError::transient)?;
        let ValidatedReplay::Keyword(operation) = validated else {
            db.remove_operation(account_id, id)
                .map_err(MailboxOperationError::transient)?;
            continue;
        };
        match set(operation).await {
            Err(error) if !error.terminal => return Err(error),
            _ => db
                .remove_operation(account_id, id)
                .map_err(MailboxOperationError::transient)?,
        }
    }
    Ok(())
}

/// Best effort after SMTP accepted the message; never fails the send.
pub(crate) async fn mark_source_after_send(
    app: &AppHandle,
    state: &AppState,
    account: &AccountRecord,
    password: &str,
    draft: &ComposeDraft,
    sent: &Result<(), SendFailure>,
) {
    let Some(keyword) = keyword_after_send(draft.source_kind, sent) else {
        return;
    };
    let Some(message_id) = draft.source_message_id else {
        return;
    };
    let account_id = &account.summary.id;
    let Ok(Some(target)) = resolve_source(&state.db, account_id, message_id) else {
        return;
    };
    let _ = state.db.mark_replied(
        message_id,
        account_id,
        keyword == SourceKeyword::Answered,
        keyword == SourceKeyword::Forwarded,
    );
    let operation = KeywordOperation {
        message_id,
        uid: target.uid,
        mailbox: target.mailbox,
        uid_validity: target.uid_validity,
        keyword,
    };
    apply_keyword_intent(&state.db, account_id, operation, |operation| async move {
        mail::set_remote_keyword(
            account,
            password,
            &operation.mailbox,
            operation.uid,
            operation.uid_validity,
            operation.keyword,
        )
        .await
    })
    .await;
    emit_message_change(app, account_id, Some(message_id), "flags");
}

/// Queues the keyword before its STORE, so a crash after SMTP still replays
/// it. Success or a terminal failure removes it; a transient failure keeps it.
/// A queue failure never blocks the STORE.
pub(crate) async fn apply_keyword_intent<Store, Fut>(
    db: &Database,
    account_id: &str,
    operation: KeywordOperation,
    store: Store,
) where
    Store: FnOnce(KeywordOperation) -> Fut,
    Fut: std::future::Future<Output = Result<(), MailboxOperationError>>,
{
    let key = format!("keyword:{}:{:?}", operation.message_id, operation.keyword);
    let _ = db.queue_operation(account_id, "keyword", &operation, Some(&key));
    let result = store(operation).await;
    if !matches!(&result, Err(error) if !error.terminal) {
        let _ = db.remove_operation_by_dedupe(account_id, &key);
    }
}
