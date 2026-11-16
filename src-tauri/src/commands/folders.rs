use tauri::{AppHandle, State};

use super::sync::sync_one;
use super::{command_result, AppState, CommandResult};
use crate::{
    mail,
    models::{
        moved_folder_name, nested_folder_name, renamed_folder_name, validate_folder_name,
        MailboxRole, RecipientSuggestion,
    },
};

#[tauri::command(async)]
pub fn suggest_recipients(
    account_id: String,
    prefix: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<RecipientSuggestion>> {
    state.db.account(&account_id)?;
    command_result(
        state
            .db
            .suggest_recipients(&account_id, &prefix, limit.unwrap_or(8)),
    )
}

#[tauri::command]
pub async fn create_folder(
    account_id: String,
    name: String,
    parent_mailbox_id: Option<i64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let name = if let Some(parent_id) = parent_mailbox_id {
        let (owner, parent_name) = state.db.mailbox(parent_id)?;
        if owner != account_id {
            return Err("Folder does not belong to this account.".into());
        }
        let delimiter = state.db.mailbox_delimiter(parent_id)?.unwrap_or_default();
        nested_folder_name(&parent_name, &delimiter, &name)?
    } else {
        validate_folder_name(&name)?
    };
    let _guard = state.lock_account(&account_id).await?;
    let account = state.db.account(&account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let result = mail::create_folder(&account, &password, &name).await;
    drop(_guard);
    command_result(result)?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn rename_folder(
    account_id: String,
    mailbox_id: i64,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let leaf = validate_folder_name(&name)?;
    if state.db.mailbox(mailbox_id)?.0 != account_id {
        return Err("Folder does not belong to this account.".into());
    }
    if state.db.server_folder_role(mailbox_id)? != MailboxRole::Other {
        return Err("Only personal folders can be renamed.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (_, old_name) = state.db.mailbox(mailbox_id)?;
    let delimiter = state.db.mailbox_delimiter(mailbox_id)?.unwrap_or_default();
    let name = renamed_folder_name(&old_name, &delimiter, &leaf)?;
    // Exact match only: "work" to "Work" is a real rename.
    if old_name == name {
        return Ok(());
    }
    let account = state.db.account(&account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let result = mail::rename_folder(&account, &password, &old_name, &name).await;
    if result.is_ok() {
        state
            .db
            .rename_mailbox_local(&account_id, &old_name, &name)?;
    }
    drop(_guard);
    command_result(result)?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn move_folder(
    account_id: String,
    mailbox_id: i64,
    parent_mailbox_id: Option<i64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    if state.db.mailbox(mailbox_id)?.0 != account_id {
        return Err("Folder does not belong to this account.".into());
    }
    if state.db.server_folder_role(mailbox_id)? != MailboxRole::Other {
        return Err("Only personal folders can be moved.".into());
    }
    if parent_mailbox_id == Some(mailbox_id) {
        return Err("A folder cannot be moved inside itself.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (_, old_name) = state.db.mailbox(mailbox_id)?;
    let parent_name = if let Some(parent_id) = parent_mailbox_id {
        let (owner, name) = state.db.mailbox(parent_id)?;
        if owner != account_id {
            return Err("Folder does not belong to this account.".into());
        }
        Some(name)
    } else {
        None
    };
    let delimiter = state.db.mailbox_delimiter(mailbox_id)?.unwrap_or_default();
    if let Some(parent) = parent_name.as_deref() {
        if is_self_or_descendant(&old_name, &delimiter, parent) {
            return Err("A folder cannot be moved inside itself.".into());
        }
    }
    let name = moved_folder_name(&old_name, &delimiter, parent_name.as_deref())?;
    if old_name == name {
        return Ok(());
    }
    let account = state.db.account(&account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let result = mail::rename_folder(&account, &password, &old_name, &name).await;
    if result.is_ok() {
        state
            .db
            .rename_mailbox_local(&account_id, &old_name, &name)?;
    }
    drop(_guard);
    command_result(result)?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

/// True when `destination` is the folder itself or one of its descendants.
/// The check is on IMAP names, so "AB" is a sibling of "A", not a child.
fn is_self_or_descendant(current: &str, delimiter: &str, destination: &str) -> bool {
    destination == current
        || (!delimiter.is_empty() && destination.starts_with(&format!("{current}{delimiter}")))
}

#[tauri::command]
pub async fn delete_folder(
    account_id: String,
    mailbox_id: i64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    if state.db.mailbox(mailbox_id)?.0 != account_id {
        return Err("Folder does not belong to this account.".into());
    }
    if state.db.server_folder_role(mailbox_id)? != MailboxRole::Other {
        return Err("Only personal folders can be deleted.".into());
    }
    let _guard = state.lock_account(&account_id).await?;
    let (_, name) = state.db.mailbox(mailbox_id)?;
    let account = state.db.account(&account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let result = mail::delete_folder(&account, &password, &name).await;
    drop(_guard);
    command_result(result)?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn delete_trash_messages(
    account_id: String,
    message_ids: Vec<i64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    delete_trash_messages_with(&state, &account_id, &message_ids).await?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

async fn delete_trash_messages_with(
    state: &AppState,
    account_id: &str,
    message_ids: &[i64],
) -> CommandResult<()> {
    let _guard = state.lock_account(account_id).await?;
    let plan = state.db.trash_expunge_plan(account_id, message_ids)?;
    let account = state.db.account(account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let result = mail::expunge_uids(
        &account,
        &password,
        &plan.mailbox_name,
        plan.uid_validity,
        &plan.uids,
    )
    .await;
    drop(_guard);
    command_result(result)
}

#[tauri::command]
pub async fn empty_trash(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    empty_role_folder(
        account_id,
        "trash",
        "This account does not have a trash mailbox.",
        app,
        state,
    )
    .await
}

#[tauri::command]
pub async fn empty_junk(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    empty_role_folder(
        account_id,
        "junk",
        "This account does not have a junk mailbox.",
        app,
        state,
    )
    .await
}

async fn empty_role_folder(
    account_id: String,
    role: &str,
    missing: &str,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    empty_role_folder_with(&state, &account_id, role, missing).await?;
    let _ = sync_one(&account_id, &app, &state).await;
    Ok(())
}

async fn empty_role_folder_with(
    state: &AppState,
    account_id: &str,
    role: &str,
    missing: &str,
) -> CommandResult<()> {
    let _guard = state.lock_account(account_id).await?;
    let (folder_id, name) = state
        .db
        .mailbox_for_role(account_id, role)?
        .ok_or_else(|| missing.to_string())?;
    let account = state.db.account(account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    let validity = state
        .db
        .mailbox_uid_validity(account_id, &name)?
        .ok_or_else(|| {
            "Mailbox identity is unavailable; refresh mail and try again.".to_string()
        })?;
    let protected = state.db.pending_move_uids(folder_id).unwrap_or_default();
    let result = mail::empty_folder(&account, &password, &name, Some(validity), &protected).await;
    drop(_guard);
    command_result(result)
}

#[cfg(test)]
mod lock_tests {
    use super::{delete_trash_messages_with, empty_role_folder_with};
    use crate::{
        commands::AppState,
        db::{CachedMessage, Database},
        mail,
        models::{
            AccountRecord, AccountSummary, BodyFormat, MailboxRole, ProviderKind, ServerConfig,
            TlsMode,
        },
        settings::SettingsStore,
    };

    fn bridge_account(id: &str, port: u16) -> AccountRecord {
        let server = ServerConfig {
            host: "127.0.0.1".into(),
            port,
            tls_mode: TlsMode::Tls,
            username: "fixture@example.test".into(),
            trusted_certificate: Some(mail::test_tls::CERT_PEM.into()),
        };
        AccountRecord {
            summary: AccountSummary {
                notify_new_mail: true,
                id: id.into(),
                provider: ProviderKind::ProtonBridge,
                email: "fixture@example.test".into(),
                display_name: "Fixture".into(),
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
            imap: server.clone(),
            smtp: server,
        }
    }

    #[tokio::test]
    async fn delete_trash_messages_reads_plan_after_account_lock_not_before() {
        let (port, cmd_log, server) = mail::test_tls::spawn_imap_server(|tag, verb, _| {
            let tag = tag.to_string();
            let verb = verb.to_string();
            Box::pin(async move {
                let reply = match verb.as_str() {
                    "CAPABILITY" => {
                        format!("* CAPABILITY IMAP4rev1 UIDPLUS\r\n{tag} OK done\r\n").into_bytes()
                    }
                    "SELECT" | "EXAMINE" => format!(
                        "* 1 EXISTS\r\n* OK [UIDVALIDITY 10]\r\n* OK [UIDNEXT 20]\r\n* OK [PERMANENTFLAGS (\\Seen \\Deleted)]\r\n{tag} OK selected\r\n"
                    )
                    .into_bytes(),
                    _ => format!("{tag} OK ok\r\n").into_bytes(),
                };
                Some(reply)
            })
        })
        .await;

        let dir = tempfile::tempdir().unwrap();
        let db = Database::memory();
        let settings = SettingsStore::load(dir.path().join("settings.json"), &db).unwrap();
        let state = std::sync::Arc::new(AppState::new(
            db.clone(),
            settings,
            dir.path().to_path_buf(),
        ));
        let account_id = uuid::Uuid::new_v4().to_string();
        let _secret = crate::oauth::TestSecretGuard::install(&account_id, "pw");
        let account = bridge_account(&account_id, port);
        mail::pool::forget(&account_id);
        state.db.insert_account(&account).unwrap();
        let trash = state
            .db
            .upsert_mailbox(
                &account_id,
                "Trash",
                &MailboxRole::Trash,
                Some(10),
                Some(20),
                Some(0),
                1,
            )
            .unwrap();
        let archive = state
            .db
            .upsert_mailbox(
                &account_id,
                "Archive",
                &MailboxRole::Archive,
                Some(11),
                Some(2),
                Some(0),
                0,
            )
            .unwrap();
        state
            .db
            .upsert_envelopes(
                &account_id,
                trash,
                &[CachedMessage {
                    uid: 5,
                    message_id: Some("<b10-trash@example.test>".into()),
                    subject: "Trash".into(),
                    sender_name: "Jane".into(),
                    sender_address: "jane@example.test".into(),
                    recipients: "fixture@example.test".into(),
                    received_at: "2026-11-15T12:00:00Z".into(),
                    internal_at: None,
                    preview: String::new(),
                    is_read: true,
                    is_starred: false,
                    size: 120,
                    to: vec!["fixture@example.test".into()],
                    cc: vec![],
                    bcc: vec![],
                    reply_to: None,
                    thread_parent: None,
                    text_body: String::new(),
                    html_body: None,
                    attachments: vec![],
                    raw_message: Vec::new(),
                    has_attachments: false,
                    is_answered: false,
                    is_forwarded: false,
                    has_calendar: false,
                    calendar_json: None,
                    list_unsubscribe: None,
                    list_unsubscribe_post: None,
                    importance: String::new(),
                    disposition_to: String::new(),
                }],
            )
            .unwrap();
        let msg_id = state
            .db
            .message_summary_by_uid(trash, 5)
            .unwrap()
            .unwrap()
            .id;

        // Hold account lock while delete_trash_messages_with starts, then move message out of Trash.
        let holder = state.lock_account(&account_id).await.unwrap();
        let state_bg = state.clone();
        let acct_bg = account_id.clone();
        let task = tokio::spawn(async move {
            delete_trash_messages_with(&state_bg, &acct_bg, &[msg_id]).await
        });
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        state
            .db
            .conn()
            .unwrap()
            .execute(
                "UPDATE messages SET mailbox_id=?1 WHERE id=?2",
                [archive, msg_id],
            )
            .unwrap();
        drop(holder);

        let res = task.await.unwrap();
        assert!(
            res.is_err(),
            "stale non-Trash message must be rejected once lock is acquired"
        );
        assert!(
            !cmd_log
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.contains("UID EXPUNGE")),
            "pre-lock TOCTOU expunged restored message; cmds: {:?}",
            cmd_log.lock().unwrap()
        );
        mail::pool::forget(&account_id);
        server.abort();
    }

    #[tokio::test]
    async fn empty_role_folder_reads_mailbox_after_account_lock_not_before() {
        let (port, cmd_log, server) = mail::test_tls::spawn_imap_server(|tag, verb, _| {
            let tag = tag.to_string();
            let verb = verb.to_string();
            Box::pin(async move {
                let reply = match verb.as_str() {
                    "CAPABILITY" => {
                        format!("* CAPABILITY IMAP4rev1 UIDPLUS\r\n{tag} OK done\r\n").into_bytes()
                    }
                    "SELECT" | "EXAMINE" => format!(
                        "* 1 EXISTS\r\n* OK [UIDVALIDITY 10]\r\n* OK [UIDNEXT 20]\r\n* OK [PERMANENTFLAGS (\\Seen \\Deleted)]\r\n{tag} OK selected\r\n"
                    )
                    .into_bytes(),
                    "UID" => format!("* SEARCH 1\r\n{tag} OK uid\r\n").into_bytes(),
                    _ => format!("{tag} OK ok\r\n").into_bytes(),
                };
                Some(reply)
            })
        })
        .await;

        let dir = tempfile::tempdir().unwrap();
        let db = Database::memory();
        let settings = SettingsStore::load(dir.path().join("settings.json"), &db).unwrap();
        let state = std::sync::Arc::new(AppState::new(
            db.clone(),
            settings,
            dir.path().to_path_buf(),
        ));
        let account_id = uuid::Uuid::new_v4().to_string();
        let _secret = crate::oauth::TestSecretGuard::install(&account_id, "pw");
        let account = bridge_account(&account_id, port);
        mail::pool::forget(&account_id);
        state.db.insert_account(&account).unwrap();
        let trash = state
            .db
            .upsert_mailbox(
                &account_id,
                "Trash",
                &MailboxRole::Trash,
                Some(10),
                Some(20),
                Some(0),
                1,
            )
            .unwrap();

        let holder = state.lock_account(&account_id).await.unwrap();
        let state_bg = state.clone();
        let acct_bg = account_id.clone();
        let task = tokio::spawn(async move {
            empty_role_folder_with(&state_bg, &acct_bg, "trash", "No trash").await
        });
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        state
            .db
            .conn()
            .unwrap()
            .execute(
                "UPDATE mailboxes SET name='RenamedTrash' WHERE id=?1",
                [trash],
            )
            .unwrap();
        drop(holder);

        let _ = task.await.unwrap();
        let selects: Vec<String> = cmd_log
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.contains("SELECT "))
            .cloned()
            .collect();
        assert!(
            selects.iter().any(|c| c.contains("RenamedTrash")),
            "empty_role_folder resolved stale name 'Trash' before acquiring account lock; selects: {selects:?}"
        );
        mail::pool::forget(&account_id);
        server.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::is_self_or_descendant;

    // Failure modes for the move-into-self check:
    // 1. Moving a folder into itself must be rejected before any server call.
    // 2. Moving into a direct child (A into A/B) must be rejected.
    // 3. Moving into a deep descendant (A into A/B/C) must be rejected.
    // 4. A sibling that shares a text prefix (A into AB) must be allowed.
    // 5. An empty delimiter has no hierarchy, so only equality is rejected.
    // 6. A different delimiter must not match a slash-based prefix.
    #[test]
    fn move_into_self_or_descendant_is_rejected() {
        assert!(is_self_or_descendant("A", "/", "A"));
        assert!(is_self_or_descendant("A", "/", "A/B"));
        assert!(is_self_or_descendant("A", "/", "A/B/C"));
        assert!(is_self_or_descendant("A", ".", "A.B"));
        assert!(is_self_or_descendant("A", "", "A"));
    }

    #[test]
    fn move_into_siblings_and_unrelated_folders_is_allowed() {
        assert!(!is_self_or_descendant("A", "/", "AB"));
        assert!(!is_self_or_descendant("A", "/", "B"));
        assert!(!is_self_or_descendant("A", "/", "B/A"));
        assert!(!is_self_or_descendant("A", "", "A/B"));
        assert!(!is_self_or_descendant("A", "/", "A.B"));
        assert!(!is_self_or_descendant("A/B", "/", "A"));
    }
}
