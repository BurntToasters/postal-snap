use std::collections::HashSet;
use tauri::{AppHandle, State};

use super::messages::{FlagOperation, MoveOperation};
use super::outbox::{deliver_outbox_locked, retry_sent_copy_locked};
use super::{
    cleanup_unreferenced_attachments, command_result, emit_draft_change, emit_folder_counts,
    emit_message_change, emit_outbox_change, emit_sync, managed_account_dir,
    release_attachment_tokens, replay_offline_operations, resolve_draft_files, AppState,
    CommandResult,
};
use crate::{
    credentials,
    db::Database,
    mail,
    models::{
        validate_filter_rule, AccountRecord, ComposeAttachment, ComposeDraft, IpcError,
        MailboxSummary,
    },
};

#[tauri::command]
pub fn list_all_mailboxes(state: State<'_, AppState>) -> CommandResult<Vec<MailboxSummary>> {
    command_result(state.db.list_all_mailboxes())
}

#[tauri::command]
pub fn list_mailboxes(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<MailboxSummary>> {
    command_result(state.db.list_mailboxes(&account_id))
}

#[tauri::command]
pub async fn sync_account(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    command_result(sync_one(&account_id, &app, &state).await)
}

#[tauri::command]
pub async fn sync_all_accounts(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    let accounts = state.db.list_accounts()?;
    let mut futures = Vec::new();
    for account in &accounts {
        futures.push(sync_one(&account.id, &app, &state));
    }
    let results = futures_util::future::join_all(futures).await;
    let mut synced_ids = Vec::new();
    for (account, result) in accounts.iter().zip(results) {
        if result.is_ok() {
            synced_ids.push(account.id.clone());
        }
    }
    Ok(synced_ids)
}

pub async fn sync_one(account_id: &str, app: &AppHandle, state: &AppState) -> Result<(), String> {
    let _guard = state.lock_account(account_id).await?;
    sync_one_locked(account_id, app, state).await
}

pub(crate) async fn sync_one_background(
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let _guard = state.lock_account_quiet(account_id).await?;
    sync_one_locked(account_id, app, state).await
}

async fn sync_one_locked(
    account_id: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let account = state.db.account(account_id)?;
    let password = credentials::load(account_id)?;
    emit_sync(
        app,
        account_id,
        "connecting",
        Some("Connecting securely…"),
        None,
    );
    state.db.set_account_state(account_id, "syncing", None)?;
    emit_sync(app, account_id, "syncing", Some("Checking mail…"), None);
    let settings = state.settings.get()?;
    match mail::sync_account(&state.db, &account, &password, &settings.cache_policy).await {
        Ok(()) => {
            apply_filter_rules(&state.db, &account);
            let pending_changes = replay_offline_operations(&state.db, &account, &password).await?;
            sync_drafts_locked(state, &account, &password).await;
            replay_outbox_locked(account_id, app, state).await;
            let now = chrono::Utc::now().to_rfc3339();
            state.db.set_account_state(account_id, "idle", None)?;
            emit_sync(
                app,
                account_id,
                "idle",
                Some(if pending_changes {
                    "Some changes are waiting to sync"
                } else {
                    "Mail is up to date"
                }),
                Some(now),
            );
            emit_folder_counts(app, account_id);
            emit_message_change(app, account_id, None, "synced");
            emit_draft_change(app, account_id, None, None);
            emit_outbox_change(app, account_id, None, None);
            Ok(())
        }
        Err(error) => {
            // Sign-in failures (expired app password, revoked access) need a
            // different message than a dead connection: the fix is a new
            // password, not waiting for retry.
            let auth_failed = IpcError::from(error.as_str()).code == "authenticationFailed";
            let detail = if auth_failed {
                "Sign-in failed. Update the account password in Settings > Accounts."
            } else {
                "Mail sync is temporarily unavailable."
            };
            state
                .db
                .set_account_state(account_id, "offline", Some(detail))?;
            emit_sync(
                app,
                account_id,
                "offline",
                Some(if auth_failed {
                    "Sign-in failed"
                } else {
                    "Will try again automatically"
                }),
                None,
            );
            Err(error)
        }
    }
}

/// File newly synced inbox mail through enabled filter rules. Actions
/// reuse the offline queue (local apply + queued op), so the replay later
/// in this sync delivers them and failures stay queued, never half-applied.
pub(crate) fn apply_filter_rules(db: &Database, account: &AccountRecord) {
    let account_id = &account.summary.id;
    let Ok(rules) = db.list_filter_rules(account_id) else {
        return;
    };
    let mut planned = Vec::new();
    for rule in rules.iter().filter(|rule| rule.enabled) {
        if validate_filter_rule(rule, account_id).is_err() {
            continue;
        }
        let destination: Option<(i64, String)> = match rule.action.as_str() {
            "mark_read" => None,
            "move_archive" | "move_trash" | "move_junk" => {
                let role = rule.action.strip_prefix("move_").unwrap_or("archive");
                db.mailbox_for_role(account_id, role).ok().flatten()
            }
            _ => rule
                .target_mailbox
                .as_deref()
                .and_then(|id| id.parse::<i64>().ok())
                .and_then(|id| {
                    db.mailbox(id)
                        .ok()
                        .filter(|(owner, _)| owner == account_id)
                        .map(|(_, name)| (id, name))
                }),
        };
        if rule.action != "mark_read" && destination.is_none() {
            continue;
        }
        let Ok(matches) = db.find_rule_matches(account_id, rule) else {
            continue;
        };
        planned.push((rule, destination, matches));
    }
    for (rule, destination, matches) in planned {
        if rule.action == "mark_read" {
            let ids: Vec<i64> = matches.iter().map(|(id, _, _, _)| *id).collect();
            if db.set_flags_bulk(&ids, Some(true), None).is_err() {
                continue;
            }
            for (id, uid, mailbox, _) in &matches {
                let Ok(validity) = db.mailbox_uid_validity(account_id, mailbox) else {
                    continue;
                };
                let operation = FlagOperation {
                    message_id: *id,
                    uid: *uid,
                    mailbox: mailbox.clone(),
                    uid_validity: validity,
                    is_read: Some(true),
                    is_starred: None,
                };
                let dedupe_key = format!("flags:{id}:true:false");
                let _ = db.queue_operation(account_id, "flags", &operation, Some(&dedupe_key));
            }
            continue;
        }
        let Some((destination_id, destination)) = destination else {
            continue;
        };
        for (id, uid, source, _) in &matches {
            if source == &destination {
                continue;
            }
            let Ok(validity) = db.mailbox_uid_validity(account_id, source) else {
                continue;
            };
            let operation = MoveOperation {
                message_id: *id,
                uid: *uid,
                source: source.clone(),
                destination: destination.clone(),
                uid_validity: validity,
            };
            let dedupe_key = format!("move:{id}");
            if db
                .queue_operation(account_id, "move", &operation, Some(&dedupe_key))
                .is_err()
            {
                continue;
            }
            let _ = db.mark_pending_move(*id, destination_id);
        }
    }
}

async fn sync_drafts_locked(state: &AppState, account: &AccountRecord, password: &str) {
    let account_id = &account.summary.id;
    let Some((_, drafts_mailbox)) = state
        .db
        .mailbox_for_role(account_id, "drafts")
        .ok()
        .flatten()
    else {
        let _ = state.db.set_draft_sync_warning(
            account_id,
            "Saved locally. This account has no confirmed Drafts mailbox.",
        );
        return;
    };
    let records = match state.db.pending_draft_sync(account_id) {
        Ok(records) => records,
        Err(_) => return,
    };
    for record in records {
        if record.deleted {
            let result = match (record.remote_mailbox.as_deref(), record.remote_uid) {
                (Some(mailbox), Some(uid)) => {
                    mail::delete_remote_draft(
                        account,
                        password,
                        mailbox,
                        uid,
                        record.remote_uid_validity,
                    )
                    .await
                }
                _ => Ok(()),
            };
            if result.is_ok() {
                let _ = state.db.finish_remote_draft_delete(&record.id, account_id);
            } else {
                let _ = state.db.set_one_draft_sync_warning(
                    &record.id,
                    account_id,
                    "Deletion is saved locally and will retry when the Drafts folder is available.",
                );
            }
            continue;
        }
        let resolved = match resolve_draft_files(&state.db, &record.draft) {
            Ok(draft) => draft,
            Err(_) => {
                let _ = state.db.set_one_draft_sync_warning(
                    &record.id,
                    account_id,
                    "Saved locally. Reattach a missing file before this draft can synchronize.",
                );
                continue;
            }
        };
        let message_id = if record.remote_message_id.is_empty() {
            format!("<draft-{}-{}@run.rosie.snap>", record.id, record.revision)
        } else {
            record.remote_message_id.clone()
        };
        let bytes = match mail::prepare_draft_message(account, &resolved, &message_id).await {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = state.db.set_one_draft_sync_warning(
                    &record.id,
                    account_id,
                    "Saved locally. This draft could not be prepared for server synchronization.",
                );
                continue;
            }
        };
        let same_mailbox = record.remote_mailbox.as_deref() == Some(drafts_mailbox.as_str());
        let result = mail::upsert_remote_draft(
            account,
            password,
            &drafts_mailbox,
            &message_id,
            &bytes,
            same_mailbox.then_some(record.remote_uid).flatten(),
            same_mailbox.then_some(record.remote_uid_validity).flatten(),
        )
        .await;
        match result {
            Ok(location) => {
                if !same_mailbox {
                    if let (Some(old_mailbox), Some(old_uid)) =
                        (record.remote_mailbox.as_deref(), record.remote_uid)
                    {
                        let _ = mail::delete_remote_draft(
                            account,
                            password,
                            old_mailbox,
                            old_uid,
                            record.remote_uid_validity,
                        )
                        .await;
                    }
                }
                let _ = state.db.mark_draft_synced(
                    &record.id,
                    account_id,
                    &drafts_mailbox,
                    location.uid,
                    location.uid_validity,
                    &message_id,
                    record.revision,
                );
            }
            Err(_) => {
                let _ = state.db.set_one_draft_sync_warning(
                    &record.id,
                    account_id,
                    "Saved locally. Draft synchronization will retry automatically.",
                );
            }
        }
    }
    import_remote_drafts_locked(state, account, password, &drafts_mailbox).await;
}

async fn import_remote_drafts_locked(
    state: &AppState,
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
) {
    let account_id = &account.summary.id;
    let uid_validity = state
        .db
        .mailbox_uid_validity(account_id, mailbox)
        .ok()
        .flatten();
    let known = state
        .db
        .remote_draft_uids(account_id, mailbox, uid_validity)
        .unwrap_or_default();
    let snapshot = match mail::fetch_remote_drafts(account, password, mailbox, &known).await {
        Ok(snapshot) => snapshot,
        Err(_) => return,
    };
    let account_dir = match managed_account_dir(&state.attachment_dir, account_id) {
        Ok(path) => path,
        Err(_) => return,
    };
    if tokio::fs::create_dir_all(&account_dir).await.is_err() {
        return;
    }
    for remote in snapshot.drafts {
        let parsed_identity = remote
            .message_id
            .as_deref()
            .and_then(parse_postal_draft_message_id);
        let (mut id, revision) = parsed_identity
            .clone()
            .unwrap_or_else(|| (uuid::Uuid::new_v4().to_string(), 1));
        let existing = state.db.draft_sync_state(&id, account_id).ok().flatten();
        let mut sync_state = "synced";
        let mut sync_detail = None;
        if existing
            .as_ref()
            .is_some_and(|(state, _)| state != "synced" && state != "conflict")
        {
            id = uuid::Uuid::new_v4().to_string();
            sync_state = "conflict";
            sync_detail = Some("Recovered server copy; your local changes were preserved.");
        } else if existing
            .as_ref()
            .is_some_and(|(_, local_revision)| *local_revision > revision)
        {
            let _ = state.db.update_remote_draft_tracking(
                &id,
                account_id,
                mailbox,
                remote.uid,
                snapshot.uid_validity,
                remote.message_id.as_deref(),
            );
            continue;
        }
        let mut attachments = Vec::new();
        let mut write_failed = false;
        for attachment in remote.attachments {
            let token = uuid::Uuid::new_v4().to_string();
            let path = account_dir.join(&token);
            if tokio::fs::write(&path, &attachment.bytes).await.is_err() {
                write_failed = true;
                break;
            }
            #[cfg(unix)]
            if tokio::fs::set_permissions(
                &path,
                std::os::unix::fs::PermissionsExt::from_mode(0o600),
            )
            .await
            .is_err()
            {
                let _ = tokio::fs::remove_file(&path).await;
                write_failed = true;
                break;
            }
            if state
                .db
                .grant_file(&token, account_id, &path, attachment.bytes.len() as u64)
                .is_err()
            {
                let _ = tokio::fs::remove_file(&path).await;
                write_failed = true;
                break;
            }
            attachments.push(ComposeAttachment {
                token,
                filename: attachment.filename,
                content_type: Some(attachment.content_type),
                inline: attachment.inline,
                content_id: attachment.content_id,
                size: Some(attachment.bytes.len()),
            });
        }
        if write_failed {
            release_attachment_tokens(
                state,
                account_id,
                attachments.iter().map(|item| item.token.as_str()),
            )
            .await;
            continue;
        }
        let draft = ComposeDraft {
            id: Some(id.clone()),
            account_id: account_id.clone(),
            from: remote.from.as_deref().and_then(|address| {
                let lower = address.trim().to_ascii_lowercase();
                let owned: Vec<String> = std::iter::once(&account.summary.email)
                    .chain(account.summary.aliases.iter())
                    .map(|item| item.trim().to_ascii_lowercase())
                    .collect();
                if owned.iter().any(|item| item == &lower) {
                    Some(address.trim().to_string())
                } else {
                    None
                }
            }),
            to: remote.to,
            cc: remote.cc,
            bcc: remote.bcc,
            subject: remote.subject,
            html_body: crate::html_sanitize::sanitize_compose_html(&remote.html_body),
            text_body: remote.text_body,
            attachments,
            in_reply_to: remote.in_reply_to,
            references: remote.references,
            send_at: None,
        };
        if state
            .db
            .import_remote_draft(
                &id,
                &draft,
                mailbox,
                remote.uid,
                snapshot.uid_validity,
                remote.message_id.as_deref(),
                revision,
                &remote.updated_at,
                sync_state,
                sync_detail,
            )
            .is_err()
        {
            release_attachment_tokens(
                state,
                account_id,
                draft.attachments.iter().map(|item| item.token.as_str()),
            )
            .await;
        }
    }
    let current = snapshot.uids.into_iter().collect::<HashSet<_>>();
    let _ = state
        .db
        .reconcile_remote_drafts(account_id, mailbox, snapshot.uid_validity, &current);
    cleanup_unreferenced_attachments(state, account_id).await;
}

fn parse_postal_draft_message_id(value: &str) -> Option<(String, u32)> {
    let value = value.trim().trim_start_matches('<').trim_end_matches('>');
    let at_index = value.rfind('@')?;
    let (local, domain) = value.split_at(at_index);
    if !domain.eq_ignore_ascii_case("@run.rosie.snap") {
        return None;
    }
    let local = local.strip_prefix("draft-")?;
    let (id, revision) = local.rsplit_once('-')?;
    uuid::Uuid::parse_str(id).ok()?;
    Some((id.to_string(), revision.parse().ok()?))
}

pub(crate) async fn replay_outbox_locked(account_id: &str, app: &AppHandle, state: &AppState) {
    if let Ok(ids) = state
        .db
        .outbox_ids_in_state(account_id, &["sent_copy_pending"])
    {
        for id in ids {
            let _ = retry_sent_copy_locked(&id, account_id, app, state).await;
        }
    }
    if let Ok(ids) = state.db.outbox_ids_in_state(account_id, &["queued"]) {
        for id in ids {
            let _ = deliver_outbox_locked(&id, account_id, app, state).await;
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    if let Ok(ids) = state.db.scheduled_due_outbox_ids(account_id, &now) {
        for id in ids {
            let _ = deliver_outbox_locked(&id, account_id, app, state).await;
        }
    }
}
