use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<ConnectionTestStage>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionTestStage {
    Imap,
    Smtp,
}

impl From<String> for IpcError {
    fn from(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let stage = if lower.starts_with("imap connection test failed") {
            Some(ConnectionTestStage::Imap)
        } else if lower.starts_with("smtp connection test failed") {
            Some(ConnectionTestStage::Smtp)
        } else {
            None
        };
        let (code, retryable) = classify_ipc_message(&lower);
        let generic = match code {
            "accessDenied" => "That item is not available for this account.",
            "notFound" => "That item is no longer available. Refresh mail and try again.",
            "limitExceeded" => "That item exceeds Postal Snap's safety limit.",
            "settingsNotFound" => {
                "Settings file could not be found. Choose a Postal Snap settings export."
            }
            "settingsTooLarge" => {
                "That settings file is too large. Choose a file smaller than 64 KiB."
            }
            "settingsInvalid" => "That file is not a valid Postal Snap settings export.",
            "settingsMigrationFailed" => {
                "Postal Snap could not migrate saved settings. Restart Postal Snap, or import/reset settings."
            }
            "settingsReadFailed" => {
                "Postal Snap could not read that settings file. Check its permissions and try again."
            }
            "settingsWriteFailed" => {
                "Postal Snap could not save settings. Check the destination and available disk space, then try again."
            }
            "authenticationFailed" => "Sign-in failed. Check the email address and password.",
            "certificateInvalid" => "Choose one valid, unexpired public PEM certificate exported by Bridge, without a private key.",
            "folderAttention" => "Assigned folder needs attention. Choose another folder or Automatic in Settings.",
            "identityConfirmation" => "Confirm the incoming server identity change before saving.",
            "pendingOperations" => "Resolve queued changes and unsent mail before changing the incoming server identity.",
            "certificateFailed" => "Certificate verification failed. Check the trusted server certificate.",
            "connectionFailed" => "Could not reach the mail server. Check your connection.",
            "localStorageFailed" => "Postal Snap could not access local mail data on your computer.",
            "invalidInput" => "Check the highlighted information and try again.",
            _ => "Postal Snap could not finish that action. Try again.",
        };
        Self {
            code: code.into(),
            // Category guidance beats detail for sign-in, network, and storage.
            message: matches!(code, "operationFailed" | "invalidInput" | "limitExceeded")
                .then(|| authored_detail(&message))
                .flatten()
                .unwrap_or_else(|| generic.into()),
            retryable,
            stage,
        }
    }
}

/// Authored prose passes through so errors stay specific. Anything that may
/// carry data (addresses, names, paths, hosts, server text) is replaced.
fn authored_detail(message: &str) -> Option<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() || trimmed.len() > 300 || !trimmed.is_ascii() {
        return None;
    }
    let chars = trimmed.as_bytes();
    for (index, &byte) in chars.iter().enumerate() {
        let unsafe_byte = byte.is_ascii_control()
            || matches!(
                byte,
                b'"' | b'`' | b'@' | b'/' | b'\\' | b'<' | b'[' | b'{' | b'=' | b'%' | b'#'
            );
        // Only a contraction apostrophe, never a quoted name.
        let quote = byte == b'\''
            && !(index > 0
                && chars[index - 1].is_ascii_alphabetic()
                && chars.get(index + 1).is_some_and(u8::is_ascii_alphabetic));
        if unsafe_byte || quote {
            return None;
        }
    }
    let dotted = trimmed.split_whitespace().any(|word| {
        let core = word.trim_end_matches(['.', ',', ';', '!', '?', ')']);
        core.contains('.') || core.contains(':')
    });
    (!dotted).then(|| trimmed.to_string())
}

impl From<&str> for IpcError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

fn classify_ipc_message(lower: &str) -> (&'static str, bool) {
    if lower.contains("settings could not be migrated")
        || lower.contains("saved application settings could not be migrated")
    {
        return ("settingsMigrationFailed", true);
    }
    if lower.contains("settings file was not found") {
        return ("settingsNotFound", false);
    }
    if lower.contains("settings file is too large")
        || lower.contains("settings payload is too large")
    {
        return ("settingsTooLarge", false);
    }
    if lower.contains("settings export is invalid")
        || lower.contains("invalid application settings")
        || lower.contains("settings path is invalid")
        || lower.contains("settings json is invalid")
    {
        return ("settingsInvalid", false);
    }
    if lower.contains("could not inspect application settings")
        || lower.contains("could not open application settings")
        || lower.contains("could not read application settings")
        || lower.contains("settings path is not a regular file")
        || lower.contains("choose a valid settings file")
    {
        return ("settingsReadFailed", true);
    }
    if lower.contains("could not create application data directory") {
        return ("localStorageFailed", true);
    }
    if lower.contains("could not replace application settings")
        || lower.contains("could not save settings")
        || lower.contains("could not write application settings")
        || lower.contains("settings path has no parent directory")
    {
        return ("settingsWriteFailed", true);
    }
    if lower.contains("assigned folder needs attention") {
        return ("folderAttention", false);
    }
    if lower.contains("confirm the incoming server identity change") {
        return ("identityConfirmation", false);
    }
    if lower.contains("resolve queued changes and unsent mail") {
        return ("pendingOperations", false);
    }
    if lower.contains("public pem certificate")
        || lower.contains("public certificate")
        || lower.contains("selected certificate")
        || lower.contains("one public pem")
    {
        return ("certificateInvalid", false);
    }
    if let Some(action) = redacted_mail_action(lower) {
        return classify_mail_action(action);
    }
    if lower.contains("certificate verification") {
        return ("certificateFailed", true);
    }
    if lower.contains("does not belong")
        || lower.contains("between accounts")
        || lower.contains("permission has expired")
    {
        return ("accessDenied", false);
    }
    if lower.contains("not found") {
        return ("notFound", false);
    }
    if lower.contains("too large") || lower.contains("too many") || lower.contains("exceeded safe")
    {
        return ("limitExceeded", false);
    }
    if lower.contains("sign-in") || lower.contains("credential") || lower.contains("app-specific") {
        return ("authenticationFailed", true);
    }
    if lower.contains("timed out")
        || lower.contains("connection")
        || lower.contains("mail server")
        || lower.contains("offline")
    {
        return ("connectionFailed", true);
    }
    if lower.contains("invalid")
        || lower.starts_with("enter ")
        || lower.starts_with("choose ")
        || lower.starts_with("add ")
        || lower.contains("required")
        || lower.contains("unsupported")
        || lower.starts_with("only ")
    {
        return ("invalidInput", false);
    }
    if lower.contains("database")
        || lower.contains("password vault")
        || lower.contains("account password store")
        || lower.contains("password is unavailable")
    {
        return ("localStorageFailed", true);
    }
    ("operationFailed", true)
}

fn redacted_mail_action(lower: &str) -> Option<&str> {
    let (action, rest) = lower.split_once(" failed.")?;
    if rest.contains("check the")
        && (rest.contains("mail server")
            || rest.contains("internet")
            || rest.contains("password")
            || rest.contains("server settings"))
    {
        Some(action)
    } else {
        None
    }
}

fn classify_mail_action(action: &str) -> (&'static str, bool) {
    if action.contains("sign-in") {
        ("authenticationFailed", true)
    } else if action.contains("certificate") {
        ("invalidInput", false)
    } else if action.contains("connection")
        || action.contains("tls")
        || action.contains("greeting")
        || action.contains("starttls")
        || action.contains("inbox monitoring")
    {
        ("connectionFailed", true)
    } else {
        ("operationFailed", true)
    }
}
