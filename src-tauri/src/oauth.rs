//! Background OAuth 2.0 groundwork for Gmail and Outlook.
//!
//! No UI exposes this yet: account setup stays iCloud/manual only. This
//! module holds the provider metadata, PKCE authorization-URL builder,
//! token-exchange client, refresh-token vault, and XOAUTH2 SASL builders
//! so a future setup flow can sign in without touching this layer again.
//!
//! Secrets never leave this module except as [`zeroize::Zeroizing`] strings.
//! Client IDs are parameters, never hardcoded: each distributed build
//! supplies its own registered OAuth application credentials at release time.

use std::time::{Duration, SystemTime};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::models::TlsMode;

const TOKEN_TIMEOUT: Duration = Duration::from_secs(20);

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

    /// Redirect target for the system-browser sign-in. Handled by the
    /// already-registered deep-link plugin once a setup flow listens for it.
    pub fn redirect_uri() -> &'static str {
        "run.rosie.snap://oauth/callback"
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
) -> Result<url::Url, String> {
    let mut url = url::Url::parse(provider.authorization_endpoint())
        .map_err(|_| "The sign-in service address is invalid.".to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", OAuthProvider::redirect_uri())
        .append_pair("scope", &provider.scopes().join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", &pkce_challenge(code_verifier))
        .append_pair("code_challenge_method", "S256");
    if provider == OAuthProvider::Outlook {
        url.query_pairs_mut()
            .append_pair("prompt", "select_account");
    }
    Ok(url)
}

#[derive(Clone, Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
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
            ("redirect_uri", OAuthProvider::redirect_uri()),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_urls_carry_pkce_and_scopes() {
        let url = authorization_url(OAuthProvider::Gmail, "client-1", "state-1", "verifier-1")
            .unwrap()
            .to_string();
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("mail.google.com"));
        assert!(!url.contains("verifier-1"));

        let outlook =
            authorization_url(OAuthProvider::Outlook, "client-2", "state-2", "verifier-2")
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
}
