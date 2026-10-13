use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

use super::sync::sync_one;
use super::{
    command_result, managed_account_dir, refresh_mail_menu, take_normalized_account_password,
    AppState, CommandResult,
};
use crate::{
    credentials, mail,
    models::{
        take_validated_setup, AccountInboxCount, AccountRecord, AccountRemovalImpact,
        AccountRemovalOutcome, AccountSetupRequest, AccountSummary, AppSettings, BodyFormat,
        ProviderKind, ServerConfig, TlsMode, ACCOUNT_COLORS,
    },
    oauth,
};

#[tauri::command(async)]
pub fn list_accounts(state: State<'_, AppState>) -> CommandResult<Vec<AccountSummary>> {
    command_result(state.db.list_accounts())
}

#[tauri::command]
pub async fn test_account(mut request: AccountSetupRequest) -> CommandResult<()> {
    let (mut imap, mut smtp, password) = take_validated_setup(&mut request)?;
    crate::bridge::apply_setup_trust(&request, &mut imap, &mut smtp)?;
    mail::test_account(&request, &imap, &smtp, &password).await?;
    Ok(())
}

#[tauri::command]
pub async fn test_saved_account(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = state.lock_account(&account_id).await?;
    let account = state.db.account(&account_id)?;
    let password = crate::oauth::session_secret(&account).await?;
    if account.summary.auth_method == "oauth" {
        mail::probe_mail_login(
            &account.imap,
            &account.smtp,
            &account.summary.email,
            &password,
            true,
        )
        .await?;
        return Ok(());
    }
    let request = AccountSetupRequest {
        certificate_reference: None,
        provider: account.summary.provider.clone(),
        email: account.summary.email.clone(),
        display_name: account.summary.display_name.clone(),
        password: String::new(),
        imap: None,
        smtp: None,
        cache_policy: None,
    };
    mail::test_account(&request, &account.imap, &account.smtp, &password).await?;
    Ok(())
}

#[tauri::command]
pub async fn update_account_password(
    account_id: String,
    password: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    let _guard = state.lock_account(&account_id).await?;
    let password = Zeroizing::new(password);
    let account = state.db.account(&account_id)?;
    if account.summary.auth_method != "password" {
        return Err("This account signs in without a password. Reconnect it instead.".into());
    }
    let normalized = take_normalized_account_password(&account.summary.provider, password)?;
    let (imap, smtp) = mail::test_account(
        &AccountSetupRequest {
            certificate_reference: None,
            provider: account.summary.provider.clone(),
            email: account.summary.email.clone(),
            display_name: account.summary.display_name.clone(),
            password: String::new(),
            imap: None,
            smtp: None,
            cache_policy: None,
        },
        &account.imap,
        &account.smtp,
        &normalized,
    )
    .await?;
    let previous_password = credentials::load_for_removal(&account_id)?;
    credentials::store(&account_id, &normalized)?;
    // The parked session was authenticated with the old password.
    mail::pool::forget(&account_id);
    if let Err(error) = state.db.update_account_servers(&account_id, &imap, &smtp) {
        let restored = match previous_password.as_deref() {
            Some(previous) => credentials::store(&account_id, previous),
            None => credentials::remove(&account_id),
        };
        if restored.is_err() {
            return Err(
                "Postal Snap could not safely finish updating this password. Restart Postal Snap before trying again."
                    .into(),
            );
        }
        return Err(error.into());
    }
    state.db.set_account_state(&account_id, "idle", None)?;
    drop(_guard);
    let _ = sync_one(&account_id, &app, &state).await;
    let summary = state
        .db
        .list_accounts()?
        .into_iter()
        .find(|summary| summary.id == account_id)
        .ok_or_else(|| "Account not found.".to_string())?;
    Ok(summary)
}

#[tauri::command]
pub async fn add_account(
    mut request: AccountSetupRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    state.require_storage()?;
    let (mut imap, mut smtp, password) = take_validated_setup(&mut request)?;
    crate::bridge::apply_setup_trust(&request, &mut imap, &mut smtp)?;
    if request
        .cache_policy
        .as_ref()
        .is_some_and(|policy| !policy.is_valid())
    {
        return Err("Choose a valid download setting.".into());
    }
    let (imap, smtp) = mail::test_account(&request, &imap, &smtp, &password).await?;
    let mut aliases = Vec::new();
    if request.provider == ProviderKind::Icloud {
        if let Ok(found) = mail::discover_icloud_aliases(&request.email, &password).await {
            aliases = found;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let summary = AccountSummary {
        default_body_format: crate::models::BodyFormat::Html,
        id: id.clone(),
        provider: request.provider.clone(),
        email: request.email.trim().to_lowercase(),
        display_name: request.display_name.trim().to_string(),
        sync_state: "idle".into(),
        error: None,
        aliases,
        auth_method: "password".into(),
        signature: String::new(),
        reply_to: String::new(),
        color: Some(
            ACCOUNT_COLORS[state.db.account_count().unwrap_or(0) % ACCOUNT_COLORS.len()].into(),
        ),
    };
    if state.db.email_taken(&summary.email)? {
        return Err("An account with this email address is already set up.".into());
    }
    let account = AccountRecord {
        summary: summary.clone(),
        imap,
        smtp,
    };
    credentials::store(&id, &password)?;
    if let Err(error) = state.db.insert_account(&account) {
        let _ = credentials::remove(&id);
        return Err(error.into());
    }
    if let Some(reference) = &request.certificate_reference {
        crate::bridge::consume(reference);
    }
    let default_policy = state.settings.get()?.cache_policy;
    let policy = request
        .cache_policy
        .clone()
        .unwrap_or(default_policy.clone());
    let _ = state
        .db
        .set_account_cache_policy(&id, &policy, &default_policy);
    refresh_mail_menu(&app, &state);
    // The account is already durably saved. A transient watcher setup failure
    // must not make setup look unsuccessful or roll back the account.
    if state.ensure_watcher(id.clone(), app.clone()).is_err() {
        let _ = state.db.set_account_state(
            &id,
            "offline",
            Some("Background sync is unavailable. Use Get Mail to retry."),
        );
    }
    Ok(summary)
}

#[tauri::command]
pub async fn connect_oauth_account(
    provider: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    command_result(save_oauth_account(&provider, &app, &state).await)
}

async fn save_oauth_account(
    provider_name: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<AccountSummary, String> {
    state.require_storage()?;
    let provider = oauth::parse_oauth_provider(provider_name)?;
    let pending = oauth::begin_sign_in(provider).await?;
    let authorization_url = pending.authorization_url.clone();
    authorize_provider_page(provider, &authorization_url)?;
    app.opener()
        .open_url(authorization_url, None::<&str>)
        .map_err(|_| "Postal Snap could not open the sign-in page.".to_string())?;
    let signed = oauth::finish_sign_in(pending).await?;
    if state.db.email_taken(&signed.email)? {
        return Err("An account with this email address is already set up.".into());
    }
    let (imap, smtp) = oauth_servers(provider, &signed.email);
    mail::probe_mail_login(&imap, &smtp, &signed.email, &signed.access_token, true).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let summary = AccountSummary {
        default_body_format: BodyFormat::Html,
        id: id.clone(),
        provider: match provider {
            oauth::OAuthProvider::Gmail => ProviderKind::Gmail,
            oauth::OAuthProvider::Outlook => ProviderKind::Outlook,
        },
        email: signed.email,
        display_name: signed.display_name,
        sync_state: "idle".into(),
        error: None,
        aliases: Vec::new(),
        auth_method: "oauth".into(),
        signature: String::new(),
        reply_to: String::new(),
        color: Some(
            ACCOUNT_COLORS[state.db.account_count().unwrap_or(0) % ACCOUNT_COLORS.len()].into(),
        ),
    };
    let account = AccountRecord {
        summary: summary.clone(),
        imap,
        smtp,
    };
    state.db.insert_account(&account)?;
    if let Err(error) = oauth::store_tokens(&id, &signed.tokens) {
        let _ = state.db.remove_account(&id);
        return Err(error);
    }
    let default_policy = state.settings.get()?.cache_policy;
    let _ = state
        .db
        .set_account_cache_policy(&id, &default_policy, &default_policy);
    refresh_mail_menu(app, state);
    if state.ensure_watcher(id, app.clone()).is_err() {
        let _ = state.db.set_account_state(
            &summary.id,
            "offline",
            Some("Background sync is unavailable. Use Get Mail to retry."),
        );
    }
    Ok(summary)
}

fn authorize_provider_page(
    provider: oauth::OAuthProvider,
    authorization_url: &str,
) -> Result<(), String> {
    let url = url::Url::parse(authorization_url)
        .map_err(|_| "The sign-in address is invalid.".to_string())?;
    let host = match provider {
        oauth::OAuthProvider::Gmail => "accounts.google.com",
        oauth::OAuthProvider::Outlook => "login.microsoftonline.com",
    };
    if url.scheme() == "https" && url.host_str() == Some(host) {
        Ok(())
    } else {
        Err("The sign-in address is invalid.".into())
    }
}

fn oauth_servers(provider: oauth::OAuthProvider, email: &str) -> (ServerConfig, ServerConfig) {
    let email = email.to_lowercase();
    (
        ServerConfig {
            trusted_certificate: None,
            host: provider.imap_host().into(),
            port: provider.imap_port(),
            tls_mode: TlsMode::Tls,
            username: email.clone(),
        },
        ServerConfig {
            trusted_certificate: None,
            host: provider.smtp_host().into(),
            port: provider.smtp_port(),
            tls_mode: provider.smtp_tls_mode(),
            username: email,
        },
    )
}

#[tauri::command]
pub async fn remove_account(
    account_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<AccountRemovalOutcome> {
    let outcome = remove_single_account(&app, &state, &account_id).await?;
    compact_after_removal(&state).await;
    Ok(outcome)
}

/// Best effort: the removal already committed, so a failed compaction only
/// delays returning disk space.
async fn compact_after_removal(state: &AppState) {
    let db = state.db.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || db.compact()).await;
}

/// Remove every account, vault secret, and cached attachment, then restore
/// factory settings (including an unfinished first-run) so a restart lands
/// back on setup. Continues past a single-account failure so one stuck
/// account cannot block the erase; the first error is reported afterwards.
#[tauri::command]
pub async fn erase_all_data(app: AppHandle, state: State<'_, AppState>) -> CommandResult<u32> {
    state.require_storage()?;
    let ids: Vec<String> = state
        .db
        .list_accounts()?
        .iter()
        .map(|account| account.id.clone())
        .collect();
    let mut removed = 0u32;
    let mut first_error: Option<String> = None;
    for account_id in &ids {
        match remove_single_account(&app, &state, account_id).await {
            Ok(_) => removed += 1,
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    state.settings.save(AppSettings::default())?;
    compact_after_removal(&state).await;
    refresh_mail_menu(&app, &state);
    if let Some(error) = first_error {
        return command_result(Err(error));
    }
    Ok(removed)
}

/// Drop per-account UI entries. Best effort: a save failure never fails removal.
fn prune_account_settings(state: &State<'_, AppState>, account_id: &str) {
    let Ok(settings) = state.settings.get() else {
        return;
    };
    if let Some(pruned) = settings_without_account(settings, account_id) {
        let _ = state.settings.save(pruned);
    }
}

/// Drop one account's remembered entries. `None` when nothing matched.
/// Uses get() then save(): the store has no atomic read-modify-write.
fn settings_without_account(mut settings: AppSettings, account_id: &str) -> Option<AppSettings> {
    let before = settings.last_from_addresses.len()
        + settings.mailbox_views.len()
        + settings.pinned_mailboxes.len()
        + settings.hidden_mailboxes.len()
        + settings.collapsed_mailboxes.len();
    settings
        .last_from_addresses
        .retain(|entry| entry.account_id != account_id);
    settings
        .mailbox_views
        .retain(|entry| entry.account_id != account_id);
    settings
        .pinned_mailboxes
        .retain(|entry| entry.account_id != account_id);
    settings
        .hidden_mailboxes
        .retain(|entry| entry.account_id != account_id);
    settings
        .collapsed_mailboxes
        .retain(|entry| entry.account_id != account_id);
    let after = settings.last_from_addresses.len()
        + settings.mailbox_views.len()
        + settings.pinned_mailboxes.len()
        + settings.hidden_mailboxes.len()
        + settings.collapsed_mailboxes.len();
    (before != after).then_some(settings)
}

async fn remove_single_account(
    app: &AppHandle,
    state: &State<'_, AppState>,
    account_id: &str,
) -> Result<AccountRemovalOutcome, String> {
    let attachment_dir = managed_account_dir(&state.attachment_dir, account_id)?;
    state.db.account(account_id)?;
    let guard = state.lock_account(account_id).await?;
    // Recheck after waiting for another account operation so a concurrent
    // removal can never reach the credential vault twice.
    if let Err(error) = state.db.account(account_id) {
        drop(guard);
        state.retire_actor(account_id);
        return Err(error);
    }
    let account = state.db.account(account_id)?;
    // Keep the matching vault entry so a database failure can restore it;
    // account deletion is one user-visible transaction for either auth mode.
    enum StoredSecret {
        Password(Option<Zeroizing<String>>),
        OAuth(Option<oauth::StoredOAuthTokens>),
    }
    let secret = if account.summary.auth_method == "oauth" {
        StoredSecret::OAuth(oauth::load_tokens_for_removal(account_id)?)
    } else {
        StoredSecret::Password(credentials::load_for_removal(account_id)?)
    };
    match &secret {
        StoredSecret::Password(_) => credentials::remove(account_id)?,
        StoredSecret::OAuth(_) => oauth::remove_tokens(account_id)?,
    }
    if let Err(error) = state.db.remove_account(account_id) {
        let restored = match &secret {
            StoredSecret::Password(password) => password
                .as_deref()
                .map(|password| credentials::store(account_id, password).is_ok())
                .unwrap_or(true),
            StoredSecret::OAuth(tokens) => tokens
                .as_ref()
                .map(|tokens| oauth::store_tokens(account_id, tokens).is_ok())
                .unwrap_or(true),
        };
        if !restored {
            return Err(
                "Postal Snap could not finish removing this account. Contact support before trying again."
                    .into(),
            );
        }
        return Err(error);
    }
    // Removal has committed; a count failure must not turn it into a reported
    // command failure. Disable mail actions rather than allowing commands with
    // unknown ownership.
    prune_account_settings(state, account_id);
    refresh_mail_menu(app, state);
    let cleanup_pending =
        attachment_dir.exists() && tokio::fs::remove_dir_all(attachment_dir).await.is_err();
    drop(guard);
    state.retire_actor(account_id);
    Ok(AccountRemovalOutcome { cleanup_pending })
}

#[tauri::command]
pub async fn discover_account_aliases(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    let account = state.db.account(&account_id)?;
    if account.summary.provider != ProviderKind::Icloud {
        return Ok(account.summary);
    }
    let password = credentials::load(&account_id)?;
    let discovered = mail::discover_icloud_aliases(&account.summary.email, &password).await?;
    let mut updated_aliases = account.summary.aliases.clone();
    for alias in discovered {
        if !updated_aliases.contains(&alias) {
            updated_aliases.push(alias);
        }
    }
    let updated = state
        .db
        .update_account_aliases(&account_id, &updated_aliases)?;
    Ok(updated)
}

#[tauri::command(async)]
pub fn update_account_aliases(
    account_id: String,
    aliases: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    state.db.account(&account_id)?;
    let mut clean_aliases = Vec::new();
    for alias in aliases {
        let trimmed = alias.trim().to_lowercase();
        if trimmed.is_empty() || trimmed.len() > 320 || trimmed.contains(char::is_control) {
            return Err("One of the alias addresses is invalid.".into());
        }
        if trimmed.parse::<lettre::message::Mailbox>().is_err() {
            return Err("One of the alias addresses is invalid.".into());
        }
        if !clean_aliases.contains(&trimmed) {
            clean_aliases.push(trimmed);
        }
    }
    let updated = state
        .db
        .update_account_aliases(&account_id, &clean_aliases)?;
    Ok(updated)
}

/// One mailbox, or blank. A blank address means replies use From.
pub(crate) fn normalize_reply_to(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.chars().count() > 320
        || trimmed.contains(char::is_control)
        || trimmed.contains(',')
        || trimmed.parse::<lettre::message::Mailbox>().is_err()
    {
        return Err("Enter one email address.".into());
    }
    Ok(trimmed.to_string())
}

#[tauri::command(async)]
pub fn update_account_reply_to(
    account_id: String,
    reply_to: String,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    let reply_to = normalize_reply_to(&reply_to)?;
    command_result(state.db.update_account_reply_to(&account_id, &reply_to))
}

#[tauri::command(async)]
pub fn update_account_display_name(
    account_id: String,
    display_name: String,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    let trimmed = display_name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 || trimmed.contains(char::is_control) {
        return Err("Enter a name up to 120 characters.".into());
    }
    state.db.update_account_display_name(&account_id, trimmed)?;
    Ok(state.db.account(&account_id)?.summary)
}

#[tauri::command(async)]
pub fn update_account_signature(
    account_id: String,
    signature: String,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    command_result(state.db.update_account_signature(&account_id, &signature))
}

/// Unknown formats fail IPC deserialization before reaching the database.
#[tauri::command(async)]
pub fn update_account_default_body_format(
    account_id: String,
    format: crate::models::BodyFormat,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    command_result(
        state
            .db
            .set_account_default_body_format(&account_id, format),
    )
}

#[tauri::command(async)]
pub fn get_account_inbox_counts(
    state: State<'_, AppState>,
) -> CommandResult<Vec<AccountInboxCount>> {
    command_result(state.db.list_account_inbox_counts())
}

#[tauri::command(async)]
pub fn update_account_color(
    account_id: String,
    color: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<AccountSummary> {
    if color
        .as_deref()
        .is_some_and(|color| !ACCOUNT_COLORS.contains(&color))
    {
        return Err("Choose one of the listed colors.".into());
    }
    state
        .db
        .update_account_color(&account_id, color.as_deref())?;
    Ok(state.db.account(&account_id)?.summary)
}

#[tauri::command(async)]
pub fn reorder_accounts(
    account_ids: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<AccountSummary>> {
    state.db.reorder_accounts(&account_ids)?;
    command_result(state.db.list_accounts())
}

/// Counts of local-only work that removing the account would discard, shown
/// in the removal confirmation.
#[tauri::command(async)]
pub fn get_account_removal_impact(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AccountRemovalImpact> {
    state.db.account(&account_id)?;
    command_result(state.db.account_removal_impact(&account_id))
}

#[cfg(test)]
mod settings_prune_tests {
    use super::settings_without_account;
    use crate::models::{AppSettings, LastFromAddress, MailboxView, PinnedMailbox};

    #[test]
    fn removing_an_account_keeps_other_accounts_entries() {
        // Ways this can fail: another account's entries are dropped, the removed
        // account's entries survive, or an unchanged set reports a write.
        let gone = "00000000-0000-4000-8000-000000000001";
        let kept = "00000000-0000-4000-8000-000000000002";
        let settings = AppSettings {
            last_from_addresses: vec![
                LastFromAddress {
                    account_id: gone.into(),
                    address: "a@example.test".into(),
                },
                LastFromAddress {
                    account_id: kept.into(),
                    address: "b@example.test".into(),
                },
            ],
            mailbox_views: vec![MailboxView {
                account_id: gone.into(),
                mailbox_id: 1,
                sort: "date".into(),
                filter: "all".into(),
            }],
            pinned_mailboxes: vec![
                PinnedMailbox {
                    account_id: kept.into(),
                    mailbox_id: 2,
                },
                PinnedMailbox {
                    account_id: gone.into(),
                    mailbox_id: 3,
                },
            ],
            hidden_mailboxes: vec![PinnedMailbox {
                account_id: gone.into(),
                mailbox_id: 4,
            }],
            collapsed_mailboxes: vec![PinnedMailbox {
                account_id: kept.into(),
                mailbox_id: 5,
            }],
            ..AppSettings::default()
        };

        let pruned = settings_without_account(settings, gone).unwrap();
        assert_eq!(pruned.last_from_addresses.len(), 1);
        assert_eq!(pruned.last_from_addresses[0].account_id, kept);
        assert!(pruned.mailbox_views.is_empty());
        assert_eq!(pruned.pinned_mailboxes.len(), 1);
        assert_eq!(pruned.pinned_mailboxes[0].mailbox_id, 2);
        assert!(pruned.hidden_mailboxes.is_empty());
        assert_eq!(pruned.collapsed_mailboxes.len(), 1);
        assert!(settings_without_account(pruned, "missing-account").is_none());
    }
}

#[cfg(test)]
mod reply_to_tests {
    use super::normalize_reply_to;

    #[test]
    fn reply_to_is_one_address_or_blank() {
        assert_eq!(normalize_reply_to("  ").unwrap(), "");
        assert_eq!(
            normalize_reply_to("  replies@example.com ").unwrap(),
            "replies@example.com"
        );
        assert_eq!(
            normalize_reply_to("Ada <replies@example.com>").unwrap(),
            "Ada <replies@example.com>"
        );
        assert!(normalize_reply_to("not an address").is_err());
        assert!(normalize_reply_to("a@example.com, b@example.com").is_err());
        assert!(normalize_reply_to("a@example.com\r\nBcc: x").is_err());
    }
}
