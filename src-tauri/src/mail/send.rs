use std::{
    io,
    net::SocketAddr,
    path::Path,
    pin::Pin,
    task::{Context, Poll},
};

use async_imap::Authenticator;
use lettre::{
    address::Envelope,
    message::{
        header::{ContentType, Header, HeaderName, HeaderValue},
        Attachment as LettreAttachment, Mailbox, MultiPart, SinglePart,
    },
    transport::smtp::authentication::{Credentials, Mechanism},
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
};
use zeroize::Zeroizing;

use super::flowed::encode_flowed;
use super::parse::parse_mailbox;
use super::remote_drafts::search_header_id;
use super::{
    ImapSession, PreparedMessage, CONNECT_TIMEOUT, IMAP_COMMAND_TIMEOUT, MAX_ATTACHMENTS,
    MAX_MESSAGE_BYTES, MAX_OUTGOING_BYTES,
};
use crate::{
    models::{
        validate_compose_sender, AccountRecord, BodyFormat, ComposeDraft, ServerConfig, TlsMode,
    },
    security::{redact_error, safe_filename},
};

pub async fn prepare_message(
    account: &AccountRecord,
    draft: &ComposeDraft,
) -> Result<PreparedMessage, String> {
    let message_id = format!("<{}@run.rosie.snap>", uuid::Uuid::new_v4());
    let message = build_message_with_id(account, draft, &message_id, false).await?;
    let bytes = message.formatted();
    if bytes.len() > MAX_OUTGOING_BYTES {
        return Err("The message and its attachments are too large to send safely.".into());
    }
    Ok(PreparedMessage { message_id, bytes })
}

pub async fn prepare_draft_message(
    account: &AccountRecord,
    draft: &ComposeDraft,
    message_id: &str,
) -> Result<Vec<u8>, String> {
    let bytes = build_message_with_id(account, draft, message_id, true)
        .await?
        .formatted();
    if bytes.len() > MAX_OUTGOING_BYTES {
        return Err("The message and its attachments are too large to send safely.".into());
    }
    Ok(bytes)
}

/// Send the original bytes unchanged, with Resent-* headers in front.
/// Bcc is an SMTP recipient only and is not written into the message.
pub fn prepare_redirect(
    account: &AccountRecord,
    draft: &ComposeDraft,
    raw: &[u8],
) -> Result<PreparedMessage, String> {
    if raw.is_empty() {
        return Err("This message has not been downloaded yet.".into());
    }
    if raw.len() > MAX_MESSAGE_BYTES {
        return Err("This message is too large to redirect.".into());
    }
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err("Add at least one recipient.".into());
    }
    let message_id = format!("<{}@run.rosie.snap>", uuid::Uuid::new_v4());
    let headers = redirect_headers(account, draft, &message_id)?;
    let mut bytes = headers.into_bytes();
    bytes.extend(strip_bcc_headers(raw)?);
    if bytes.len() > MAX_OUTGOING_BYTES {
        return Err("The message and its attachments are too large to send safely.".into());
    }
    Ok(PreparedMessage { message_id, bytes })
}

fn redirect_headers(
    account: &AccountRecord,
    draft: &ComposeDraft,
    message_id: &str,
) -> Result<String, String> {
    validate_compose_sender(
        draft.from.as_deref(),
        &account.summary.email,
        &account.summary.aliases,
    )?;
    let sender_email = draft
        .from
        .as_deref()
        .map(str::trim)
        .filter(|addr| !addr.is_empty())
        .unwrap_or(account.summary.email.as_str());
    let from = redirect_from(&account.summary.display_name, sender_email)?;
    let date = chrono::Utc::now().to_rfc2822();
    if date.chars().any(char::is_control) {
        return Err("The message envelope is invalid.".into());
    }
    let mut lines = vec![
        format!("Resent-From: {from}"),
        format!("Resent-Date: {date}"),
        format!("Resent-Message-ID: {message_id}"),
    ];
    if let Some(line) = address_header("Resent-To", &draft.to)? {
        lines.push(line);
    }
    if let Some(line) = address_header("Resent-Cc", &draft.cc)? {
        lines.push(line);
    }
    for line in &lines {
        if line.len() > 998 || line.chars().any(char::is_control) {
            return Err("Shorten the recipient list.".into());
        }
    }
    Ok(format!("{}\r\n", lines.join("\r\n")))
}

fn redirect_from(display_name: &str, email: &str) -> Result<String, String> {
    let address: lettre::Address = email
        .parse()
        .map_err(|_| "The sender address is invalid.".to_string())?;
    let name = display_name.trim();
    let name = if name.is_empty() {
        None
    } else if name.chars().any(char::is_control) {
        return Err("The sender address is invalid.".into());
    } else {
        Some(name.to_string())
    };
    let rendered = Mailbox::new(name, address).to_string();
    if rendered.chars().any(char::is_control) {
        return Err("The sender address is invalid.".into());
    }
    Ok(rendered)
}

fn address_header(label: &str, values: &[String]) -> Result<Option<String>, String> {
    if values.is_empty() {
        return Ok(None);
    }
    let mut parts = Vec::with_capacity(values.len());
    for value in values {
        let mailbox: Mailbox = value
            .trim()
            .parse()
            .map_err(|_| "One of the recipient addresses is invalid.".to_string())?;
        let rendered = mailbox.to_string();
        if rendered.chars().any(char::is_control) {
            return Err("One of the recipient addresses is invalid.".into());
        }
        parts.push(rendered);
    }
    Ok(Some(format!("{label}: {}", parts.join(", "))))
}

/// Sent-copy lookup uses Resent-Message-ID when this send added one.
pub(crate) fn sent_copy_header(message_id: &str, bytes: &[u8]) -> &'static str {
    if message_id.is_empty() {
        return "Message-ID";
    }
    let end = header_block_end(bytes);
    let needle = format!("Resent-Message-ID: {message_id}");
    if bytes[..end]
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
    {
        "Resent-Message-ID"
    } else {
        "Message-ID"
    }
}

const MAX_REDIRECT_HEADER_BYTES: usize = 64 * 1024;

/// Copy the original bytes without Bcc header fields. The body is copied as-is.
fn strip_bcc_headers(raw: &[u8]) -> Result<Vec<u8>, String> {
    let limit = raw.len().min(MAX_REDIRECT_HEADER_BYTES);
    let mut out = Vec::with_capacity(raw.len());
    let mut position = 0;
    // True while inside a Bcc field, including its folded lines.
    let mut skipping = false;
    loop {
        if position >= raw.len() {
            return Ok(out);
        }
        if position >= limit {
            return Err("This message is too large to redirect.".into());
        }
        let line_end = match raw[position..limit].iter().position(|&byte| byte == b'\n') {
            Some(offset) => position + offset + 1,
            None if limit == raw.len() => raw.len(),
            None => return Err("This message is too large to redirect.".into()),
        };
        let line = &raw[position..line_end];
        let content = line.strip_suffix(b"\n").unwrap_or(line);
        let content = content.strip_suffix(b"\r").unwrap_or(content);
        if content.is_empty() {
            out.extend_from_slice(&raw[position..]);
            return Ok(out);
        }
        let folded = matches!(content[0], b' ' | b'\t');
        if !folded {
            skipping = header_name_is_bcc(content);
        }
        if !skipping {
            out.extend_from_slice(line);
        }
        position = line_end;
    }
}

fn header_name_is_bcc(line: &[u8]) -> bool {
    let Some(colon) = line.iter().position(|&byte| byte == b':') else {
        return false;
    };
    line[..colon].trim_ascii().eq_ignore_ascii_case(b"bcc")
}

fn header_block_end(bytes: &[u8]) -> usize {
    let limit = bytes.len().min(64 * 1024);
    let head = &bytes[..limit];
    if let Some(position) = head.windows(4).position(|window| window == b"\r\n\r\n") {
        return position;
    }
    if let Some(position) = head.windows(2).position(|window| window == b"\n\n") {
        return position;
    }
    limit
}

/// What a failed SMTP send means for the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendFailure {
    /// Never accepted and safe to try again: a 4xx reply, or no connection.
    NotSentRetry,
    /// Never accepted and a retry will not help: a 5xx reply or failed TLS.
    NotSentRefused,
    /// The connection may have dropped after the message body. Never resend
    /// without the user.
    Uncertain,
}

/// Why a send failed. The server's words are never kept: they can name
/// addresses, and the outbox shows a fixed plain explanation instead.
#[derive(Debug)]
pub struct SendError {
    pub kind: SendFailure,
}

/// SMTP replies are final: a 4xx or 5xx means the server did not take the
/// message, at any stage. Only a lost connection mid-session is uncertain.
pub(crate) fn classify_send_failure(
    permanent: bool,
    transient: bool,
    tls: bool,
    connect_failed: bool,
) -> SendFailure {
    if permanent || tls {
        SendFailure::NotSentRefused
    } else if transient || connect_failed {
        SendFailure::NotSentRetry
    } else {
        SendFailure::Uncertain
    }
}

pub async fn send_prepared(
    account: &AccountRecord,
    password: &str,
    draft: &ComposeDraft,
    bytes: &[u8],
) -> Result<(), SendError> {
    // Nothing reached a server before the transport exists.
    let refused = |_| SendError {
        kind: SendFailure::NotSentRefused,
    };
    let envelope = message_envelope(account, draft).map_err(refused)?;
    let password = Zeroizing::new(password.to_string());
    let xoauth2 = account.summary.auth_method == "oauth";
    if account.smtp.trusted_certificate.is_some() {
        let mut connection = connect_pinned_smtp(&account.smtp, &password, xoauth2)
            .await
            .map_err(|message| SendError {
                kind: if message.to_ascii_lowercase().contains("certificate")
                    || message.to_ascii_lowercase().contains("tls")
                    || message.contains("sign-in")
                {
                    SendFailure::NotSentRefused
                } else {
                    SendFailure::NotSentRetry
                },
            })?;
        tokio::time::timeout(CONNECT_TIMEOUT, connection.send(&envelope, bytes))
            .await
            .map_err(|_| SendError {
                kind: SendFailure::Uncertain,
            })?
            .map_err(|error| SendError {
                kind: classify_send_failure(
                    error.is_permanent(),
                    error.is_transient(),
                    error.is_tls(),
                    false,
                ),
            })?;
        return Ok(());
    }
    let transport = smtp_transport(&account.smtp, &password, xoauth2).map_err(refused)?;
    transport
        .send_raw(&envelope, bytes)
        .await
        .map_err(|error| SendError {
            // lettre keeps its connect-failure kind private; its Debug output
            // names it. `refused_smtp_connection_is_not_sent` pins this.
            kind: classify_send_failure(
                error.is_permanent(),
                error.is_transient(),
                error.is_tls(),
                format!("{error:?}").contains("kind: Connection"),
            ),
        })?;
    Ok(())
}

pub async fn ensure_sent_copy(
    account: &AccountRecord,
    password: &str,
    mailbox: &str,
    message_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let mut session = super::pool::checkout(account, password).await?;
    let wire_mailbox = session.mailbox_name(mailbox);
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_mailbox))
        .await
        .map_err(|_| "Sent folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Sent folder"))?;
    let header = sent_copy_header(message_id, bytes);
    let existing = search_header_id(&mut session, header, message_id, "Sent folder").await?;
    if existing.is_empty() {
        tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.append(&wire_mailbox, Some("(\\Seen)"), None, bytes),
        )
        .await
        .map_err(|_| "Saving the Sent copy timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Save Sent copy"))?;
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(&wire_mailbox))
            .await
            .map_err(|_| "Sent folder timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Sent folder"))?;
        if search_header_id(&mut session, header, message_id, "Sent folder")
            .await?
            .is_empty()
        {
            return Err("The message was sent, but its Sent copy could not be confirmed.".into());
        }
    }
    session.release();
    Ok(())
}

pub(crate) async fn connect_imap(
    server: &ServerConfig,
    password: &str,
) -> Result<ImapSession, String> {
    connect_imap_auth(server, password, false).await
}

pub(crate) async fn connect_imap_auth(
    server: &ServerConfig,
    password: &str,
    xoauth2: bool,
) -> Result<ImapSession, String> {
    if xoauth2 {
        guard_xoauth2_server(server, true)?;
    }
    let address = (server.host.as_str(), server.port);
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| "Incoming server timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Incoming connection"))?;
    let mut native_connector = tokio_native_tls::native_tls::TlsConnector::builder();
    if let Some(pem) = &server.trusted_certificate {
        crate::bridge::validate_loopback(&server.host)?;
        crate::bridge::certificate_metadata(pem)?;
        let certificate = tokio_native_tls::native_tls::Certificate::from_pem(pem.as_bytes())
            .map_err(|_| "The saved Bridge certificate is invalid.".to_string())?;
        native_connector.add_root_certificate(certificate);
    }
    #[cfg(test)]
    let native_connector = add_test_imap_root(native_connector)?;
    let native_connector = native_connector
        .build()
        .map_err(|error| redact_error(&error, "Incoming TLS setup"))?;
    let connector = tokio_native_tls::TlsConnector::from(native_connector);
    let client = match server.tls_mode {
        TlsMode::Tls => {
            let tls = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(&server.host, tcp))
                .await
                .map_err(|_| "Incoming TLS negotiation timed out.".to_string())?
                .map_err(|error| crate::bridge::tls_error(&error, "Incoming TLS negotiation"))?;
            verify_pinned_stream(server, &tls)?;
            let mut client = async_imap::Client::new(tls);
            tokio::time::timeout(CONNECT_TIMEOUT, client.read_response())
                .await
                .map_err(|_| "Incoming greeting timed out.".to_string())?
                .map_err(|error| redact_error(&error, "Incoming greeting"))?
                .ok_or_else(|| "The incoming server closed the secure connection.".to_string())?;
            client
        }
        TlsMode::StartTls => {
            let mut plain = async_imap::Client::new(tcp);
            tokio::time::timeout(CONNECT_TIMEOUT, plain.read_response())
                .await
                .map_err(|_| "Incoming greeting timed out.".to_string())?
                .map_err(|error| redact_error(&error, "Incoming greeting"))?
                .ok_or_else(|| "The incoming server closed the connection.".to_string())?;
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                plain.run_command_and_check_ok("STARTTLS", None),
            )
            .await
            .map_err(|_| "Incoming STARTTLS timed out.".to_string())?
            .map_err(|error| redact_error(&error, "Required incoming STARTTLS"))?;
            let tls = tokio::time::timeout(
                CONNECT_TIMEOUT,
                connector.connect(&server.host, plain.into_inner()),
            )
            .await
            .map_err(|_| "Incoming STARTTLS timed out.".to_string())?
            .map_err(|error| crate::bridge::tls_error(&error, "Incoming STARTTLS"))?;
            verify_pinned_stream(server, &tls)?;
            async_imap::Client::new(tls)
        }
    };
    // Only an explicit NO/BAD answer means the credentials were rejected.
    // Timeouts and dropped connections are transient and must not park the
    // account as "Sign-in failed".
    let authenticated = if xoauth2 {
        let auth = Xoauth2Authenticator::new(&server.username, password);
        tokio::time::timeout(CONNECT_TIMEOUT, client.authenticate("XOAUTH2", auth)).await
    } else {
        tokio::time::timeout(CONNECT_TIMEOUT, client.login(&server.username, password)).await
    };
    authenticated
        .map_err(|_| "Incoming server timed out.".to_string())?
        .map_err(|(error, _)| match error {
            async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_) => {
                redact_error(&error, "Incoming sign-in")
            }
            _ => redact_error(&error, "Incoming connection"),
        })
}

struct Xoauth2Authenticator {
    initial: Zeroizing<Vec<u8>>,
    sent: bool,
}

impl Xoauth2Authenticator {
    fn new(username: &str, access_token: &str) -> Self {
        Self {
            initial: Zeroizing::new(
                format!("user={username}\x01auth=Bearer {access_token}\x01\x01").into_bytes(),
            ),
            sent: false,
        }
    }
}

impl Authenticator for Xoauth2Authenticator {
    type Response = Vec<u8>;

    fn process(&mut self, challenge: &[u8]) -> Self::Response {
        // An empty continuation asks for the initial response. A later
        // challenge is a failure body; answer empty so the server closes it.
        if self.sent || !challenge.is_empty() {
            return Vec::new();
        }
        self.sent = true;
        self.initial.to_vec()
    }
}

fn guard_xoauth2_server(server: &ServerConfig, incoming: bool) -> Result<(), String> {
    if server.trusted_certificate.is_some() {
        return Err("This sign-in only works with the provider's mail servers.".into());
    }
    let tls_ok = if incoming {
        server.tls_mode == TlsMode::Tls
    } else {
        server.tls_mode == TlsMode::StartTls
    };
    if !tls_ok {
        return Err("This sign-in only works with the provider's mail servers.".into());
    }
    crate::oauth::allow_xoauth2_server(&server.host, server.port, incoming)
}

pub(crate) fn smtp_auth_mechanisms(xoauth2: bool) -> Vec<Mechanism> {
    if xoauth2 {
        vec![Mechanism::Xoauth2]
    } else {
        vec![Mechanism::Plain, Mechanism::Login]
    }
}

fn verify_pinned_stream(
    server: &ServerConfig,
    stream: &tokio_native_tls::TlsStream<TcpStream>,
) -> Result<(), String> {
    let Some(pem) = &server.trusted_certificate else {
        return Ok(());
    };
    let peer = stream
        .get_ref()
        .peer_certificate()
        .map_err(|_| {
            "Certificate verification failed. Could not inspect the Bridge certificate.".to_string()
        })?
        .ok_or("Certificate verification failed. Bridge did not present a certificate.")?;
    let der = peer.to_der().map_err(|_| {
        "Certificate verification failed. The Bridge certificate is invalid.".to_string()
    })?;
    crate::bridge::verify_peer_certificate(pem, &der)
}

// STARTTLS has already consumed the greeting when lettre takes this stream.
#[derive(Debug)]
struct PinnedSmtpStream {
    stream: tokio_native_tls::TlsStream<TcpStream>,
    peer: SocketAddr,
    greeting: &'static [u8],
}

impl AsyncRead for PinnedSmtpStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.greeting.is_empty() && buf.remaining() > 0 {
            let count = self.greeting.len().min(buf.remaining());
            buf.put_slice(&self.greeting[..count]);
            self.greeting = &self.greeting[count..];
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for PinnedSmtpStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

impl lettre::transport::smtp::client::AsyncTokioStream for PinnedSmtpStream {
    fn peer_addr(&self) -> io::Result<SocketAddr> {
        Ok(self.peer)
    }
}

async fn smtp_reply(tcp: &mut TcpStream, expected: &[u8; 3]) -> Result<bool, String> {
    let mut supports_starttls = false;
    let mut total = 0usize;
    for _ in 0..128 {
        let mut line = Vec::new();
        loop {
            let byte = tcp
                .read_u8()
                .await
                .map_err(|_| "Outgoing connection closed during secure setup.".to_string())?;
            line.push(byte);
            total += 1;
            if line.len() > 4096 || total > 65536 {
                return Err("Outgoing server response exceeded the safe limit.".into());
            }
            if byte == b'\n' {
                break;
            }
        }
        if line.len() < 6
            || &line[..3] != expected
            || !line.ends_with(b"\r\n")
            || !matches!(line[3], b' ' | b'-')
        {
            return Err("Outgoing server refused secure connection setup.".into());
        }
        let extension = &line[4..line.len() - 2];
        if extension.eq_ignore_ascii_case(b"STARTTLS") {
            supports_starttls = true;
        }
        if line[3] == b' ' {
            return Ok(supports_starttls);
        }
    }
    Err("Outgoing server response exceeded the safe limit.".into())
}

async fn connect_pinned_smtp(
    server: &ServerConfig,
    password: &str,
    xoauth2: bool,
) -> Result<lettre::transport::smtp::client::AsyncSmtpConnection, String> {
    if xoauth2 {
        return Err("This sign-in only works with the provider's mail servers.".into());
    }
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        use lettre::transport::smtp::{client::AsyncSmtpConnection, extension::ClientId};
        crate::bridge::validate_loopback(&server.host)?;
        let pem = server
            .trusted_certificate
            .as_deref()
            .ok_or("The Bridge certificate is unavailable.")?;
        crate::bridge::certificate_metadata(pem)?;
        let certificate = tokio_native_tls::native_tls::Certificate::from_pem(pem.as_bytes())
            .map_err(|_| "The saved Bridge certificate is invalid.".to_string())?;
        let connector = tokio_native_tls::native_tls::TlsConnector::builder()
            .add_root_certificate(certificate)
            .build()
            .map_err(|error| crate::bridge::tls_error(&error, "Outgoing TLS setup"))?;
        let mut tcp = TcpStream::connect((server.host.as_str(), server.port))
            .await
            .map_err(|error| redact_error(&error, "Outgoing connection"))?;
        let peer = tcp
            .peer_addr()
            .map_err(|_| "Outgoing connection is unavailable.".to_string())?;
        let greeting = match server.tls_mode {
            TlsMode::Tls => &b""[..],
            TlsMode::StartTls => {
                smtp_reply(&mut tcp, b"220").await?;
                tcp.write_all(b"EHLO localhost\r\n")
                    .await
                    .map_err(|_| "Outgoing connection failed.".to_string())?;
                if !smtp_reply(&mut tcp, b"250").await? {
                    return Err("Required outgoing STARTTLS is unavailable.".into());
                }
                tcp.write_all(b"STARTTLS\r\n")
                    .await
                    .map_err(|_| "Required outgoing STARTTLS failed.".to_string())?;
                smtp_reply(&mut tcp, b"220").await?;
                &b"220 localhost ESMTP\r\n"[..]
            }
        };
        let connector = tokio_native_tls::TlsConnector::from(connector);
        let stream = connector
            .connect(&server.host, tcp)
            .await
            .map_err(|error| crate::bridge::tls_error(&error, "Outgoing TLS negotiation"))?;
        verify_pinned_stream(server, &stream)?;
        let stream = PinnedSmtpStream {
            stream,
            peer,
            greeting,
        };
        let mut connection =
            AsyncSmtpConnection::connect_with_transport(Box::new(stream), &ClientId::default())
                .await
                .map_err(|error| redact_error(&error, "Outgoing greeting"))?;
        connection
            .auth(
                &smtp_auth_mechanisms(false),
                &Credentials::new(server.username.clone(), password.to_owned()),
            )
            .await
            .map_err(|error| redact_error(&error, "Outgoing sign-in"))?;
        Ok(connection)
    })
    .await
    .map_err(|_| "Outgoing server timed out before sending.".to_string())?
}

#[cfg(test)]
fn add_test_imap_root(
    mut builder: tokio_native_tls::native_tls::TlsConnectorBuilder,
) -> Result<tokio_native_tls::native_tls::TlsConnectorBuilder, String> {
    if let Ok(path) = std::env::var("POSTAL_SNAP_MAIL_TEST_CA_CERT") {
        let pem = std::fs::read(path)
            .map_err(|_| "Incoming test certificate could not be read.".to_string())?;
        let certificate = tokio_native_tls::native_tls::Certificate::from_pem(&pem)
            .map_err(|_| "Incoming test certificate is invalid.".to_string())?;
        builder.add_root_certificate(certificate);
    }
    Ok(builder)
}

pub(crate) async fn test_smtp(
    server: &ServerConfig,
    email: &str,
    password: &str,
) -> Result<(), String> {
    test_smtp_auth(server, email, password, false).await
}

pub(crate) async fn test_smtp_auth(
    server: &ServerConfig,
    email: &str,
    password: &str,
    xoauth2: bool,
) -> Result<(), String> {
    let password = Zeroizing::new(password.to_string());
    if server.trusted_certificate.is_some() {
        let mut connection = connect_pinned_smtp(server, &password, xoauth2).await?;
        let connected = tokio::time::timeout(CONNECT_TIMEOUT, connection.test_connected())
            .await
            .map_err(|_| "Outgoing server timed out.".to_string())?;
        if !connected {
            return Err("The outgoing server declined the secure connection.".into());
        }
        let _: Mailbox = email
            .parse()
            .map_err(|_| "Enter a valid sender address.".to_string())?;
        return Ok(());
    }
    let transport = smtp_transport(server, &password, xoauth2)?;
    let connected = tokio::time::timeout(CONNECT_TIMEOUT, transport.test_connection())
        .await
        .map_err(|_| "Outgoing server timed out.".to_string())?
        .map_err(|error| crate::bridge::tls_error(&error, "Outgoing connection"))?;
    if !connected {
        return Err("The outgoing server declined the secure connection.".into());
    }
    let _: Mailbox = email
        .parse()
        .map_err(|_| "Enter a valid sender address.".to_string())?;
    Ok(())
}

/// Plain body: one text/plain part, format=flowed, no HTML alternative.
fn flowed_plain_part(draft: &ComposeDraft) -> SinglePart {
    SinglePart::builder()
        .header(
            ContentType::parse("text/plain; charset=utf-8; format=flowed")
                .expect("static MIME type is valid"),
        )
        .body(encode_flowed(&draft.text_body))
}

fn alternative_multipart(draft: &ComposeDraft) -> MultiPart {
    MultiPart::alternative()
        .singlepart(SinglePart::plain(draft.text_body.clone()))
        .singlepart(SinglePart::html(draft.html_body.clone()))
}

fn smtp_transport(
    server: &ServerConfig,
    password: &Zeroizing<String>,
    xoauth2: bool,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    if xoauth2 {
        guard_xoauth2_server(server, false)?;
    }
    let credentials = Credentials::new(server.username.clone(), password.as_str().to_owned());
    if server.trusted_certificate.is_some() {
        return Err("Bridge certificate connections require the verified pinned transport.".into());
    }
    #[cfg(test)]
    if let Ok(path) = std::env::var("POSTAL_SNAP_MAIL_TEST_CA_CERT") {
        use lettre::transport::smtp::client::{Certificate, Tls, TlsParameters};
        let pem = std::fs::read(path)
            .map_err(|_| "Outgoing test certificate could not be read.".to_string())?;
        let certificate = Certificate::from_pem(&pem)
            .map_err(|error| redact_error(&error, "Outgoing test certificate"))?;
        let parameters = TlsParameters::builder(server.host.clone())
            .add_root_certificate(certificate)
            .build()
            .map_err(|error| redact_error(&error, "Outgoing TLS setup"))?;
        let tls = match server.tls_mode {
            TlsMode::Tls => Tls::Wrapper(parameters),
            TlsMode::StartTls => Tls::Required(parameters),
        };
        let mut transport = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&server.host)
            .port(server.port)
            .tls(tls)
            .credentials(credentials)
            .timeout(Some(CONNECT_TIMEOUT));
        if xoauth2 {
            transport = transport.authentication(smtp_auth_mechanisms(true));
        }
        return Ok(transport.build());
    }
    let builder = match server.tls_mode {
        TlsMode::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&server.host),
        TlsMode::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&server.host),
    }
    .map_err(|error| redact_error(&error, "Outgoing TLS setup"))?;
    let mut transport = builder
        .port(server.port)
        .credentials(credentials)
        .timeout(Some(CONNECT_TIMEOUT));
    if xoauth2 {
        transport = transport.authentication(smtp_auth_mechanisms(true));
    }
    Ok(transport.build())
}

macro_rules! importance_header {
    ($ty:ident, $name:literal) => {
        #[derive(Clone, Debug)]
        struct $ty(&'static str);

        impl Header for $ty {
            fn name() -> HeaderName {
                HeaderName::new_from_ascii_str($name)
            }

            fn parse(_value: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
                Err("unused".into())
            }

            fn display(&self) -> HeaderValue {
                HeaderValue::new(Self::name(), self.0.to_string())
            }
        }
    };
}

importance_header!(ImportanceHeader, "Importance");
importance_header!(XPriorityHeader, "X-Priority");
importance_header!(PriorityHeader, "Priority");

#[derive(Clone, Debug)]
struct DispositionNotificationTo(String);

impl Header for DispositionNotificationTo {
    fn name() -> HeaderName {
        HeaderName::new_from_ascii_str("Disposition-Notification-To")
    }

    fn parse(_value: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Err("unused".into())
    }

    fn display(&self) -> HeaderValue {
        HeaderValue::new(Self::name(), self.0.clone())
    }
}

fn apply_read_receipt(
    builder: lettre::message::MessageBuilder,
    request: bool,
    sender: &str,
) -> lettre::message::MessageBuilder {
    if !request {
        return builder;
    }
    match crate::models::receipt_mailbox(sender) {
        Some(address) => builder.header(DispositionNotificationTo(address)),
        None => builder,
    }
}

fn apply_importance(
    builder: lettre::message::MessageBuilder,
    importance: &str,
) -> lettre::message::MessageBuilder {
    match crate::models::canonical_importance(importance) {
        "high" => builder
            .header(ImportanceHeader("high"))
            .header(XPriorityHeader("1"))
            .header(PriorityHeader("urgent")),
        "low" => builder
            .header(ImportanceHeader("low"))
            .header(XPriorityHeader("5"))
            .header(PriorityHeader("non-urgent")),
        _ => builder,
    }
}

fn safe_receipt_subject(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_control() || character.is_whitespace() {
                ' '
            } else {
                character
            }
        })
        .take(200)
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        "(no subject)".into()
    } else {
        cleaned
    }
}

fn safe_original_message_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() > 200
        || trimmed
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return None;
    }
    let inner = trimmed.trim_start_matches('<').trim_end_matches('>').trim();
    if inner.is_empty() || inner.contains('<') || inner.contains('>') || !inner.contains('@') {
        return None;
    }
    Some(format!("<{inner}>"))
}

/// A manual read receipt. The original letter is not included.
pub(crate) fn read_receipt_bytes(
    from: &str,
    to: &str,
    original_message_id: Option<&str>,
    subject: &str,
) -> Result<Vec<u8>, String> {
    let from = crate::models::receipt_mailbox(from)
        .ok_or_else(|| "The sender address is invalid.".to_string())?;
    let to = crate::models::receipt_mailbox(to)
        .ok_or_else(|| "This message did not ask for a read receipt.".to_string())?;
    let subject = safe_receipt_subject(subject);
    let header_subject = if subject.is_ascii() {
        format!("Read: {subject}")
    } else {
        "Read: message".to_string()
    };
    let message_id = format!("<{}@run.rosie.snap>", uuid::Uuid::new_v4());
    let boundary = format!("postal-receipt-{}", uuid::Uuid::new_v4().as_simple());
    let mut notice = format!("Reporting-UA: Postal Snap\r\nFinal-Recipient: rfc822; {from}\r\n");
    if let Some(original) = original_message_id.and_then(safe_original_message_id) {
        notice.push_str(&format!("Original-Message-ID: {original}\r\n"));
    }
    notice.push_str("Disposition: manual-action/MDN-sent-manually; displayed\r\n");
    let human = format!("This is a read receipt for \"{subject}\".\r\n");
    let message = format!(
        "From: {from}\r\nTo: {to}\r\nSubject: {header_subject}\r\nMessage-ID: {message_id}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=disposition-notification; boundary=\"{boundary}\"\r\n\r\n--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{human}\r\n--{boundary}\r\nContent-Type: message/disposition-notification\r\n\r\n{notice}\r\n--{boundary}--\r\n"
    );
    Ok(message.into_bytes())
}

#[cfg(test)]
pub(crate) async fn build_message(
    account: &AccountRecord,
    draft: &ComposeDraft,
) -> Result<Message, String> {
    let message_id = format!("<{}@run.rosie.snap>", uuid::Uuid::new_v4());
    build_message_with_id(account, draft, &message_id, false).await
}

async fn build_message_with_id(
    account: &AccountRecord,
    draft: &ComposeDraft,
    message_id: &str,
    keep_bcc: bool,
) -> Result<Message, String> {
    let plain = draft.body_format == BodyFormat::Plain;
    let mut outgoing = draft.clone();
    // A plain message never carries HTML.
    outgoing.html_body = if plain {
        String::new()
    } else {
        crate::html_sanitize::sanitize_compose_html_for_send(&draft.html_body)
    };
    let draft = &outgoing;
    if !keep_bcc && draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err("Add at least one recipient.".into());
    }
    if draft.html_body.len() + draft.text_body.len() > MAX_MESSAGE_BYTES {
        return Err("This message is too large to send.".into());
    }
    if draft.attachments.len() > MAX_ATTACHMENTS {
        return Err("This message has too many attachments.".into());
    }

    validate_compose_sender(
        draft.from.as_deref(),
        &account.summary.email,
        &account.summary.aliases,
    )?;
    let sender_email = draft
        .from
        .as_deref()
        .map(str::trim)
        .filter(|addr| !addr.is_empty())
        .unwrap_or(&account.summary.email);
    let from: Mailbox = format!("{} <{}>", account.summary.display_name, sender_email)
        .parse()
        .or_else(|_| sender_email.parse())
        .map_err(|_| "The sender address is invalid.".to_string())?;
    let mut builder = Message::builder()
        .from(from)
        .subject(draft.subject.clone())
        .message_id(Some(message_id.to_string()));
    let reply_to = draft
        .reply_to
        .as_deref()
        .unwrap_or(account.summary.reply_to.as_str())
        .trim();
    if !reply_to.is_empty() {
        let mailbox = reply_to
            .parse::<Mailbox>()
            .map_err(|_| "Enter one Reply-To address.".to_string())?;
        builder = builder.reply_to(mailbox);
    }
    for value in &draft.to {
        builder = builder.to(parse_mailbox(value)?);
    }
    for value in &draft.cc {
        builder = builder.cc(parse_mailbox(value)?);
    }
    for value in &draft.bcc {
        builder = builder.bcc(parse_mailbox(value)?);
    }
    if keep_bcc {
        builder = builder.keep_bcc();
    }
    if let Some(in_reply_to) = &draft.in_reply_to {
        builder = builder.in_reply_to(safe_thread_header(in_reply_to));
    }
    if let Some(references) = &draft.references {
        let references = references
            .iter()
            .map(|value| safe_thread_header(value))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !references.is_empty() {
            builder = builder.references(references);
        }
    }
    builder = apply_importance(builder, &draft.importance);
    builder = apply_read_receipt(builder, draft.request_receipt, sender_email);

    let mut inline_parts = Vec::new();
    let mut file_parts = Vec::new();
    let mut total_bytes = draft.html_body.len() + draft.text_body.len();
    for item in &draft.attachments {
        let path = Path::new(&item.token);
        let metadata = tokio::fs::symlink_metadata(path)
            .await
            .map_err(|_| "An attachment file is no longer available.".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("An attachment file is no longer available.".into());
        }
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|_| "Could not read an attachment file.".to_string())?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err("An attachment exceeds the maximum allowed size.".into());
        }
        // Base64 and MIME framing can inflate attachments by roughly a third;
        // the formatted-size check below is authoritative.
        total_bytes = total_bytes.saturating_add(bytes.len().saturating_mul(4) / 3);
        if total_bytes > MAX_OUTGOING_BYTES {
            return Err("The message and its attachments are too large to send safely.".into());
        }
        let content_type = item.content_type.clone().unwrap_or_else(|| {
            mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string()
        });
        let content_type = ContentType::parse(&content_type).unwrap_or_else(|_| {
            ContentType::parse("application/octet-stream").expect("static MIME type is valid")
        });
        let filename = safe_filename(&item.filename);
        // Plain text has no HTML to reference an inline image: send a file.
        if item.inline && !plain {
            inline_parts.push(
                LettreAttachment::new_inline(
                    item.content_id
                        .clone()
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                )
                .body(bytes, content_type),
            );
        } else {
            file_parts.push(LettreAttachment::new(filename).body(bytes, content_type));
        }
    }
    if plain {
        let text = flowed_plain_part(draft);
        return if file_parts.is_empty() {
            builder.singlepart(text)
        } else {
            let mut mixed = MultiPart::mixed().singlepart(text);
            for part in file_parts {
                mixed = mixed.singlepart(part);
            }
            builder.multipart(mixed)
        }
        .map_err(|error| redact_error(&error, "Message construction"));
    }
    let related = if inline_parts.is_empty() {
        None
    } else {
        let mut related = MultiPart::related().multipart(alternative_multipart(draft));
        for part in inline_parts {
            related = related.singlepart(part);
        }
        Some(related)
    };
    match (related, file_parts.is_empty()) {
        (None, true) => builder
            .multipart(alternative_multipart(draft))
            .map_err(|error| redact_error(&error, "Message construction")),
        (Some(related), true) => builder
            .multipart(related)
            .map_err(|error| redact_error(&error, "Message construction")),
        (related, false) => {
            let mut mixed = match related {
                Some(related) => MultiPart::mixed().multipart(related),
                None => MultiPart::mixed().multipart(alternative_multipart(draft)),
            };
            for part in file_parts {
                mixed = mixed.singlepart(part);
            }
            builder
                .multipart(mixed)
                .map_err(|error| redact_error(&error, "Message construction"))
        }
    }
}

pub(crate) fn message_envelope(
    account: &AccountRecord,
    draft: &ComposeDraft,
) -> Result<Envelope, String> {
    validate_compose_sender(
        draft.from.as_deref(),
        &account.summary.email,
        &account.summary.aliases,
    )?;
    let sender_email = draft
        .from
        .as_deref()
        .map(str::trim)
        .filter(|addr| !addr.is_empty())
        .unwrap_or(&account.summary.email);
    let from = sender_email
        .parse()
        .map_err(|_| "The sender address is invalid.".to_string())?;
    let recipients = draft
        .to
        .iter()
        .chain(&draft.cc)
        .chain(&draft.bcc)
        .map(|value| {
            value
                .parse::<Mailbox>()
                .map(|mailbox| mailbox.email)
                .map_err(|_| "One of the recipient addresses is invalid.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Envelope::new(Some(from), recipients)
        .map_err(|_| "The message envelope is invalid.".to_string())
}

fn safe_thread_header(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(998)
        .collect()
}

fn escape_signature_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// True when the app's own signature closes the text, or sits right above the
/// trailing quote. A signature earlier in the body does not count.
fn signature_present(text: &str, signature: &str) -> bool {
    let marked = format!("-- \n{signature}");
    let trimmed = text.trim_end();
    if trimmed.ends_with(&marked) {
        return true;
    }
    trailing_quote_start(trimmed).is_some_and(|index| {
        trimmed[..index]
            .trim_end_matches(['\r', '\n'])
            .ends_with(&marked)
    })
}

/// Index of the first line in a trailing run of `>` quotes.
fn trailing_quote_start(text: &str) -> Option<usize> {
    if text.is_empty() {
        return None;
    }
    let mut starts = vec![0usize];
    for (index, character) in text.char_indices() {
        if character == '\n' {
            starts.push(index + 1);
        }
    }
    let mut quote_at = None;
    for start in starts.into_iter().rev() {
        let mut line = &text[start..];
        if let Some(cut) = line.find('\n') {
            line = &line[..cut];
        }
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if quote_at.is_some() {
                break;
            }
            continue;
        }
        if line.starts_with('>') {
            quote_at = Some(start);
        } else if quote_at.is_some() {
            break;
        } else {
            return None;
        }
    }
    quote_at
}

fn insert_plain_signature(text: &str, signature: &str, above_quote: bool) -> String {
    let trimmed = text.trim_end();
    if above_quote {
        if let Some(index) = trailing_quote_start(trimmed) {
            let head = trimmed[..index].trim_end_matches(['\r', '\n']);
            let tail = &trimmed[index..];
            if head.is_empty() {
                format!("-- \n{signature}\n\n{tail}")
            } else {
                format!("{head}\n\n-- \n{signature}\n\n{tail}")
            }
        } else {
            format!("{trimmed}\n\n-- \n{signature}")
        }
    } else {
        format!("{trimmed}\n\n-- \n{signature}")
    }
}

/// Start of a `<blockquote>` that closes at the end of the document.
fn trailing_blockquote_open(html: &str) -> Option<usize> {
    let end = html.trim_end().len();
    if end == 0 {
        return None;
    }
    let lower = html[..end].to_ascii_lowercase();
    if !lower.ends_with("</blockquote>") {
        return None;
    }
    let bytes = lower.as_bytes();
    let mut stack = Vec::new();
    let mut last_open = None;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'<' && lower[index..].starts_with("<blockquote") {
            let after = index + "<blockquote".len();
            let boundary = bytes.get(after).copied();
            if boundary
                .is_none_or(|byte| byte.is_ascii_whitespace() || byte == b'>' || byte == b'/')
            {
                stack.push(index);
                index = after;
                continue;
            }
        } else if bytes[index] == b'<' && lower[index..].starts_with("</blockquote>") {
            if let Some(open) = stack.pop() {
                last_open = Some(open);
            }
            index += "</blockquote>".len();
            continue;
        }
        index += 1;
    }
    last_open
}

fn insert_html_signature(html: &str, signature_html: &str, above_quote: bool) -> String {
    if above_quote {
        if let Some(index) = trailing_blockquote_open(html) {
            let mut out = String::with_capacity(html.len() + signature_html.len());
            out.push_str(&html[..index]);
            out.push_str(signature_html);
            out.push_str(&html[index..]);
            out
        } else {
            format!("{html}{signature_html}")
        }
    } else {
        format!("{html}{signature_html}")
    }
}

/// Add the account signature once, with the conventional `-- ` marker.
/// When `above_quote` is set, a trailing reply or forward quote keeps the
/// signature above that quote. Otherwise the signature follows the message.
/// Retries reuse the queued draft, so a draft that already contains the
/// marker is left unchanged.
pub fn apply_signature(
    mut draft: ComposeDraft,
    signature: &str,
    above_quote: bool,
) -> ComposeDraft {
    let signature = signature.trim();
    if signature.is_empty() || signature_present(&draft.text_body, signature) {
        return draft;
    }
    let plain = draft.body_format == BodyFormat::Plain;
    draft.text_body = insert_plain_signature(&draft.text_body, signature, above_quote);
    if plain {
        return draft;
    }
    let html_lines = escape_signature_html(signature).replace('\n', "<br>");
    if draft.html_body.trim().is_empty() {
        draft.html_body = format!("<p>-- </p><p>{html_lines}</p>");
    } else {
        draft.html_body = insert_html_signature(
            &draft.html_body,
            &format!("<br><br>-- <br>{html_lines}"),
            above_quote,
        );
    }
    draft
}

#[cfg(test)]
mod plain_tests {
    use super::*;
    use crate::models::{
        AccountSummary, BodyFormat, ComposeAttachment, DraftSourceKind, ProviderKind, ServerConfig,
        TlsMode,
    };

    // Failure modes for plain-text sends:
    // 1. A plain draft still ships text/html or multipart/alternative.
    // 2. The plain part lacks charset=utf-8 or format=flowed.
    // 3. Draft html_body text leaks into the plain message.
    // 4. Attachments do not give multipart/mixed, or one goes missing.
    // 5. An inline image becomes multipart/related with no HTML to show it.
    // 6. The transfer encoding eats trailing soft-break spaces or "-- ".
    // 7. The signature touches html_body, or loses its "-- " marker.
    // 8. The signature is added twice on a retry.
    // 9. HTML drafts change shape (still alternative with both parts).
    // 10. The size limit is skipped for plain bodies.
    // 11. Remote-draft copies (keep_bcc) build HTML while sends build plain.

    fn account() -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                default_body_format: BodyFormat::Plain,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                reply_to: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam".into(),
            },
        }
    }

    fn draft(format: BodyFormat, text: &str) -> ComposeDraft {
        ComposeDraft {
            body_format: format,
            source_message_id: None,
            source_kind: None,
            include_signature: true,
            importance: String::new(),
            request_receipt: false,
            reply_to: None,
            id: None,
            account_id: "account-1".into(),
            from: None,
            to: vec!["jane@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Plain".into(),
            html_body: "<p>HTMLSECRET</p>".into(),
            text_body: text.into(),
            attachments: vec![],
            in_reply_to: None,
            references: None,
            send_at: None,
        }
    }

    async fn rendered(draft: &ComposeDraft) -> String {
        let bytes = build_message(&account(), draft).await.unwrap().formatted();
        String::from_utf8(bytes).unwrap()
    }

    fn attachment(dir: &tempfile::TempDir, name: &str, inline: bool) -> ComposeAttachment {
        let path = dir.path().join(name);
        std::fs::write(&path, b"file body").unwrap();
        ComposeAttachment {
            token: path.to_string_lossy().into(),
            filename: name.into(),
            content_type: Some("image/png".into()),
            inline,
            content_id: inline.then(|| "cid-1@inline".to_string()),
            size: None,
        }
    }

    #[tokio::test]
    async fn reply_to_is_included_only_when_the_account_has_one() {
        let mut account = account();
        account.summary.reply_to = "Ada <replies@example.com>".into();
        let bytes = build_message(&account, &draft(BodyFormat::Plain, "Hello"))
            .await
            .unwrap()
            .formatted();
        let out = String::from_utf8(bytes).unwrap();
        let lower = out.to_ascii_lowercase();
        assert_eq!(lower.matches("reply-to:").count(), 1);
        assert!(out.contains("replies@example.com"));
        let plain = rendered(&draft(BodyFormat::Plain, "Hello")).await;
        assert!(!plain.to_ascii_lowercase().contains("reply-to:"));

        let mut cleared = draft(BodyFormat::Plain, "Hello");
        cleared.reply_to = Some(String::new());
        account.summary.reply_to = "replies@example.com".into();
        let bytes = build_message(&account, &cleared).await.unwrap().formatted();
        let cleared_out = String::from_utf8(bytes).unwrap();
        assert!(!cleared_out.to_ascii_lowercase().contains("reply-to:"));

        let mut replaced = draft(BodyFormat::Plain, "Hello");
        replaced.reply_to = Some("other@example.com".into());
        let bytes = build_message(&account, &replaced)
            .await
            .unwrap()
            .formatted();
        let replaced_out = String::from_utf8(bytes).unwrap();
        assert!(replaced_out.contains("other@example.com"));
        assert!(!replaced_out.contains("replies@example.com"));
    }

    #[tokio::test]
    async fn invalid_draft_reply_to_is_an_error_not_dropped() {
        // Failure modes:
        // 1. The message builds without Reply-To (silent drop).
        // 2. The error text differs from the validation message.
        let mut bad = draft(BodyFormat::Plain, "Hello");
        bad.reply_to = Some("not an address".into());
        assert_eq!(
            build_message(&account(), &bad).await.err().as_deref(),
            Some("Enter one Reply-To address.")
        );
    }

    #[tokio::test]
    async fn plain_draft_is_one_flowed_text_part() {
        let out = rendered(&draft(BodyFormat::Plain, "Hello Jane")).await;
        assert!(out.contains("format=flowed"));
        assert!(out.to_ascii_lowercase().contains("charset=utf-8"));
        assert!(!out.contains("text/html"));
        assert!(!out.contains("multipart"));
        assert!(!out.contains("HTMLSECRET"));
        assert!(out.contains("Hello Jane"));
    }

    #[tokio::test]
    async fn plain_body_survives_transfer_encoding() {
        let long = "word ".repeat(40).trim_end().to_string();
        let text = format!("{long}\n\n-- \nSam\n> quoted");
        let out = rendered(&draft(BodyFormat::Plain, &text)).await;
        let parsed = mail_parser::MessageParser::default()
            .parse(out.as_bytes())
            .unwrap();
        let body = parsed.body_text(0).unwrap().replace("\r\n", "\n");
        let body = body.trim_end_matches('\n');
        assert_eq!(body, super::super::flowed::encode_flowed(&text));
        assert!(body.contains("\n-- \nSam\n"));
        assert!(body.lines().next().unwrap().ends_with(' '));
    }

    #[tokio::test]
    async fn plain_with_attachment_is_mixed_with_no_alternative() {
        let dir = tempfile::tempdir().unwrap();
        let mut plain = draft(BodyFormat::Plain, "See file");
        plain.attachments = vec![attachment(&dir, "a.png", false)];
        let out = rendered(&plain).await;
        assert!(out.contains("multipart/mixed"));
        assert!(!out.contains("multipart/alternative"));
        assert!(!out.contains("text/html"));
        assert!(out.contains("format=flowed"));
        assert!(out.contains("a.png"));
    }

    #[tokio::test]
    async fn plain_inline_image_travels_as_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut plain = draft(BodyFormat::Plain, "Look");
        plain.attachments = vec![attachment(&dir, "pic.png", true)];
        let out = rendered(&plain).await;
        assert!(!out.contains("multipart/related"));
        assert!(!out.to_ascii_lowercase().contains("content-id"));
        assert!(out.contains("multipart/mixed"));
        assert!(out.contains("pic.png"));
    }

    #[tokio::test]
    async fn html_draft_keeps_both_alternatives() {
        let out = rendered(&draft(BodyFormat::Html, "Hello")).await;
        assert!(out.contains("multipart/alternative"));
        assert!(out.contains("text/html"));
        assert!(!out.contains("format=flowed"));
    }

    #[tokio::test]
    async fn plain_bodies_obey_the_size_limit() {
        let huge = "x".repeat(MAX_MESSAGE_BYTES + 1);
        let error = build_message(&account(), &draft(BodyFormat::Plain, &huge))
            .await
            .unwrap_err();
        assert!(error.contains("too large"));
    }

    #[test]
    fn plain_signature_is_text_only_and_applied_once() {
        let plain = draft(BodyFormat::Plain, "Hello");
        let signed = apply_signature(plain.clone(), "Sam\nsam@example.com", true);
        assert_eq!(signed.text_body, "Hello\n\n-- \nSam\nsam@example.com");
        assert_eq!(signed.html_body, plain.html_body);
        let twice = apply_signature(signed.clone(), "Sam\nsam@example.com", true);
        assert_eq!(twice.text_body, signed.text_body);
    }

    #[test]
    fn signature_sits_above_a_trailing_quote() {
        let mut reply = draft(
            BodyFormat::Html,
            "Thanks\n\n> On Monday, Jane wrote:\n> Hello",
        );
        reply.html_body = "<p>Thanks</p><blockquote><p>Hello</p></blockquote>".into();
        let signed = apply_signature(reply, "Best,\nSam <sam>", true);
        assert_eq!(
            signed.text_body,
            "Thanks\n\n-- \nBest,\nSam <sam>\n\n> On Monday, Jane wrote:\n> Hello"
        );
        assert!(signed
            .html_body
            .contains("<p>Thanks</p><br><br>-- <br>Best,<br>Sam &lt;sam&gt;<blockquote>"));
        let twice = apply_signature(signed.clone(), "Best,\nSam <sam>", true);
        assert_eq!(twice.text_body, signed.text_body);
        assert_eq!(twice.html_body, signed.html_body);

        let mut note = draft(BodyFormat::Html, "Thanks\n\n> Hello\n\nPS");
        note.html_body = "<p>Thanks</p><blockquote><p>Hello</p></blockquote><p>PS</p>".into();
        let after = apply_signature(note, "Best", true);
        assert!(after.text_body.ends_with("PS\n\n-- \nBest"));
        assert!(after.html_body.ends_with("<p>PS</p><br><br>-- <br>Best"));
    }

    #[test]
    fn an_old_signature_in_the_body_does_not_block_a_new_one() {
        // Failure modes:
        // 1. A forward whose body holds an older signature gets none.
        // 2. A signature followed by more text counts as already applied.
        // 3. A retry after an above-quote signature signs again.
        // 4. A retry after a signature placed before a leading quote signs again.
        let sig = "Sam\nsam@example.com";
        let forward = "Hi\n\n-- \nSam\nsam@example.com\n\nFwd note\n\n> Original text";
        let signed = apply_signature(draft(BodyFormat::Plain, forward), sig, true);
        assert_eq!(
            signed.text_body,
            "Hi\n\n-- \nSam\nsam@example.com\n\nFwd note\n\n-- \nSam\nsam@example.com\n\n> Original text"
        );
        assert_eq!(
            apply_signature(signed.clone(), sig, true).text_body,
            signed.text_body
        );

        let below = apply_signature(
            draft(BodyFormat::Plain, "Hi\n\n-- \nSam\n\nMore text"),
            "Sam",
            false,
        );
        assert!(below.text_body.ends_with("More text\n\n-- \nSam"));
        assert_eq!(
            apply_signature(below.clone(), "Sam", false).text_body,
            below.text_body
        );

        let leading = apply_signature(draft(BodyFormat::Plain, "> quote\n> more"), "Sam", true);
        assert_eq!(leading.text_body, "-- \nSam\n\n> quote\n> more");
        assert_eq!(
            apply_signature(leading.clone(), "Sam", true).text_body,
            leading.text_body
        );
    }

    #[test]
    fn signature_can_follow_a_trailing_quote() {
        let mut reply = draft(
            BodyFormat::Html,
            "Thanks\n\n> On Monday, Jane wrote:\n> Hello",
        );
        reply.html_body = "<p>Thanks</p><blockquote><p>Hello</p></blockquote>".into();
        let signed = apply_signature(reply, "Best,\nSam <sam>", false);
        assert!(signed
            .text_body
            .ends_with("> Hello\n\n-- \nBest,\nSam <sam>"));
        assert!(signed
            .html_body
            .ends_with("</blockquote><br><br>-- <br>Best,<br>Sam &lt;sam&gt;"));
    }

    #[tokio::test]
    async fn remote_draft_copy_of_a_plain_draft_is_plain() {
        let bytes = prepare_draft_message(&account(), &draft(BodyFormat::Plain, "Hi"), "<d@x>")
            .await
            .unwrap();
        let out = String::from_utf8(bytes).unwrap();
        assert!(out.contains("format=flowed"));
        assert!(!out.contains("text/html"));
    }

    #[test]
    fn redirect_keeps_the_original_and_leaves_bcc_off_the_message() {
        let mut message = draft(BodyFormat::Html, "ignored");
        message.subject = "DO-NOT-SEND-SUBJECT".into();
        message.to = vec!["Jane Doe <jane@example.com>".into()];
        message.cc = vec!["cc@example.com".into()];
        message.bcc = vec!["hidden-bcc@example.com".into()];
        message.source_kind = Some(DraftSourceKind::Redirect);
        let raw = b"From: ada@example.com\r\nSubject: Picnic\r\n\r\nORIGINAL-BODY";
        let prepared = prepare_redirect(&account(), &message, raw).unwrap();
        let text = String::from_utf8(prepared.bytes.clone()).unwrap();
        assert!(text.starts_with("Resent-From:"));
        assert!(text.contains("sam@example.com"));
        assert!(text.contains(&format!("Resent-Message-ID: {}", prepared.message_id)));
        assert!(text.contains("Resent-To:"));
        assert!(text.contains("jane@example.com"));
        assert!(text.contains("Resent-Cc:"));
        assert!(text.contains("cc@example.com"));
        assert!(!text.contains("Resent-Bcc"));
        assert!(!text.contains("hidden-bcc@example.com"));
        assert!(!text.contains("DO-NOT-SEND-SUBJECT"));
        assert!(!text.contains("HTMLSECRET"));
        assert!(!text.contains("ignored"));
        assert!(prepared.bytes.ends_with(raw));
        assert_eq!(
            sent_copy_header(&prepared.message_id, &prepared.bytes),
            "Resent-Message-ID"
        );
        assert_eq!(
            sent_copy_header("<a@b>", b"Message-ID: <a@b>\r\n\r\nHi"),
            "Message-ID"
        );

        message.to.clear();
        message.cc.clear();
        let hidden = prepare_redirect(&account(), &message, raw).unwrap();
        let hidden_text = String::from_utf8(hidden.bytes).unwrap();
        assert!(!hidden_text.contains("Resent-To"));
        assert!(!hidden_text.contains("Resent-Cc"));
        assert!(!hidden_text.contains("hidden-bcc@example.com"));
        assert!(hidden_text.contains("Resent-From:"));

        message.bcc.clear();
        assert_eq!(
            prepare_redirect(&account(), &message, raw).err().as_deref(),
            Some("Add at least one recipient.")
        );
        message.to = vec!["jane@example.com\r\nBcc: hidden-bcc@example.com".into()];
        assert!(prepare_redirect(&account(), &message, raw).is_err());
        message.to = vec!["jane@example.com".into()];
        assert_eq!(
            prepare_redirect(&account(), &message, b"").err().as_deref(),
            Some("This message has not been downloaded yet.")
        );
    }

    #[test]
    fn redirect_removes_bcc_from_the_original_headers() {
        // Failure modes:
        // 1. A Bcc header in the original header block reaches the output.
        // 2. Mixed-case names (BCC :, bcc:) survive.
        // 3. Folded Bcc continuation lines survive.
        // 4. Bare LF headers are missed.
        // 5. A Bcc-looking line in the body is stripped.
        // 6. Other headers such as X-Bcc-Note are stripped.
        // 7. A header block with no end inside the bound is sent.
        let message = draft(BodyFormat::Plain, "ignored");
        let raw = b"From: ada@example.com\r\nBCC : leak1@example.com\r\nSubject: Picnic\r\nbcc: leak2@example.com,\r\n\tleak3@example.com\r\nX-Bcc-Note: keep\r\n\r\nBody line\r\nBcc: body-keep@example.com\r\n";
        let prepared = prepare_redirect(&account(), &message, raw).unwrap();
        let text = String::from_utf8(prepared.bytes.clone()).unwrap();
        let lower = text.to_ascii_lowercase();
        assert!(!lower.contains("leak1"));
        assert!(!lower.contains("leak2"));
        assert!(!lower.contains("leak3"));
        assert!(text.contains("X-Bcc-Note: keep\r\n"));
        assert!(text.contains("Subject: Picnic\r\nX-Bcc-Note: keep\r\n\r\n"));
        assert!(prepared
            .bytes
            .ends_with(b"\r\n\r\nBody line\r\nBcc: body-keep@example.com\r\n"));

        let lf = b"From: ada@example.com\nBcc: leak4@example.com\nSubject: Lf\n\nBody\n";
        let prepared = prepare_redirect(&account(), &message, lf).unwrap();
        let text = String::from_utf8(prepared.bytes.clone()).unwrap();
        assert!(!text.contains("leak4"));
        assert!(prepared.bytes.ends_with(b"Subject: Lf\n\nBody\n"));

        let mut huge = b"From: ada@example.com\r\n".to_vec();
        while huge.len() < 80 * 1024 {
            huge.extend_from_slice(b"X-Pad: 1\r\n");
        }
        huge.extend_from_slice(b"\r\nBody");
        assert!(prepare_redirect(&account(), &message, &huge).is_err());
    }

    #[tokio::test]
    async fn high_importance_uses_fixed_headers() {
        let mut message = draft(BodyFormat::Plain, "Hello");
        message.importance = "high".into();
        let high = rendered(&message).await;
        assert!(high.contains("Importance: high"));
        assert!(high.contains("X-Priority: 1"));
        assert!(high.contains("Priority: urgent"));
        message.importance = "low".into();
        let low = rendered(&message).await;
        assert!(low.contains("Importance: low"));
        assert!(low.contains("X-Priority: 5"));
        assert!(low.contains("Priority: non-urgent"));
        message.importance = "high\r\nBcc: evil@example.com".into();
        let rejected = rendered(&message).await;
        assert!(!rejected.to_ascii_lowercase().contains("importance:"));
        assert!(!rejected.to_ascii_lowercase().contains("evil@example.com"));
        message.importance = String::new();
        let normal = rendered(&message).await;
        assert!(!normal.to_ascii_lowercase().contains("importance:"));
    }

    #[tokio::test]
    async fn read_receipt_request_uses_the_account_address() {
        let mut message = draft(BodyFormat::Plain, "Hello");
        message.request_receipt = true;
        let asked = rendered(&message).await;
        assert!(asked.contains("Disposition-Notification-To: sam@example.com"));
        message.request_receipt = false;
        let plain = rendered(&message).await;
        assert!(!plain
            .to_ascii_lowercase()
            .contains("disposition-notification-to"));
    }

    #[test]
    fn read_receipt_omits_the_original_letter() {
        let bytes = read_receipt_bytes(
            "Sam@Example.com",
            "jane@example.com",
            Some("<note@example.com>"),
            "Picnic\r\nBcc: evil@example.com",
        )
        .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("From: sam@example.com"));
        assert!(text.contains("To: jane@example.com"));
        assert!(text.contains("Subject: Read: Picnic Bcc: evil@example.com"));
        assert!(text.contains("Original-Message-ID: <note@example.com>"));
        assert!(text.contains("Disposition: manual-action/MDN-sent-manually; displayed"));
        assert!(!text.contains("\r\nBcc:"));
        assert!(read_receipt_bytes("sam@example.com", "not-an-address", None, "Hi").is_err());
        let hidden = read_receipt_bytes(
            "sam@example.com",
            "jane@example.com",
            Some("note\r\nBcc: evil@example.com"),
            "Hi",
        )
        .unwrap();
        let hidden = String::from_utf8(hidden).unwrap();
        assert!(!hidden.contains("Original-Message-ID"));
        assert!(!hidden.contains("evil@example.com"));
    }

    #[test]
    fn xoauth2_sends_the_bearer_once() {
        let mut auth = Xoauth2Authenticator::new("sam@gmail.com", "token-1");
        let first = Authenticator::process(&mut auth, b"");
        assert_eq!(first, b"user=sam@gmail.com\x01auth=Bearer token-1\x01\x01");
        assert!(Authenticator::process(&mut auth, b"{\"status\":\"401\"}").is_empty());
        assert_eq!(smtp_auth_mechanisms(true), vec![Mechanism::Xoauth2]);
        assert_eq!(
            smtp_auth_mechanisms(false),
            vec![Mechanism::Plain, Mechanism::Login]
        );
    }
}
