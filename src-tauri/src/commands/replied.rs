use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{emit_message_change, AppState};
use crate::{
    db::Database,
    mail::{self, SendFailure},
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
    let result = mail::set_remote_keyword(
        account,
        password,
        &target.mailbox,
        target.uid,
        target.uid_validity,
        keyword,
    )
    .await;
    if let Err(error) = result {
        if !error.terminal {
            let operation = KeywordOperation {
                message_id,
                uid: target.uid,
                mailbox: target.mailbox,
                uid_validity: target.uid_validity,
                keyword,
            };
            let key = format!("keyword:{message_id}:{keyword:?}");
            let _ = state
                .db
                .queue_operation(account_id, "keyword", &operation, Some(&key));
        }
    }
    emit_message_change(app, account_id, Some(message_id), "flags");
}
