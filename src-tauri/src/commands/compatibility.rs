use super::{wake, AppState, CommandResult};
use crate::{
    bridge, credentials, mail,
    models::{AccountSetupRequest, ProviderKind, ServerConfig},
};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConnection {
    imap: ServerConfig,
    smtp: ServerConfig,
    certificate: Option<bridge::CertificateMetadata>,
    blockers: crate::models::ConnectionBlockers,
}

#[tauri::command]
pub fn get_account_connection(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AccountConnection> {
    let account = state.db.account(&account_id)?;
    let certificate = account
        .imap
        .trusted_certificate
        .as_ref()
        .map(|pem| bridge::describe_certificate(pem))
        .transpose()?;
    Ok(AccountConnection {
        imap: account.imap,
        smtp: account.smtp,
        certificate,
        blockers: state.db.connection_blockers(&account_id)?,
    })
}

#[tauri::command]
pub async fn update_account_connection(
    account_id: String,
    mut imap: ServerConfig,
    mut smtp: ServerConfig,
    confirm_identity_change: bool,
    state: State<'_, AppState>,
) -> CommandResult<AccountConnection> {
    let _guard = state.lock_account(&account_id).await?;
    let account = state.db.account(&account_id)?;
    imap.host = imap.host.trim().to_lowercase();
    smtp.host = smtp.host.trim().to_lowercase();
    imap.username = imap.username.trim().to_string();
    smtp.username = smtp.username.trim().to_string();
    crate::models::validate_server(&imap)?;
    crate::models::validate_server(&smtp)?;
    if account.summary.provider == ProviderKind::ProtonBridge {
        bridge::validate_loopback(&imap.host)?;
        bridge::validate_loopback(&smtp.host)?;
    }
    let changed = account.imap.host != imap.host || account.imap.username != imap.username;
    if changed {
        if !confirm_identity_change {
            return Err("Confirm the incoming server identity change before saving.".into());
        }
        if state.db.identity_change_blocked(&account_id)? {
            return Err("Resolve queued changes and unsent mail before changing the incoming server identity.".into());
        }
    }
    imap.trusted_certificate = account.imap.trusted_certificate.clone();
    smtp.trusted_certificate = account.smtp.trusted_certificate.clone();
    let request = AccountSetupRequest {
        provider: account.summary.provider.clone(),
        email: account.summary.email.clone(),
        display_name: account.summary.display_name.clone(),
        password: String::new(),
        imap: None,
        smtp: None,
        cache_policy: None,
        certificate_reference: None,
    };
    let password = credentials::load(&account_id)?;
    let (imap, smtp) = mail::test_account(&request, &imap, &smtp, &password).await?;
    state
        .db
        .save_account_connection(&account_id, &imap, &smtp, changed)?;
    mail::pool::forget(&account_id);
    state.db.set_account_state(&account_id, "idle", None)?;
    state
        .actor(&account_id)?
        .request(wake::CREDENTIALS | wake::SYNC);
    Ok(AccountConnection {
        certificate: imap
            .trusted_certificate
            .as_ref()
            .map(|pem| bridge::certificate_metadata(pem))
            .transpose()?,
        imap,
        smtp,
        blockers: state.db.connection_blockers(&account_id)?,
    })
}

#[tauri::command]
pub async fn import_bridge_certificate(
    app: AppHandle,
) -> CommandResult<Option<bridge::CertificateMetadata>> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Public certificate", &["pem", "crt", "cer"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "Could not open the certificate dialog.".to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected certificate is unavailable.".to_string())?;
    let bytes = super::attachments::read_attachment_source(&path, 65536).await?;
    let pem =
        String::from_utf8(bytes).map_err(|_| "Choose a public PEM certificate.".to_string())?;
    Ok(Some(bridge::stage_certificate(pem)?))
}

#[tauri::command]
pub async fn approve_bridge_certificate(
    reference: String,
    account_id: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    bridge::approve_pending(&reference)?;
    if let Some(id) = account_id {
        let _guard = state.lock_account(&id).await?;
        let mut account = state.db.account(&id)?;
        if account.summary.provider != ProviderKind::ProtonBridge {
            return Err("Only Proton Bridge accounts can trust a local certificate.".into());
        }
        bridge::validate_loopback(&account.imap.host)?;
        bridge::validate_loopback(&account.smtp.host)?;
        let pem = bridge::approved_pem(&reference)?;
        account.imap.trusted_certificate = Some(pem.clone());
        account.smtp.trusted_certificate = Some(pem.clone());
        let request = AccountSetupRequest {
            provider: account.summary.provider.clone(),
            email: account.summary.email.clone(),
            display_name: account.summary.display_name.clone(),
            password: String::new(),
            imap: None,
            smtp: None,
            cache_policy: None,
            certificate_reference: None,
        };
        mail::test_account(
            &request,
            &account.imap,
            &account.smtp,
            &credentials::load(&id)?,
        )
        .await?;
        state.db.save_bridge_certificate(&id, Some(&pem))?;
        mail::pool::forget(&id);
        state.actor(&id)?.request(wake::CREDENTIALS | wake::SYNC);
        bridge::consume(&reference);
    }
    Ok(reference)
}

#[tauri::command]
pub async fn remove_bridge_certificate(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    state.db.save_bridge_certificate(&account_id, None)?;
    mail::pool::forget(&account_id);
    state.actor(&account_id)?.request(wake::SYNC);
    Ok(())
}

#[tauri::command]
pub fn get_folder_assignments(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<crate::db::compatibility::FolderAssignment>> {
    Ok(state.db.folder_assignments(&account_id)?)
}

#[tauri::command]
pub async fn set_folder_assignment(
    account_id: String,
    role: String,
    mailbox_id: Option<i64>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<crate::db::compatibility::FolderAssignment>> {
    let _guard = state.lock_account(&account_id).await?;
    state
        .db
        .set_folder_assignment(&account_id, &role, mailbox_id)?;
    state.actor(&account_id)?.request(wake::SYNC);
    Ok(state.db.folder_assignments(&account_id)?)
}
