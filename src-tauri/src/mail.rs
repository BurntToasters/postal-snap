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
    pub has_html: bool,
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
    server_search, test_account, IdleOutcome, SyncHooks,
};

#[cfg(test)]
pub(crate) mod test_tls {
    use std::{
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;
    use tokio_native_tls::native_tls::Identity;
    use tokio_native_tls::TlsAcceptor;

    pub(crate) const CERT_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIDKTCCAhGgAwIBAgIUdtdsNCLQAK4o2qaN2dQoLQkXx7cwDQYJKoZIhvcNAQEL\n\
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTExNTIxMjE1NFoXDTI5MDEy\n\
MzIxMjE1NFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF\n\
AAOCAQ8AMIIBCgKCAQEAnPpHgwPiLACGjGoRkYrRleqKbjSm7FiwLw+HXZVJg36K\n\
RGpxHzPcPRB+eflX7Vl/gtvo270wVU/zcOGVqiglC3XNjpHyvhywRN/WMP5gukdV\n\
m1LKSe5ysctEDTh7Y+p9a1WVTdN/TyEWHa/ia7iHhzziFiQu/A1toioEemjQjgc/\n\
IEegDdMpa8Fprzu+vC9P5a/mHccg1PyVqRvIHt7BzPcHhBMMqf+4pu5tzzaH4pRn\n\
mmrHdDfZ07NMLLBxJ3BUY/NhPAS6C5GkiiPmxtMG+d8uIKokF4MUOskqBRgU1i3X\n\
INFmkKzhcbEo++MzQu3RUiWUlfgBZKNO2HI2yeSAMwIDAQABo3MwcTAPBgNVHRMB\n\
Af8EBTADAQH/MA4GA1UdDwEB/wQEAwICpDATBgNVHSUEDDAKBggrBgEFBQcDATAa\n\
BgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwHQYDVR0OBBYEFAT8p+eYIh6bcYj5\n\
/49Q+oWaik93MA0GCSqGSIb3DQEBCwUAA4IBAQA4NQnlieCXlmOhlACB7+0wtwg4\n\
vgSi0U1KTcOIcHgE6GcanVaSFgBlLLOANwVGYYem5EyxDr7E6VgkRtpkisth0THz\n\
47ltxQ++OZR7zJWDoIyTl7ptleajUfHDEgCz1KNvMU6TbLxKJ+CiMMgVzd4Zgxqw\n\
BKXnmmw125jlFRDN/ZonVg/aj5wl6v7SRlemj4PZd3lr4lKGYjP4ejOV4xxLRzpv\n\
l8b/iYPHDvpcvPEXhWq51WLLimlqThZo8OyRvHnTC4/P0yOnYrCQBy0jyJUOEedW\n\
Y+9io4YG/4FqMbbH4hGxtFWydPIjiSAeJxqqLJdrS1r4l266/3TrW5kxl4lH\n\
-----END CERTIFICATE-----\n";

    const KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCc+keDA+IsAIaM\n\
ahGRitGV6opuNKbsWLAvD4ddlUmDfopEanEfM9w9EH55+VftWX+C2+jbvTBVT/Nw\n\
4ZWqKCULdc2OkfK+HLBE39Yw/mC6R1WbUspJ7nKxy0QNOHtj6n1rVZVN039PIRYd\n\
r+JruIeHPOIWJC78DW2iKgR6aNCOBz8gR6AN0ylrwWmvO768L0/lr+YdxyDU/JWp\n\
G8ge3sHM9weEEwyp/7im7m3PNofilGeaasd0N9nTs0wssHEncFRj82E8BLoLkaSK\n\
I+bG0wb53y4gqiQXgxQ6ySoFGBTWLdcg0WaQrOFxsSj74zNC7dFSJZSV+AFko07Y\n\
cjbJ5IAzAgMBAAECggEAB8Akio4R7oHY75/hEPv3D/bay0j9B0uNtchUTHhgsjkr\n\
0ue9tBoXmrA9mACJ3D8zmFHXtAz2qo+rAZZk94swR3OTXAgaux/bGChETa3E0UDq\n\
ZvCpUKMqtVqUfpUDJDjH5OYx2/wNG7dF5BG/rsZKpfbvyfYS/jQcU9bNQWbH1utM\n\
YzfuYo8JBcL5T0mdlwxWYJGotIM2V+rFQQyrAUGnHqPhWtKG3nu5KpzoUje0nHF2\n\
gPZDMIQJtLwJb819QIJZ7ZrHHCcPwDTA2lsBkSA/ePe2H4xDsQNt+FRjEpcl+sob\n\
oHVnKyuWOU0TBptxewtViQ9D2SXxLWUAOj0w149JUQKBgQDc5gFdx+LhgJccljX1\n\
FiFvBXkkfoLUt1HdN20RQvCYNQnWrIFqsf4snTx0RB0cVnBzLa221ALR/YW2q15W\n\
dEBpbkBF12iYLSinRJWmAsfvQFVwybpIJX2OpKVrJM/M88glGljEUn/Yia7jfWHB\n\
3HWE7HvYKtuG6yvaD0XHS1UJuQKBgQC17AU55U5Zm+Rz8DSJ2GifByrN2wVZXYT4\n\
GSzFjH6QnApeZ3TkE43wvYiKI8HeiX394osVgEIlaXZ/onnItJRPyYuOam9cZIR4\n\
HNqzL+hMTaR1Gl4YQaYodKVR35WgOp6Hv7ltPO3u5vTwP9NJzeNDbQ1lfGQFHtWV\n\
2krnd9dfSwKBgHODd41x/IvNsbfKORcb5onnA814trPD1XRoConvRl9hxO5UsSx5\n\
PaBY7Qcjo1FxRkaEyYWE4qCrAaRfguqUyiYX+FZNaa3CV7L4o4T3iVPsgYGEi/w0\n\
Vq8kHDimPGBBzxTP7UFknuQ+Q41EwL0eqvnCrJSC/N9V1U2nlOa91w9JAoGBAI5f\n\
FMP3gfa8+vAFB4jtdQsn18bc5nXGq55iTViZGB/iDndNLfyklQvXuLirPTkEjzaX\n\
CdQc2SdgPt2qcPay4/MBPxeIknhTLhy2MC3Vi03T4aXHqeX/0qKMjyjg+r83wQNp\n\
9xrXeTnjQ8OVn6x91aLaAIbw73HWbL7m5IH7lvC7AoGACJWrKm3yG4ech7Z3bGdU\n\
EItlp+DYEDUf4ujkFNNeOrJHPKguBuW+BqnSiBMDJhMdNVf7VOQ+E4+w/TNjuYrA\n\
jJDQB6GVSf2kKhaNOmfSGbJpw5Yu1erVhECae2N+aGFbZ7mupKCpwAehZW1/o23T\n\
+/i6MhEPRiyJ9/Vyro9rzqk=\n\
-----END PRIVATE KEY-----\n";

    pub(crate) fn acceptor() -> TlsAcceptor {
        let identity = Identity::from_pkcs8(CERT_PEM.as_bytes(), KEY_PEM.as_bytes())
            .expect("valid loopback test TLS identity");
        TlsAcceptor::from(
            tokio_native_tls::native_tls::TlsAcceptor::new(identity)
                .expect("build loopback TLS acceptor"),
        )
    }

    pub(crate) async fn spawn_imap_server<F>(
        mut handler: F,
    ) -> (u16, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>)
    where
        F: FnMut(&str, &str, &str) -> Pin<Box<dyn Future<Output = Option<Vec<u8>>> + Send>>
            + Send
            + 'static,
    {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let tls = acceptor();
        let log = Arc::new(Mutex::new(Vec::new()));
        let recorded = log.clone();
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let Ok(stream) = tls.accept(tcp).await else {
                    continue;
                };
                let (reader, mut writer) = tokio::io::split(stream);
                let mut lines = BufReader::new(reader);
                if writer.write_all(b"* OK mock IMAP ready\r\n").await.is_err() {
                    continue;
                }
                let _ = writer.flush().await;
                let mut line = String::new();
                while lines.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let trimmed = line.trim_end_matches(&['\r', '\n'][..]).to_string();
                    line.clear();
                    if trimmed.is_empty() {
                        continue;
                    }
                    recorded.lock().unwrap().push(trimmed.clone());
                    let mut parts = trimmed.splitn(2, ' ');
                    let tag = parts.next().unwrap_or("");
                    let rest = parts.next().unwrap_or("");
                    let verb = rest.split(' ').next().unwrap_or("").to_ascii_uppercase();
                    if let Some(reply) = handler(tag, &verb, rest).await {
                        if writer.write_all(&reply).await.is_err() {
                            break;
                        }
                        let _ = writer.flush().await;
                        if verb == "LOGOUT" {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
        });
        (port, log, task)
    }
}

#[cfg(test)]
mod tests;
