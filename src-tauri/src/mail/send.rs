use std::path::Path;

use lettre::{
    address::Envelope,
    message::{
        header::ContentType, Attachment as LettreAttachment, Mailbox, MultiPart, SinglePart,
    },
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use tokio::net::TcpStream;
use zeroize::Zeroizing;

use super::parse::parse_mailbox;
use super::remote_drafts::search_message_id;
use super::{
    ImapSession, PreparedMessage, CONNECT_TIMEOUT, IMAP_COMMAND_TIMEOUT, MAX_ATTACHMENTS,
    MAX_MESSAGE_BYTES, MAX_OUTGOING_BYTES,
};
use crate::{
    models::{validate_compose_sender, AccountRecord, ComposeDraft, ServerConfig, TlsMode},
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

pub async fn send_prepared(
    account: &AccountRecord,
    password: &str,
    draft: &ComposeDraft,
    bytes: &[u8],
) -> Result<(), String> {
    let envelope = message_envelope(account, draft)?;
    let password = Zeroizing::new(password.to_string());
    let transport = smtp_transport(&account.smtp, &password)?;
    transport
        .send_raw(&envelope, bytes)
        .await
        .map_err(|error| redact_error(&error, "Send"))?;
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
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
        .await
        .map_err(|_| "Sent folder timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Sent folder"))?;
    let existing = search_message_id(&mut session, message_id, "Sent folder").await?;
    if existing.is_empty() {
        tokio::time::timeout(
            IMAP_COMMAND_TIMEOUT,
            session.append(mailbox, Some("(\\Seen)"), None, bytes),
        )
        .await
        .map_err(|_| "Saving the Sent copy timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Save Sent copy"))?;
        tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.select(mailbox))
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
    let native_connector = tokio_native_tls::native_tls::TlsConnector::builder();
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
                .map_err(|error| redact_error(&error, "Incoming TLS negotiation"))?;
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
            .map_err(|error| redact_error(&error, "Incoming STARTTLS"))?;
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
    let transport = smtp_transport(server, &password)?;
    let connected = tokio::time::timeout(CONNECT_TIMEOUT, transport.test_connection())
        .await
        .map_err(|_| "Outgoing server timed out.".to_string())?
        .map_err(|error| redact_error(&error, "Outgoing connection"))?;
    if !connected {
        return Err("The outgoing server declined the secure connection.".into());
    }
    let _: Mailbox = email
        .parse()
        .map_err(|_| "Enter a valid sender address.".to_string())?;
    Ok(())
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
    let mut outgoing = draft.clone();
    outgoing.html_body = crate::html_sanitize::sanitize_compose_html_for_send(&draft.html_body);
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
        if item.inline {
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
    let already_applied = draft.text_body.ends_with(&format!("\n\n-- \n{signature}"));
    if signature.is_empty() || already_applied {
        return draft;
    }
    draft.text_body = format!("{}\n\n-- \n{signature}", draft.text_body.trim_end());
    let html_lines = escape_signature_html(signature).replace('\n', "<br>");
    if draft.html_body.trim().is_empty() {
        draft.html_body = format!("<p>-- </p><p>{html_lines}</p>");
    } else {
        draft.html_body = format!("{}<br><br>-- <br>{html_lines}", draft.html_body);
    }
    draft
}
