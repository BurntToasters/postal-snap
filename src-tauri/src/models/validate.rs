use super::dto::*;
use zeroize::{Zeroize, Zeroizing};

pub fn validate_filter_rule(rule: &FilterRule, account_id: &str) -> Result<(), String> {
    if rule.account_id != account_id {
        return Err("Rule does not belong to this account.".into());
    }
    let name = rule.name.trim();
    if name.is_empty() || name.len() > 80 || name.contains(char::is_control) {
        return Err("Name the rule in up to 80 characters.".into());
    }
    if !matches!(rule.field.as_str(), "from" | "to" | "subject" | "domain") {
        return Err("Rules can match sender, recipient, subject, or a sender domain.".into());
    }
    let needle = rule.contains.trim();
    if needle.is_empty() || needle.len() > 200 || needle.contains(char::is_control) {
        return Err("Match text must be 1 to 200 characters.".into());
    }
    if rule.field == "domain" && !valid_sender_domain(needle) {
        return Err("Enter a domain such as example.com.".into());
    }
    if !matches!(
        rule.action.as_str(),
        "mark_read" | "move_archive" | "move_trash" | "move_junk" | "move_mailbox"
    ) {
        return Err("That rule action is not supported.".into());
    }
    if rule.action == "move_mailbox"
        && rule
            .target_mailbox
            .as_deref()
            .is_none_or(|target| target.is_empty())
    {
        return Err("Choose the folder to move matching mail into.".into());
    }
    Ok(())
}

/// Host written in a domain rule: labels, a dot, and no address punctuation.
pub(crate) fn valid_sender_domain(value: &str) -> bool {
    let domain = value.trim();
    if domain.len() > 200
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains("..")
        || !domain.contains('.')
    {
        return false;
    }
    domain.split('.').all(|label| {
        let bytes = label.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 63
            && bytes[0] != b'-'
            && *bytes.last().unwrap_or(&b'-') != b'-'
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
    })
}

pub fn validated_setup(
    request: &AccountSetupRequest,
) -> Result<(ServerConfig, ServerConfig), String> {
    if request.email.trim().parse::<lettre::Address>().is_err()
        || request.email.len() > 320
        || request.display_name.len() > 200
        || request.display_name.contains(char::is_control)
    {
        return Err("Enter a valid email address.".into());
    }
    if request.password.is_empty() || request.password.len() > 4096 {
        return Err("Enter the app-specific or email password.".into());
    }
    let (imap, smtp) = match request.provider {
        ProviderKind::Icloud => {
            let full = request.email.trim().to_lowercase();
            let local = full.split('@').next().unwrap_or(&full).to_string();
            (
                ServerConfig {
                    trusted_certificate: None,
                    host: "imap.mail.me.com".into(),
                    port: 993,
                    tls_mode: TlsMode::Tls,
                    username: local,
                },
                ServerConfig {
                    trusted_certificate: None,
                    host: "smtp.mail.me.com".into(),
                    port: 587,
                    tls_mode: TlsMode::StartTls,
                    username: full,
                },
            )
        }
        ProviderKind::Manual | ProviderKind::ProtonBridge => (
            request
                .imap
                .clone()
                .ok_or("Incoming server settings are required.")?,
            request
                .smtp
                .clone()
                .ok_or("Outgoing server settings are required.")?,
        ),
        ProviderKind::Gmail | ProviderKind::Outlook => {
            return Err(
                "This mailbox signs in through its provider. A password cannot be saved for it."
                    .into(),
            );
        }
    };
    validate_server(&imap)?;
    validate_server(&smtp)?;
    if request.provider == ProviderKind::ProtonBridge {
        crate::bridge::validate_loopback(&imap.host)?;
        crate::bridge::validate_loopback(&smtp.host)?;
    }
    Ok((imap, smtp))
}

pub fn normalize_setup_password(provider: &ProviderKind, password: &str) -> String {
    match provider {
        ProviderKind::Icloud => password.chars().filter(|ch| !ch.is_whitespace()).collect(),
        ProviderKind::Manual
        | ProviderKind::ProtonBridge
        | ProviderKind::Gmail
        | ProviderKind::Outlook => password.trim().to_string(),
    }
}

pub fn take_validated_setup(
    request: &mut AccountSetupRequest,
) -> Result<(ServerConfig, ServerConfig, Zeroizing<String>), String> {
    let (imap, smtp) = validated_setup(request)?;
    let password = Zeroizing::new(normalize_setup_password(
        &request.provider,
        &request.password,
    ));
    request.password.zeroize();
    if password.is_empty() || password.len() > 4096 {
        return Err("Enter the app-specific or email password.".into());
    }
    Ok((imap, smtp, password))
}

pub(crate) fn validate_server(server: &ServerConfig) -> Result<(), String> {
    let host = server.host.trim();
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && !host.contains(char::is_whitespace)
        && !host.contains(char::is_control)
        && (host.parse::<std::net::IpAddr>().is_ok() || {
            !host.contains(['/', '\\', '@', ':', '?', '#', '[', ']'])
                && host.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && label
                            .chars()
                            .all(|character| character.is_alphanumeric() || character == '-')
                })
                && !host.starts_with('-')
                && !host.ends_with('-')
        });
    if !host_ok {
        return Err("Enter a valid mail server name.".into());
    }
    if server.port == 0
        || server.username.trim().is_empty()
        || server.username.len() > 320
        || server.username.contains(char::is_control)
    {
        return Err("Server port and username are required.".into());
    }
    Ok(())
}

/// One mailbox, same rules as the account Reply-To setting.
pub(crate) fn reply_to_is_valid(value: &str) -> bool {
    let trimmed = value.trim();
    !(trimmed.chars().count() > 320
        || trimmed.contains(char::is_control)
        || trimmed.contains(',')
        || trimmed.parse::<lettre::message::Mailbox>().is_err())
}

pub fn validate_compose_draft(draft: &ComposeDraft) -> Result<(), String> {
    if let Some(from) = &draft.from {
        if from.len() > 320
            || from.contains(char::is_control)
            || from.trim().parse::<lettre::message::Mailbox>().is_err()
        {
            return Err("The sender address is invalid.".into());
        }
    }
    let recipients = draft.to.iter().chain(&draft.cc).chain(&draft.bcc);
    if draft.to.len() + draft.cc.len() + draft.bcc.len() > 500
        || recipients
            .clone()
            .any(|value| value.len() > 320 || value.contains(char::is_control))
    {
        return Err("The recipient list is too large or invalid.".into());
    }
    if recipients
        .clone()
        .any(|value| value.trim().parse::<lettre::message::Mailbox>().is_err())
    {
        return Err("Enter valid email addresses for every recipient.".into());
    }
    if let Some(reply_to) = draft.reply_to.as_deref().map(str::trim) {
        if !reply_to.is_empty() && !reply_to_is_valid(reply_to) {
            return Err("Enter one Reply-To address.".into());
        }
    }
    if draft.subject.len() > 998 || draft.subject.contains(char::is_control) {
        return Err("The subject is too long or invalid.".into());
    }
    if draft.html_body.len().saturating_add(draft.text_body.len()) > 50 * 1024 * 1024 {
        return Err("This message is too large.".into());
    }
    if draft.attachments.len() > 100
        || draft.attachments.iter().any(|item| {
            item.token.len() > 4096
                || item.filename.len() > 255
                || item
                    .content_type
                    .as_ref()
                    .is_some_and(|value| value.len() > 255)
                || item
                    .content_id
                    .as_ref()
                    .is_some_and(|value| value.len() > 998 || value.contains(char::is_control))
        })
    {
        return Err("The attachment list is too large or invalid.".into());
    }
    Ok(())
}

pub fn validate_compose_sender(
    from: Option<&str>,
    account_email: &str,
    aliases: &[String],
) -> Result<(), String> {
    let Some(from) = from.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let mailbox: lettre::message::Mailbox = from
        .parse()
        .map_err(|_| "The sender address is invalid.".to_string())?;
    let address = mailbox.email.to_string();
    if sender_address_allowed(&address, account_email, aliases) {
        Ok(())
    } else {
        Err("Choose a From address that belongs to this account.".into())
    }
}

fn sender_address_allowed(address: &str, account_email: &str, aliases: &[String]) -> bool {
    let lower = address.trim().to_ascii_lowercase();
    std::iter::once(account_email)
        .chain(aliases.iter().map(String::as_str))
        .any(|item| item.trim().to_ascii_lowercase() == lower)
}

pub fn validate_folder_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed.contains(char::is_control) {
        return Err("Enter a folder name up to 128 characters.".into());
    }
    if trimmed != name {
        return Err("Remove spaces at the start or end of the folder name.".into());
    }
    if trimmed.eq_ignore_ascii_case("inbox") {
        return Err("That name is reserved for the inbox.".into());
    }
    // Hierarchy separators, LIST wildcards, and quoting characters reach the
    // IMAP session raw; keep names to plain printable text instead.
    if trimmed.contains(['/', '*', '%', '"', '\\'])
        || trimmed.chars().all(|character| character == '.')
    {
        return Err("Folder names cannot contain / * % \" or \\.".into());
    }
    Ok(trimmed.to_string())
}

/// Join a parent mailbox and a leaf into one IMAP name.
/// The leaf follows the same rules as a top-level folder name.
pub fn nested_folder_name(parent: &str, delimiter: &str, leaf: &str) -> Result<String, String> {
    let leaf = validate_folder_name(leaf)?;
    if parent.is_empty() || parent.chars().any(char::is_control) {
        return Err("That folder cannot hold another folder.".into());
    }
    if delimiter.is_empty()
        || delimiter.chars().count() > 4
        || delimiter
            .chars()
            .any(|character| character.is_control() || matches!(character, '*' | '%' | '"' | '\\'))
    {
        return Err("This mail server does not support folders inside folders.".into());
    }
    if leaf.contains(delimiter) {
        return Err("That name cannot contain the folder separator.".into());
    }
    let parent = parent.strip_suffix(delimiter).unwrap_or(parent);
    let name = format!("{parent}{delimiter}{leaf}");
    if name.chars().count() > 400 {
        return Err("That folder name is too long.".into());
    }
    Ok(name)
}

/// A new IMAP name that changes only the last part of a nested folder.
pub fn renamed_folder_name(current: &str, delimiter: &str, leaf: &str) -> Result<String, String> {
    if delimiter.is_empty() || !current.contains(delimiter) {
        return validate_folder_name(leaf);
    }
    match current.rfind(delimiter) {
        Some(index) if index > 0 => nested_folder_name(&current[..index], delimiter, leaf),
        _ => validate_folder_name(leaf),
    }
}

fn folder_leaf(current: &str, delimiter: &str) -> String {
    if delimiter.is_empty() {
        return current.to_string();
    }
    match current.rfind(delimiter) {
        Some(index) => current[index + delimiter.len()..].to_string(),
        None => current.to_string(),
    }
}

/// The IMAP name after moving a folder under `destination_parent`, or to the top.
pub fn moved_folder_name(
    current: &str,
    delimiter: &str,
    destination_parent: Option<&str>,
) -> Result<String, String> {
    let leaf = folder_leaf(current, delimiter);
    let Some(parent) = destination_parent else {
        return validate_folder_name(&leaf);
    };
    if parent == current
        || (!delimiter.is_empty() && parent.starts_with(&format!("{current}{delimiter}")))
    {
        return Err("Choose a different folder.".into());
    }
    nested_folder_name(parent, delimiter, &leaf)
}
