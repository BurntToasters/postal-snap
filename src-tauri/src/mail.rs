pub mod append;
pub mod connect;
pub mod failure;
pub mod flowed;
pub mod folders;
pub mod icloud;
pub mod ics;
pub mod keywords;
pub mod list_status;
pub mod list_unsubscribe;
pub mod parse;
pub mod pool;
pub mod qresync;
pub mod remote_drafts;
pub mod send;
pub mod source;
pub mod sync;
pub mod utf7;
pub mod watch;

use std::time::Duration;

use async_imap::Session;
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const IMAP_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
pub const MAX_MESSAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_MIME_PARTS: usize = 500;
const MAX_MULTIPART_DECLARATIONS: usize = 64;
const MAX_ATTACHMENTS: usize = 100;
pub const MAX_OUTGOING_BYTES: usize = 100 * 1024 * 1024;
const INITIAL_MESSAGE_BATCH: u32 = 150;
const BACKFILL_MESSAGE_BATCH: u32 = 75;

type ImapSession = Session<TlsStream<TcpStream>>;

/// Admission control for streamed IMAP body responses. A server-declared
/// RFC822.SIZE is never trusted: only the actual delivered length counts, and
/// the cumulative total bounds how much a single fetch cycle retains.
#[derive(Default)]
pub(crate) struct BodyBudget {
    consumed: usize,
}

impl BodyBudget {
    pub(crate) fn admit(&mut self, actual_len: usize, max_item: usize, max_total: usize) -> bool {
        if actual_len > max_item {
            return false;
        }
        let next = self.consumed.saturating_add(actual_len);
        if next > max_total {
            return false;
        }
        self.consumed = next;
        true
    }
}

pub struct PreparedMessage {
    pub message_id: String,
    pub bytes: Vec<u8>,
}

pub struct RemoteDraftLocation {
    pub uid: u32,
    pub uid_validity: Option<u32>,
}

pub struct RemoteDraftAttachment {
    pub filename: String,
    pub content_type: String,
    pub inline: bool,
    pub content_id: Option<String>,
    pub bytes: Vec<u8>,
}

pub struct RemoteDraftData {
    pub uid: u32,
    pub message_id: Option<String>,
    pub updated_at: String,
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html_body: String,
    pub text_body: String,
    pub in_reply_to: Option<String>,
    pub references: Option<Vec<String>>,
    pub attachments: Vec<RemoteDraftAttachment>,
}

pub struct RemoteDraftSnapshot {
    pub uid_validity: Option<u32>,
    pub uids: Vec<u32>,
    pub drafts: Vec<RemoteDraftData>,
}

pub use folders::{
    copy_remote, copy_remote_uids, create_folder, delete_folder, empty_folder, expunge_uids,
    mark_folder_read, move_remote, move_remote_uids_with_junk, rename_folder, set_remote_flags,
    set_remote_keyword, set_remote_uid_flags, CopyOptions, MailboxOperationError, MoveOptions,
    MoveReplayFlags, SourceKeyword,
};
pub use icloud::discover_icloud_aliases;
pub use remote_drafts::{
    delete_remote_draft, extract_attachment, fetch_remote_drafts, upsert_remote_draft,
};
pub use send::{
    apply_signature, ensure_sent_copy, prepare_draft_message, prepare_message, prepare_redirect,
    send_prepared, SendFailure,
};
#[cfg(test)]
pub use sync::sync_account;
#[cfg(test)]
pub use sync::Uncontended;
pub use sync::{
    download_message, idle_inbox, load_older_messages, probe_mail_login, refresh_mailbox_envelopes,
    server_search, test_account, IdleOutcome, SyncHooks, SyncOutcome,
};

#[cfg(test)]
mod tests;
