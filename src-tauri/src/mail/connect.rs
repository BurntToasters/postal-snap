//! IMAP connection setup: TCP, implicit or required STARTTLS, optional
//! Bridge certificate pinning, then LOGIN or XOAUTH2.

use async_imap::Authenticator;
use tokio::net::TcpStream;
use zeroize::Zeroizing;

use super::failure::{login_failure_kind, FailureKind, MailError};
use super::send::{guard_xoauth2_server, verify_pinned_stream};
use super::watch::{classify_refusal, Refusal};
use super::{ImapSession, CONNECT_TIMEOUT, IMAP_COMMAND_TIMEOUT};
use crate::{
    models::{ServerConfig, TlsMode},
    security::redact_error,
};

/// A failed connection. `connection_limit` is set when the server refused the
/// greeting or login because of a connection cap, which is not a bad password.
#[derive(Debug)]
pub(crate) struct ConnectError {
    pub error: MailError,
    pub connection_limit: bool,
}

impl From<String> for ConnectError {
    fn from(message: String) -> Self {
        MailError::from(message).into()
    }
}

impl From<MailError> for ConnectError {
    fn from(error: MailError) -> Self {
        Self {
            error,
            connection_limit: false,
        }
    }
}

/// A server greeting that is BYE refuses the session before any login.
pub(crate) fn is_bye(response: &imap_proto::Response<'_>) -> bool {
    matches!(
        response,
        imap_proto::Response::Data {
            status: imap_proto::Status::Bye,
            ..
        }
    )
}

fn refused_greeting() -> ConnectError {
    ConnectError {
        error: MailError::connection("Incoming server refused the connection."),
        connection_limit: true,
    }
}

pub(crate) async fn connect_imap(
    server: &ServerConfig,
    password: &str,
) -> Result<ImapSession, MailError> {
    connect_imap_auth(server, password, false).await
}

pub(crate) async fn connect_imap_auth(
    server: &ServerConfig,
    password: &str,
    xoauth2: bool,
) -> Result<ImapSession, MailError> {
    connect_detailed(server, password, xoauth2)
        .await
        .map_err(|failure| failure.error)
}

pub(crate) async fn connect_detailed(
    server: &ServerConfig,
    password: &str,
    xoauth2: bool,
) -> Result<ImapSession, ConnectError> {
    if xoauth2 {
        guard_xoauth2_server(server, true)?;
    }
    let address = (server.host.as_str(), server.port);
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| MailError::connection("Incoming server timed out."))?
        .map_err(|error| MailError::connection(redact_error(&error, "Incoming connection")))?;
    let mut native_connector = tokio_native_tls::native_tls::TlsConnector::builder();
    if let Some(pem) = &server.trusted_certificate {
        crate::bridge::validate_loopback(&server.host)?;
        crate::bridge::certificate_metadata(pem)?;
        let certificate = tokio_native_tls::native_tls::Certificate::from_pem(pem.as_bytes())
            .map_err(|_| MailError::connection("The saved Bridge certificate is invalid."))?;
        native_connector.add_root_certificate(certificate);
    }
    #[cfg(test)]
    let native_connector = add_test_imap_root(native_connector)?;
    let native_connector = native_connector
        .build()
        .map_err(|error| MailError::connection(redact_error(&error, "Incoming TLS setup")))?;
    let connector = tokio_native_tls::TlsConnector::from(native_connector);
    let client = match server.tls_mode {
        TlsMode::Tls => {
            let tls = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(&server.host, tcp))
                .await
                .map_err(|_| MailError::connection("Incoming TLS negotiation timed out."))?
                .map_err(|error| {
                    MailError::connection(crate::bridge::tls_error(
                        &error,
                        "Incoming TLS negotiation",
                    ))
                })?;
            verify_pinned_stream(server, &tls)?;
            let mut client = async_imap::Client::new(tls);
            let greeting = tokio::time::timeout(CONNECT_TIMEOUT, client.read_response())
                .await
                .map_err(|_| MailError::connection("Incoming greeting timed out."))?
                .map_err(|error| MailError::connection(redact_error(&error, "Incoming greeting")))?
                .ok_or_else(|| {
                    MailError::connection("The incoming server closed the secure connection.")
                })?;
            if is_bye(greeting.parsed()) {
                return Err(refused_greeting());
            }
            client
        }
        TlsMode::StartTls => {
            let mut plain = async_imap::Client::new(tcp);
            let greeting = tokio::time::timeout(CONNECT_TIMEOUT, plain.read_response())
                .await
                .map_err(|_| MailError::connection("Incoming greeting timed out."))?
                .map_err(|error| MailError::connection(redact_error(&error, "Incoming greeting")))?
                .ok_or_else(|| {
                    MailError::connection("The incoming server closed the connection.")
                })?;
            if is_bye(greeting.parsed()) {
                return Err(refused_greeting());
            }
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                plain.run_command_and_check_ok("STARTTLS", None),
            )
            .await
            .map_err(|_| MailError::connection("Incoming STARTTLS timed out."))?
            .map_err(|error| {
                MailError::connection(redact_error(&error, "Required incoming STARTTLS"))
            })?;
            let tls = tokio::time::timeout(
                CONNECT_TIMEOUT,
                connector.connect(&server.host, plain.into_inner()),
            )
            .await
            .map_err(|_| MailError::connection("Incoming STARTTLS timed out."))?
            .map_err(|error| {
                MailError::connection(crate::bridge::tls_error(&error, "Incoming STARTTLS"))
            })?;
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
    let session = authenticated
        .map_err(|_| MailError::connection("Incoming server timed out."))?
        .map_err(|(error, _)| {
            // A cap is a transient refusal: it must not pause the account as
            // a rejected password.
            if classify_refusal(&error) == Refusal::ConnectionLimit {
                return ConnectError {
                    error: MailError::connection(redact_error(&error, "Incoming connection")),
                    connection_limit: true,
                };
            }
            match login_failure_kind(&error) {
                FailureKind::SignInRejected => ConnectError::from(MailError::new(
                    FailureKind::SignInRejected,
                    redact_error(&error, "Incoming sign-in"),
                )),
                kind => ConnectError::from(MailError::new(
                    kind,
                    redact_error(&error, "Incoming connection"),
                )),
            }
        })?;
    Ok(session)
}

pub(super) struct Xoauth2Authenticator {
    initial: Zeroizing<Vec<u8>>,
    sent: bool,
}

impl Xoauth2Authenticator {
    pub(super) fn new(username: &str, access_token: &str) -> Self {
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

/// RFC 2971 identification. Only the product name is sent: no version, OS,
/// host, or account details.
pub(super) fn client_id_payload() -> [(&'static str, Option<&'static str>); 1] {
    [("name", Some("Postal Snap"))]
}

/// Identify once per new connection. The reply is discarded and a NO or BAD
/// never fails the connection. A timeout or socket error does, because the
/// protocol state is then unknown.
pub(super) async fn send_client_id(session: &mut ImapSession) -> Result<(), MailError> {
    match tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.id(client_id_payload())).await {
        Err(_) => Err(MailError::connection("Incoming server timed out.")),
        Ok(Ok(_reply)) => Ok(()),
        Ok(Err(async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_))) => Ok(()),
        Ok(Err(error)) => Err(MailError::connection(redact_error(
            &error,
            "Incoming identification",
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::client_id_payload;

    #[test]
    fn id_payload_names_the_product_and_nothing_else() {
        assert_eq!(client_id_payload(), [("name", Some("Postal Snap"))]);
    }
}
