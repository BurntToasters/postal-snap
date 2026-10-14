//! Why a mail operation failed, as a value. Decisions such as pausing an
//! account after a rejected password read the kind, never the wording.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// The server answered the sign-in with NO or BAD.
    SignInRejected,
    /// Timeout, refused or dropped connection, or failed TLS.
    Connection,
    /// Over a safety size limit.
    TooLarge,
    /// The message cannot be parsed safely and stays quarantined.
    Unreadable,
    /// The local database or credential vault failed.
    LocalStorage,
    Other,
}

#[derive(Debug)]
pub struct MailError {
    pub kind: FailureKind,
    pub message: String,
}

impl MailError {
    pub fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn connection(message: impl Into<String>) -> Self {
        Self::new(FailureKind::Connection, message)
    }

    pub fn local_storage(message: impl Into<String>) -> Self {
        Self::new(FailureKind::LocalStorage, message)
    }
}

impl fmt::Display for MailError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

/// Errors from helpers that still return text carry no decision.
impl From<String> for MailError {
    fn from(message: String) -> Self {
        Self::new(FailureKind::Other, message)
    }
}

impl From<MailError> for String {
    fn from(error: MailError) -> Self {
        error.message
    }
}

impl From<MailError> for crate::models::IpcError {
    fn from(error: MailError) -> Self {
        let (code, message, retryable) = match error.kind {
            FailureKind::SignInRejected => (
                "authenticationFailed",
                "Sign-in failed. Check the email address and password.",
                true,
            ),
            FailureKind::Connection => (
                "connectionFailed",
                "Could not reach the mail server. Check your connection.",
                true,
            ),
            FailureKind::TooLarge => (
                "limitExceeded",
                "That item exceeds Postal Snap's safety limit.",
                false,
            ),
            FailureKind::Unreadable => (
                "operationFailed",
                "This message cannot be read safely.",
                false,
            ),
            FailureKind::LocalStorage => (
                "localStorageFailed",
                "Postal Snap could not access local mail data on your computer.",
                true,
            ),
            FailureKind::Other => return error.message.into(),
        };
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            stage: None,
        }
    }
}

/// Only an explicit NO or BAD reply rejects the credentials.
pub fn login_failure_kind(error: &async_imap::error::Error) -> FailureKind {
    match error {
        async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_) => {
            FailureKind::SignInRejected
        }
        _ => FailureKind::Connection,
    }
}

/// How the reader explains a body it could not download. `None` means the
/// failure is unexpected and is reported as an error.
pub fn body_status(error: &MailError) -> Option<&'static str> {
    match error.kind {
        FailureKind::Connection | FailureKind::LocalStorage => Some("offline"),
        FailureKind::SignInRejected => Some("signInNeeded"),
        FailureKind::TooLarge => Some("tooLarge"),
        FailureKind::Unreadable => Some("unreadable"),
        FailureKind::Other => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure modes for decisions that used to read error wording:
    // 1. Rewording a sign-in error stops the worker from pausing, so a
    //    rejected password is retried until the provider locks the account.
    // 2. A timeout or dropped connection pauses the account as "Sign-in
    //    failed" and waits for a new password.
    // 3. The reader shows an error page instead of the envelope when the
    //    body is unavailable for an expected reason.
    // 4. An unreadable (quarantined) message is retried or shown as offline.
    // 5. Converting to a String for older callers loses the wording.
    // IPC conversion must preserve the kind and redact arbitrary server text.
    #[test]
    fn ipc_failure_kind_does_not_depend_on_prose() {
        for (kind, code) in [
            (FailureKind::SignInRejected, "authenticationFailed"),
            (FailureKind::Connection, "connectionFailed"),
            (FailureKind::TooLarge, "limitExceeded"),
            (FailureKind::Unreadable, "operationFailed"),
            (FailureKind::LocalStorage, "localStorageFailed"),
        ] {
            let error: crate::models::IpcError =
                MailError::new(kind, "private@example.test /private/file").into();
            assert_eq!(error.code, code);
            assert!(!error.message.contains("private"));
        }
    }

    #[test]
    fn login_replies_decide_sign_in_failures() {
        let no = async_imap::error::Error::No("[AUTHENTICATIONFAILED] Invalid".into());
        let bad = async_imap::error::Error::Bad("bad".into());
        let io = async_imap::error::Error::Io(std::io::Error::other("reset"));
        assert_eq!(login_failure_kind(&no), FailureKind::SignInRejected);
        assert_eq!(login_failure_kind(&bad), FailureKind::SignInRejected);
        assert_eq!(login_failure_kind(&io), FailureKind::Connection);
    }

    #[test]
    fn body_status_follows_the_kind_not_the_message() {
        let status = |kind| body_status(&MailError::new(kind, "Any words at all."));
        assert_eq!(status(FailureKind::Connection), Some("offline"));
        assert_eq!(status(FailureKind::LocalStorage), Some("offline"));
        assert_eq!(status(FailureKind::SignInRejected), Some("signInNeeded"));
        assert_eq!(status(FailureKind::TooLarge), Some("tooLarge"));
        assert_eq!(status(FailureKind::Unreadable), Some("unreadable"));
        assert_eq!(status(FailureKind::Other), None);
        let text: String = MailError::new(FailureKind::Other, "Exact words.").into();
        assert_eq!(text, "Exact words.");
        let other: MailError = String::from("From a helper.").into();
        assert_eq!(other.kind, FailureKind::Other);
    }
}
