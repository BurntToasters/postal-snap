//! Gmail and Outlook OAuth: PKCE, loopback callback, refresh vault, XOAUTH2.
//!
//! Setup UI does not offer this yet. `connect_oauth_account` is the hidden
//! entry. Redirects stay on `http://127.0.0.1`; never register
//! `run.rosie.snap://oauth/callback`.
//!
//! Secrets leave this module only as [`zeroize::Zeroizing`] strings.
//! Client IDs come from the build (`POSTAL_SNAP_GMAIL_CLIENT_ID`,
//! `POSTAL_SNAP_OUTLOOK_CLIENT_ID`), never from a hardcoded secret.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, SystemTime},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use zeroize::{Zeroize, Zeroizing};

use crate::models::{AccountRecord, ProviderKind, TlsMode};

const TOKEN_TIMEOUT: Duration = Duration::from_secs(20);
const SIGN_IN_WAIT: Duration = Duration::from_secs(180);
const CALLBACK_READ: Duration = Duration::from_secs(5);

/// OAuth-capable provider. Distinct from [`crate::models::ProviderKind`]
/// until a setup flow can create such accounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OAuthProvider {
    Gmail,
    Outlook,
}

impl OAuthProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Gmail => "gmail",
            Self::Outlook => "outlook",
        }
    }

    pub fn authorization_endpoint(&self) -> &'static str {
        match self {
            Self::Gmail => "https://accounts.google.com/o/oauth2/v2/auth",
            Self::Outlook => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        }
    }

    pub fn token_endpoint(&self) -> &'static str {
        match self {
            Self::Gmail => "https://oauth2.googleapis.com/token",
            Self::Outlook => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        }
    }

    pub fn scopes(&self) -> &'static [&'static str] {
        match self {
            Self::Gmail => &["openid", "email", "https://mail.google.com/"],
            Self::Outlook => &[
                "openid",
                "email",
                "offline_access",
                "https://outlook.office.com/IMAP.AccessAsUser.All",
                "https://outlook.office.com/SMTP.Send",
            ],
        }
    }

    pub fn imap_host(&self) -> &'static str {
        match self {
            Self::Gmail => "imap.gmail.com",
            Self::Outlook => "outlook.office365.com",
        }
    }

    pub fn smtp_host(&self) -> &'static str {
        match self {
            Self::Gmail => "smtp.gmail.com",
            Self::Outlook => "smtp.office365.com",
        }
    }

    pub fn imap_port(&self) -> u16 {
        993
    }

    pub fn smtp_port(&self) -> u16 {
        587
    }

    pub fn smtp_tls_mode(&self) -> TlsMode {
        TlsMode::StartTls
    }

    pub fn from_provider_kind(kind: &ProviderKind) -> Option<Self> {
        match kind {
            ProviderKind::Gmail => Some(Self::Gmail),
            ProviderKind::Outlook => Some(Self::Outlook),
            ProviderKind::Icloud | ProviderKind::Manual | ProviderKind::ProtonBridge => None,
        }
    }

    /// Loopback redirect. Never `run.rosie.snap://oauth/callback`.
    pub fn redirect_uri(custom: Option<&str>) -> &str {
        custom.unwrap_or("http://127.0.0.1/")
    }
}

/// PKCE S256 challenge for an authorization request.
pub fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier))
}

/// Authorization URL for the system browser. The caller generates a random
/// `state` and `code_verifier`, keeps both, and matches them on callback.
pub fn authorization_url(
    provider: OAuthProvider,
    client_id: &str,
    state: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<url::Url, String> {
    let mut url = url::Url::parse(provider.authorization_endpoint())
        .map_err(|_| "The sign-in service address is invalid.".to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &provider.scopes().join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", &pkce_challenge(code_verifier))
        .append_pair("code_challenge_method", "S256");
    match provider {
        // Google omits the refresh token unless access is offline and the
        // consent screen runs.
        OAuthProvider::Gmail => {
            url.query_pairs_mut()
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
        }
        OAuthProvider::Outlook => {
            url.query_pairs_mut()
                .append_pair("prompt", "select_account");
        }
    }
    Ok(url)
}

/// Public client id baked into a release build, or overridden in the environment.
pub fn configured_client_id(provider: OAuthProvider) -> Result<String, String> {
    let (key, compiled) = match provider {
        OAuthProvider::Gmail => (
            "POSTAL_SNAP_GMAIL_CLIENT_ID",
            option_env!("POSTAL_SNAP_GMAIL_CLIENT_ID"),
        ),
        OAuthProvider::Outlook => (
            "POSTAL_SNAP_OUTLOOK_CLIENT_ID",
            option_env!("POSTAL_SNAP_OUTLOOK_CLIENT_ID"),
        ),
    };
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            compiled
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| match provider {
            OAuthProvider::Gmail => "Gmail sign-in is not configured for this build.".into(),
            OAuthProvider::Outlook => "Outlook sign-in is not configured for this build.".into(),
        })
}

pub fn parse_oauth_provider(value: &str) -> Result<OAuthProvider, String> {
    match value {
        "gmail" => Ok(OAuthProvider::Gmail),
        "outlook" => Ok(OAuthProvider::Outlook),
        _ => Err("Choose Gmail or Outlook.".into()),
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredOAuthTokens {
    pub provider: String,
    pub refresh_token: String,
    pub access_token: Option<String>,
    /// Unix seconds when `access_token` expires, if known.
    pub access_expires_at: Option<u64>,
}

impl StoredOAuthTokens {
    pub fn access_valid_now(&self) -> bool {
        match (self.access_token.as_ref(), self.access_expires_at) {
            (Some(_), Some(expires_at)) => SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|now| now.as_secs().saturating_add(60) < expires_at)
                .unwrap_or(false),
            _ => false,
        }
    }
}

/// Exchange an authorization code for tokens. Network errors stay generic;
/// the raw response body is never surfaced.
pub async fn exchange_code(
    provider: OAuthProvider,
    client_id: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TOKEN_TIMEOUT)
        .build()
        .map_err(|_| "Could not reach the sign-in service.".to_string())?;
    let response = client
        .post(provider.token_endpoint())
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|_| "Could not reach the sign-in service.".to_string())?;
    if !response.status().is_success() {
        return Err("Sign-in was not completed.".to_string());
    }
    let body = response
        .text()
        .await
        .map_err(|_| "The sign-in service returned an unreadable reply.".to_string())?;
    serde_json::from_str::<TokenResponse>(&body)
        .map_err(|_| "The sign-in service returned an unreadable reply.".to_string())
}

/// Refresh an access token with a stored refresh token.
pub async fn refresh_access_token(
    provider: OAuthProvider,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TOKEN_TIMEOUT)
        .build()
        .map_err(|_| "Could not reach the sign-in service.".to_string())?;
    let response = client
        .post(provider.token_endpoint())
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|_| "Could not reach the sign-in service.".to_string())?;
    if !response.status().is_success() {
        return Err("The saved sign-in expired. Sign in again.".to_string());
    }
    let body = response
        .text()
        .await
        .map_err(|_| "The sign-in service returned an unreadable reply.".to_string())?;
    serde_json::from_str::<TokenResponse>(&body)
        .map_err(|_| "The sign-in service returned an unreadable reply.".to_string())
}

/// SASL XOAUTH2 initial client response, base64-encoded.
pub fn xoauth2_initial_response(username: &str, access_token: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!(
        "user={username}\x01auth=Bearer {access_token}\x01\x01"
    ))
}

fn oauth_entry(account_id: &str) -> Result<keyring::Entry, String> {
    let id = uuid::Uuid::parse_str(account_id)
        .map_err(|_| "The account sign-in store is invalid.".to_string())?;
    keyring::Entry::new(
        "Postal Snap OAuth",
        &format!("oauth-refresh:{}", id.hyphenated()),
    )
    .map_err(|_| "The account sign-in store is unavailable.".to_string())
}

/// Persist OAuth tokens in the native vault, separate from passwords.
pub fn store_tokens(account_id: &str, tokens: &StoredOAuthTokens) -> Result<(), String> {
    let mut raw = serde_json::to_string(tokens)
        .map_err(|_| "Could not save the account sign-in.".to_string())?;
    let result = oauth_entry(account_id)?
        .set_password(&raw)
        .map_err(|_| "Could not save the account sign-in.".to_string());
    raw.zeroize();
    result
}

/// Load OAuth tokens. The refresh token stays wrapped for zeroization.
pub fn load_tokens(account_id: &str) -> Result<StoredOAuthTokens, String> {
    let raw = Zeroizing::new(
        oauth_entry(account_id)?
            .get_password()
            .map_err(|_| "The account sign-in is missing.".to_string())?,
    );
    serde_json::from_str(&raw).map_err(|_| "The account sign-in is damaged.".to_string())
}

pub fn remove_tokens(account_id: &str) -> Result<(), String> {
    match oauth_entry(account_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the account sign-in.".to_string()),
    }
}

/// Password vault for password accounts, refreshed access token for OAuth.
pub async fn session_secret(account: &AccountRecord) -> Result<Zeroizing<String>, String> {
    if account.summary.auth_method == "oauth" {
        fresh_access_token(&account.summary.id).await
    } else {
        crate::credentials::load(&account.summary.id)
    }
}

pub fn uses_xoauth2(account: &AccountRecord) -> bool {
    account.summary.auth_method == "oauth"
}

type RefreshLocks = Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

static REFRESH_LOCKS: LazyLock<RefreshLocks> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// One refresh at a time per account. Rotated refresh tokens must not race.
fn refresh_lock(account_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = REFRESH_LOCKS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    locks
        .entry(account_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn usable_access_token(stored: &StoredOAuthTokens) -> Option<Zeroizing<String>> {
    stored
        .access_token
        .clone()
        .filter(|_| stored.access_valid_now())
        .map(Zeroizing::new)
}

/// Bearer token for an OAuth account. Refreshes when the saved one is stale.
pub async fn fresh_access_token(account_id: &str) -> Result<Zeroizing<String>, String> {
    if let Some(access) = usable_access_token(&load_tokens(account_id)?) {
        return Ok(access);
    }
    let lock = refresh_lock(account_id);
    let _guard = lock.lock().await;
    // Another caller may have refreshed while this one waited.
    let mut stored = load_tokens(account_id)?;
    if let Some(access) = usable_access_token(&stored) {
        return Ok(access);
    }
    let provider = parse_oauth_provider(&stored.provider)?;
    let client_id = configured_client_id(provider)?;
    let refreshed = refresh_access_token(provider, &client_id, &stored.refresh_token).await?;
    let access = Zeroizing::new(refreshed.access_token);
    if let Some(refresh) = refreshed.refresh_token {
        stored.refresh_token = refresh;
    }
    stored.access_token = Some(access.to_string());
    stored.access_expires_at = expiry_unix(refreshed.expires_in);
    store_tokens(account_id, &stored)?;
    Ok(access)
}

fn expiry_unix(expires_in: Option<u64>) -> Option<u64> {
    let seconds = expires_in?;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|now| now.as_secs().saturating_add(seconds))
}

/// Email and display name from an ID token we just received over TLS.
///
/// Claim order: `email` first, then `preferred_username`, then `upn`. The
/// fallbacks only apply when a provider omits `email`.
pub fn identity_from_id_token(id_token: &str) -> Result<(String, String), String> {
    let payload = id_token
        .split('.')
        .nth(1)
        .ok_or("The sign-in service did not share an email address.")?;
    if payload.len() > 8192 {
        return Err("The sign-in service did not share an email address.".into());
    }
    let bytes = decode_jwt_segment(payload)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The sign-in service did not share an email address.".to_string())?;
    let email = ["email", "preferred_username", "upn"]
        .into_iter()
        .find_map(|key| {
            value
                .get(key)
                .and_then(|item| item.as_str())
                .map(str::trim)
                .filter(|item| {
                    item.contains('@') && item.len() <= 320 && !item.chars().any(char::is_control)
                })
        })
        .ok_or_else(|| "The sign-in service did not share an email address.".to_string())?
        .to_lowercase();
    let name = value
        .get("name")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim();
    let name = if name.chars().count() > 200 || name.chars().any(char::is_control) {
        String::new()
    } else {
        name.to_string()
    };
    Ok((email, name))
}

fn decode_jwt_segment(segment: &str) -> Result<Vec<u8>, String> {
    let mut padded = segment.to_string();
    while !padded.len().is_multiple_of(4) {
        padded.push('=');
    }
    base64::engine::general_purpose::URL_SAFE
        .decode(padded)
        .map_err(|_| "The sign-in service did not share an email address.".to_string())
}

/// In-flight browser sign-in. Holds the PKCE verifier until the callback.
pub struct PendingSignIn {
    pub authorization_url: String,
    provider: OAuthProvider,
    client_id: String,
    redirect_uri: String,
    state: String,
    verifier: Zeroizing<String>,
    listener: TcpListener,
}

pub async fn begin_sign_in(provider: OAuthProvider) -> Result<PendingSignIn, String> {
    let client_id = configured_client_id(provider)?;
    let port = loopback_port()?;
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|_| "Postal Snap could not listen for the sign-in reply.".to_string())?;
    let bound = listener
        .local_addr()
        .map_err(|_| "Postal Snap could not listen for the sign-in reply.".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{bound}/oauth/callback");
    let state = random_url_token();
    let verifier = Zeroizing::new(random_url_token());
    let authorization_url =
        authorization_url(provider, &client_id, &state, &verifier, &redirect_uri)?.to_string();
    if authorization_url.contains("run.rosie.snap") {
        return Err("The sign-in address is invalid.".into());
    }
    Ok(PendingSignIn {
        authorization_url,
        provider,
        client_id,
        redirect_uri,
        state,
        verifier,
        listener,
    })
}

pub struct SignedInAccount {
    pub email: String,
    pub display_name: String,
    pub tokens: StoredOAuthTokens,
    pub access_token: Zeroizing<String>,
}

pub async fn finish_sign_in(pending: PendingSignIn) -> Result<SignedInAccount, String> {
    let PendingSignIn {
        provider,
        client_id,
        redirect_uri,
        state,
        verifier,
        listener,
        authorization_url: _,
    } = pending;
    let code = accept_authorization_code(listener, &state).await?;
    let mut response = exchange_code(provider, &client_id, &code, &verifier, &redirect_uri).await?;
    let id_token = response
        .id_token
        .take()
        .ok_or_else(|| "The sign-in service did not share an email address.".to_string())?;
    let (email, display_name) = identity_from_id_token(&id_token)?;
    let (tokens, access_token) = tokens_from_response(provider, response)?;
    Ok(SignedInAccount {
        email,
        display_name,
        tokens,
        access_token,
    })
}

fn tokens_from_response(
    provider: OAuthProvider,
    mut response: TokenResponse,
) -> Result<(StoredOAuthTokens, Zeroizing<String>), String> {
    let refresh = response
        .refresh_token
        .take()
        .ok_or_else(|| "Sign-in did not grant ongoing access. Sign in again.".to_string())?;
    let access = Zeroizing::new(std::mem::take(&mut response.access_token));
    if access.is_empty() {
        return Err("Sign-in was not completed.".into());
    }
    response.access_token.zeroize();
    let stored = StoredOAuthTokens {
        provider: provider.as_str().into(),
        refresh_token: refresh,
        access_token: Some(access.to_string()),
        access_expires_at: expiry_unix(response.expires_in),
    };
    Ok((stored, access))
}

fn loopback_port() -> Result<u16, String> {
    match std::env::var("POSTAL_SNAP_OAUTH_LOOPBACK_PORT") {
        Err(_) => Ok(0),
        Ok(value) if value.trim().is_empty() => Ok(0),
        Ok(value) => {
            let port = value
                .trim()
                .parse::<u16>()
                .map_err(|_| "The sign-in port setting is invalid.".to_string())?;
            if port == 0 {
                Err("The sign-in port setting is invalid.".into())
            } else {
                Ok(port)
            }
        }
    }
}

fn random_url_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub(crate) async fn accept_authorization_code(
    listener: TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    let wait = async {
        loop {
            let (mut socket, peer) = listener
                .accept()
                .await
                .map_err(|_| "The sign-in window closed before it finished.".to_string())?;
            if !is_loopback_peer(peer) {
                continue;
            }
            let request = match read_http_head(&mut socket).await {
                Ok(request) => request,
                Err(_) => continue,
            };
            match callback_query(&request) {
                CallbackQuery::Ignore => {
                    let _ = socket
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                }
                CallbackQuery::Finished { code, state } => {
                    // A wrong state is most likely a stray local request: keep waiting.
                    let matches = states_match(&state, expected_state)
                        && !code.is_empty()
                        && code.len() <= 2048;
                    let _ = write_oauth_page(&mut socket, matches).await;
                    if matches {
                        return Ok(code);
                    }
                }
                CallbackQuery::Denied { state } => {
                    let matches = state
                        .as_deref()
                        .is_some_and(|s| states_match(s, expected_state));
                    let _ = write_oauth_page(&mut socket, false).await;
                    if matches {
                        return Err("Sign-in was canceled.".into());
                    }
                }
                CallbackQuery::Invalid => {
                    let _ = write_oauth_page(&mut socket, false).await;
                }
            }
        }
    };
    tokio::time::timeout(SIGN_IN_WAIT, wait)
        .await
        .map_err(|_| "Sign-in timed out. Try again.".to_string())?
}

fn is_loopback_peer(peer: SocketAddr) -> bool {
    match peer.ip() {
        std::net::IpAddr::V4(ip) => ip.is_loopback(),
        std::net::IpAddr::V6(_) => false,
    }
}

async fn read_http_head(socket: &mut TcpStream) -> Result<String, String> {
    let mut buf = [0u8; 8192];
    let mut filled = 0usize;
    let read = async {
        loop {
            if filled >= buf.len() {
                return Err("The sign-in reply was too large.".to_string());
            }
            let n = socket
                .read(&mut buf[filled..])
                .await
                .map_err(|_| "The sign-in reply could not be read.".to_string())?;
            if n == 0 {
                break;
            }
            filled += n;
            if buf[..filled].windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8(buf[..filled].to_vec())
            .map_err(|_| "The sign-in reply could not be read.".to_string())
    };
    tokio::time::timeout(CALLBACK_READ, read)
        .await
        .map_err(|_| "The sign-in reply could not be read.".to_string())?
}

enum CallbackQuery {
    Ignore,
    Finished { code: String, state: String },
    Denied { state: Option<String> },
    Invalid,
}

/// Compares states without an early exit on the first differing byte.
fn states_match(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    actual
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn callback_query(request: &str) -> CallbackQuery {
    let mut lines = request.lines();
    let Some(start) = lines.next() else {
        return CallbackQuery::Invalid;
    };
    let mut parts = start.split_whitespace();
    if parts.next() != Some("GET") {
        return CallbackQuery::Invalid;
    }
    let Some(target) = parts.next() else {
        return CallbackQuery::Invalid;
    };
    let path = target.split('?').next().unwrap_or(target);
    if path.starts_with("/favicon") {
        return CallbackQuery::Ignore;
    }
    if path != "/oauth/callback" {
        return CallbackQuery::Invalid;
    }
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
        return CallbackQuery::Invalid;
    };
    let mut code = None;
    let mut state = None;
    let mut error = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if value.len() <= 2048 => code = Some(value.into_owned()),
            "state" if value.len() <= 256 => state = Some(value.into_owned()),
            "error" => error = true,
            _ => {}
        }
    }
    if error {
        return CallbackQuery::Denied { state };
    }
    match (code, state) {
        (Some(code), Some(state)) if !code.is_empty() && !state.is_empty() => {
            CallbackQuery::Finished { code, state }
        }
        _ => CallbackQuery::Invalid,
    }
}

async fn write_oauth_page(socket: &mut TcpStream, ok: bool) -> Result<(), String> {
    let body = if ok {
        "Sign-in finished. You can close this window and return to Postal Snap."
    } else {
        "Sign-in did not finish. You can close this window and return to Postal Snap."
    };
    let page = format!(
        "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Postal Snap</title></head><body><p>{body}</p></body></html>"
    );
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{page}",
        page.len()
    );
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|_| "The sign-in window could not be closed.".to_string())
}

/// XOAUTH2 only to the provider's own IMAP or SMTP host, on its real port.
pub fn allow_xoauth2_server(host: &str, port: u16, incoming: bool) -> Result<(), String> {
    let allowed = if incoming {
        (host == "imap.gmail.com" && port == 993)
            || (host == "outlook.office365.com" && port == 993)
    } else {
        (host == "smtp.gmail.com" && port == 587) || (host == "smtp.office365.com" && port == 587)
    };
    if allowed {
        Ok(())
    } else {
        Err("This sign-in only works with the provider's mail servers.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure modes for the loopback callback:
    // 1. A wrong-state callback aborts sign-in, so any local page can cancel it.
    // 2. A wrong-state callback with a code is accepted.
    // 3. A denied callback with a wrong state aborts sign-in.
    // 4. A denied callback with the right state does not abort.
    // 5. An invalid request aborts sign-in instead of waiting for the real callback.
    // 6. The state check stops at the first differing byte or accepts a prefix.
    // 7. Unequal-length states compare equal.
    // 8. The email claim loses to preferred_username, or the fallbacks are skipped.

    #[test]
    fn refresh_lock_is_shared_per_account_only() {
        // Failure modes:
        // 1. Each call gets a new lock, so refreshes do not serialize.
        // 2. Two accounts share one lock.
        // 3. A poisoned map panics instead of recovering.
        let first = refresh_lock("account-a");
        let again = refresh_lock("account-a");
        let other = refresh_lock("account-b");
        assert!(Arc::ptr_eq(&first, &again));
        assert!(!Arc::ptr_eq(&first, &other));
    }

    #[test]
    fn authorization_urls_carry_pkce_and_scopes() {
        let url = authorization_url(
            OAuthProvider::Gmail,
            "client-1",
            "state-1",
            "verifier-1",
            OAuthProvider::redirect_uri(None),
        )
        .unwrap()
        .to_string();
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(url.contains("mail.google.com"));
        assert!(url.contains("127.0.0.1"));
        assert!(!url.contains("run.rosie.snap"));
        assert!(!url.contains("verifier-1"));

        let outlook = authorization_url(
            OAuthProvider::Outlook,
            "client-2",
            "state-2",
            "verifier-2",
            OAuthProvider::redirect_uri(None),
        )
        .unwrap()
        .to_string();
        assert!(outlook.contains("IMAP.AccessAsUser.All"));
        assert!(outlook.contains("prompt=select_account"));
    }

    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        // RFC 7636 appendix B verifier.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn xoauth2_response_decodes_to_sasl_format() {
        let encoded = xoauth2_initial_response("sam@gmail.com", "token-1");
        let raw = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(raw, b"user=sam@gmail.com\x01auth=Bearer token-1\x01\x01");
    }

    #[test]
    fn access_validity_requires_fresh_expiry() {
        let fresh = StoredOAuthTokens {
            provider: "gmail".into(),
            refresh_token: "refresh".into(),
            access_token: Some("access".into()),
            access_expires_at: Some(9_999_999_999),
        };
        assert!(fresh.access_valid_now());
        let stale = StoredOAuthTokens {
            access_expires_at: Some(1),
            ..fresh.clone()
        };
        assert!(!stale.access_valid_now());
        let unknown = StoredOAuthTokens {
            access_expires_at: None,
            ..fresh
        };
        assert!(!unknown.access_valid_now());
    }

    #[test]
    fn callback_keeps_code_and_rejects_a_mismatch() {
        let ok = callback_query(
            "GET /oauth/callback?code=abc&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        );
        match ok {
            CallbackQuery::Finished { code, state } => {
                assert_eq!(code, "abc");
                assert_eq!(state, "state-1");
            }
            _ => panic!("expected a code"),
        }
        assert!(matches!(
            callback_query("GET /favicon.ico HTTP/1.1\r\n\r\n"),
            CallbackQuery::Ignore
        ));
        assert!(matches!(
            callback_query(
                "GET /oauth/callback?error=access_denied&state=state-1 HTTP/1.1\r\n\r\n"
            ),
            CallbackQuery::Denied { state: Some(ref s) } if s == "state-1"
        ));
        assert!(matches!(
            callback_query("GET / HTTP/1.1\r\n\r\n"),
            CallbackQuery::Invalid
        ));
        assert!(allow_xoauth2_server("evil.example", 993, true).is_err());
        assert!(allow_xoauth2_server("imap.gmail.com", 993, true).is_ok());
        assert!(allow_xoauth2_server("smtp.office365.com", 587, false).is_ok());
        assert!(allow_xoauth2_server("imap.gmail.com", 143, true).is_err());
        assert!(allow_xoauth2_server("smtp.gmail.com", 587, true).is_err());
    }

    #[test]
    fn id_token_email_and_name() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"email":"Sam@gmail.com","name":"Sam"}"#);
        let token = format!("aaa.{payload}.sig");
        let (email, name) = identity_from_id_token(&token).unwrap();
        assert_eq!(email, "sam@gmail.com");
        assert_eq!(name, "Sam");
    }

    #[test]
    fn missing_client_id_is_a_build_error() {
        if option_env!("POSTAL_SNAP_GMAIL_CLIENT_ID").is_some()
            || std::env::var("POSTAL_SNAP_GMAIL_CLIENT_ID")
                .ok()
                .is_some_and(|value| !value.trim().is_empty())
        {
            return;
        }
        assert_eq!(configured_client_id(OAuthProvider::Gmail).ok(), None);
    }

    #[tokio::test]
    async fn loopback_returns_the_code_and_hides_it_from_the_page() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            accept_authorization_code(listener, "state-9")
                .await
                .unwrap()
        });
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        stream.shutdown().await.unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = b"GET /oauth/callback?code=secret-code&state=state-9 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        stream.write_all(request).await.unwrap();
        let mut page = Vec::new();
        stream.read_to_end(&mut page).await.unwrap();
        let page = String::from_utf8(page).unwrap();
        assert!(page.contains("Sign-in finished"));
        assert!(!page.contains("secret-code"));
        assert_eq!(handle.await.unwrap(), "secret-code");
    }

    #[tokio::test]
    async fn loopback_ignores_a_wrong_state_then_accepts_the_right_one() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle =
            tokio::spawn(async move { accept_authorization_code(listener, "expected").await });
        let mut stray = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stray
            .write_all(b"GET /oauth/callback?code=stray-code&state=other HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut page = Vec::new();
        stray.read_to_end(&mut page).await.unwrap();
        assert!(String::from_utf8(page).unwrap().contains("did not finish"));
        let mut real = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        real.write_all(b"GET /oauth/callback?code=real-code&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut page = Vec::new();
        real.read_to_end(&mut page).await.unwrap();
        assert!(String::from_utf8(page)
            .unwrap()
            .contains("Sign-in finished"));
        assert_eq!(handle.await.unwrap().unwrap(), "real-code");
    }

    #[tokio::test]
    async fn denied_with_a_wrong_state_does_not_abort() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle =
            tokio::spawn(async move { accept_authorization_code(listener, "expected").await });
        let mut stray = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stray
            .write_all(b"GET /oauth/callback?error=access_denied&state=other HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut page = Vec::new();
        stray.read_to_end(&mut page).await.unwrap();
        let mut real = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        real.write_all(b"GET /oauth/callback?code=real-code&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut page = Vec::new();
        real.read_to_end(&mut page).await.unwrap();
        assert_eq!(handle.await.unwrap().unwrap(), "real-code");
    }

    #[tokio::test]
    async fn denied_with_the_right_state_aborts() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle =
            tokio::spawn(async move { accept_authorization_code(listener, "expected").await });
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"GET /oauth/callback?error=access_denied&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut page = Vec::new();
        stream.read_to_end(&mut page).await.unwrap();
        assert_eq!(handle.await.unwrap().unwrap_err(), "Sign-in was canceled.");
    }

    #[test]
    fn states_match_is_exact_and_length_aware() {
        assert!(states_match("state-1", "state-1"));
        assert!(!states_match("state-1", "state-2"));
        assert!(!states_match("state", "state-1"));
        assert!(!states_match("state-1", "state"));
        assert!(!states_match("", "state-1"));
    }

    #[test]
    fn email_claim_wins_over_preferred_username() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"email":"sam@gmail.com","preferred_username":"other@example.com"}"#);
        let token = format!("aaa.{payload}.sig");
        let (email, _) = identity_from_id_token(&token).unwrap();
        assert_eq!(email, "sam@gmail.com");
        let fallback = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"preferred_username":"Sam@Contoso.com"}"#);
        let token = format!("aaa.{fallback}.sig");
        let (email, _) = identity_from_id_token(&token).unwrap();
        assert_eq!(email, "sam@contoso.com");
    }
}
