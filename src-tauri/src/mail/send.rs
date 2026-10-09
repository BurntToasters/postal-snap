use std::{
    io,
    net::SocketAddr,
    path::Path,
    pin::Pin,
    task::{Context, Poll},
};

use lettre::{
    address::Envelope,
    message::{
        header::ContentType, Attachment as LettreAttachment, Mailbox, MultiPart, SinglePart,
    },
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
};
use zeroize::Zeroizing;

use super::flowed::encode_flowed;
use super::parse::parse_mailbox;
use super::remote_drafts::search_message_id;
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
    if account.smtp.trusted_certificate.is_some() {
        let mut connection = connect_pinned_smtp(&account.smtp, &password)
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
    let transport = smtp_transport(&account.smtp, &password).map_err(refused)?;
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
    let existing = search_message_id(&mut session, message_id, "Sent folder").await?;
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
        if search_message_id(&mut session, message_id, "Sent folder")
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
    // Only an explicit NO/BAD answer to LOGIN means the credentials were
    // rejected. Timeouts and dropped connections are transient and must not
    // park the account as "Sign-in failed".
    tokio::time::timeout(CONNECT_TIMEOUT, client.login(&server.username, password))
        .await
        .map_err(|_| "Incoming server timed out.".to_string())?
        .map_err(|(error, _)| match error {
            async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_) => {
                redact_error(&error, "Incoming sign-in")
            }
            _ => redact_error(&error, "Incoming connection"),
        })
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
) -> Result<lettre::transport::smtp::client::AsyncSmtpConnection, String> {
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        use lettre::transport::smtp::{
            authentication::Mechanism, client::AsyncSmtpConnection, extension::ClientId,
        };
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
                &[Mechanism::Plain, Mechanism::Login],
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
    let password = Zeroizing::new(password.to_string());
    if server.trusted_certificate.is_some() {
        let mut connection = connect_pinned_smtp(server, &password).await?;
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
    let transport = smtp_transport(server, &password)?;
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
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
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
        return Ok(
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&server.host)
                .port(server.port)
                .tls(tls)
                .credentials(credentials)
                .timeout(Some(CONNECT_TIMEOUT))
                .build(),
        );
    }
    let builder = match server.tls_mode {
        TlsMode::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&server.host),
        TlsMode::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&server.host),
    }
    .map_err(|error| redact_error(&error, "Outgoing TLS setup"))?;
    Ok(builder
        .port(server.port)
        .credentials(credentials)
        .timeout(Some(CONNECT_TIMEOUT))
        .build())
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

/// Append the account signature once, with the conventional `-- ` marker.
/// Retries reuse the queued draft, so the contains-check keeps it singular.
pub fn apply_signature(mut draft: ComposeDraft, signature: &str) -> ComposeDraft {
    let signature = signature.trim();
    let plain = draft.body_format == BodyFormat::Plain;
    let already_applied = draft.text_body.ends_with(&format!("\n\n-- \n{signature}"));
    if signature.is_empty() || already_applied {
        return draft;
    }
    draft.text_body = format!("{}\n\n-- \n{signature}", draft.text_body.trim_end());
    if plain {
        return draft;
    }
    let html_lines = escape_signature_html(signature).replace('\n', "<br>");
    if draft.html_body.trim().is_empty() {
        draft.html_body = format!("<p>-- </p><p>{html_lines}</p>");
    } else {
        draft.html_body = format!("{}<br><br>-- <br>{html_lines}", draft.html_body);
    }
    draft
}

#[cfg(test)]
mod plain_tests {
    use super::*;
    use crate::models::{
        AccountSummary, BodyFormat, ComposeAttachment, ProviderKind, ServerConfig, TlsMode,
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
        let signed = apply_signature(plain.clone(), "Sam\nsam@example.com");
        assert_eq!(signed.text_body, "Hello\n\n-- \nSam\nsam@example.com");
        assert_eq!(signed.html_body, plain.html_body);
        let twice = apply_signature(signed.clone(), "Sam\nsam@example.com");
        assert_eq!(twice.text_body, signed.text_body);
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
}
