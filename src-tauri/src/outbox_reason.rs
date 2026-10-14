//! Stable outbox reasons. English detail is retained only for legacy IPC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboxReason {
    WaitingConnection,
    Scheduled,
    HeldForReview,
    SentCopyPending,
    ArchivePending,
    ArchiveSourceUnavailable,
    ArchiveFailed,
    PreparationFailed,
    RetryPending,
    RetryExhausted,
    SendRefused,
    DeliveryUncertain,
    InterruptedSend,
}

impl OutboxReason {
    pub const ALL: &'static [Self] = &[
        Self::WaitingConnection,
        Self::Scheduled,
        Self::HeldForReview,
        Self::SentCopyPending,
        Self::ArchivePending,
        Self::ArchiveSourceUnavailable,
        Self::ArchiveFailed,
        Self::PreparationFailed,
        Self::RetryPending,
        Self::RetryExhausted,
        Self::SendRefused,
        Self::DeliveryUncertain,
        Self::InterruptedSend,
    ];

    pub fn code(self) -> &'static str {
        match self {
            Self::WaitingConnection => "waitingConnection",
            Self::Scheduled => "scheduled",
            Self::HeldForReview => "heldForReview",
            Self::SentCopyPending => "sentCopyPending",
            Self::ArchivePending => "archivePending",
            Self::ArchiveSourceUnavailable => "archiveSourceUnavailable",
            Self::ArchiveFailed => "archiveFailed",
            Self::PreparationFailed => "preparationFailed",
            Self::RetryPending => "retryPending",
            Self::RetryExhausted => "retryExhausted",
            Self::SendRefused => "sendRefused",
            Self::DeliveryUncertain => "deliveryUncertain",
            Self::InterruptedSend => "interruptedSend",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::WaitingConnection => "Waiting for a secure mail connection.",
            Self::Scheduled => "Scheduled to send.",
            Self::HeldForReview => "Held for review. Undo anytime before it sends.",
            Self::SentCopyPending => "Message sent. Its Sent-folder copy is waiting for a safe retry.",
            Self::ArchivePending => "Message sent. The archive status needs attention. Retry archive or dismiss this warning.",
            Self::ArchiveSourceUnavailable => "Message sent. The original is moving or no longer in its recorded folder. Check its location, then dismiss this warning.",
            Self::ArchiveFailed => "Message sent, but the original could not be archived.",
            Self::PreparationFailed => "The message was not sent. Check its attachments and account, then try again.",
            Self::RetryPending => "Not sent yet. The mail server could not take it right now. Postal Snap will try again automatically.",
            Self::RetryExhausted => "Not sent. The mail server kept asking to try later. Check the message and account, then try again.",
            Self::SendRefused => "Not sent. The mail server refused this message. Check the recipients and the account, then try again.",
            Self::DeliveryUncertain => "Delivery could not be confirmed. Postal Snap will not resend automatically.",
            Self::InterruptedSend => "Postal Snap closed before delivery could be confirmed. It will not resend automatically.",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|reason| reason.code() == code)
    }

    /// Exact legacy conversion; no control flow classifies prose.
    pub fn from_legacy(message: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|reason| reason.message() == message)
    }
}

impl From<OutboxReason> for String {
    fn from(reason: OutboxReason) -> Self {
        reason.message().into()
    }
}
