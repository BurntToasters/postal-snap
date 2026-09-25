use std::time::Duration;

#[cfg(test)]
use std::{future::Future, net::SocketAddr};

use hickory_resolver::{proto::rr::RData, TokioResolver};
use quick_xml::{events::Event, reader::Reader, XmlVersion};
use reqwest::{header::LOCATION, redirect::Policy};
use serde::Serialize;

use crate::{
    models::{validate_server, IpcError, ProviderKind, ServerConfig, TlsMode},
    security,
};

const MAX_AUTOCONFIG_BYTES: usize = 64 * 1024;
const MAX_AUTOCONFIG_DEPTH: usize = 32;
const MAX_AUTOCONFIG_EVENTS: usize = 2_048;
const AUTOCONFIG_TIMEOUT: Duration = Duration::from_secs(10);

struct ProviderPreset {
    id: &'static str,
    name: &'static str,
    domains: &'static [&'static str],
    mx_suffixes: &'static [&'static str],
    imap_host: &'static str,
    imap_port: u16,
    imap_tls: TlsMode,
    smtp_host: &'static str,
    smtp_port: u16,
    smtp_tls: TlsMode,
    app_password_url: &'static str,
}

const APPLE_PASSWORD_URL: &str = "https://support.apple.com/102654";
const ZOHO_PASSWORD_URL: &str = "https://help.zoho.com/portal/en/kb/accounts/manage-your-zoho-account/articles/manage-app-passwords";
const GMX_PASSWORD_URL: &str =
    "https://support.gmx.com/security/2fa/application-specific-passwords.html";

const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "icloud",
        name: "iCloud Mail",
        domains: &["icloud.com", "me.com", "mac.com"],
        mx_suffixes: &["mail.icloud.com"],
        imap_host: "imap.mail.me.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mail.me.com",
        smtp_port: 587,
        smtp_tls: TlsMode::StartTls,
        app_password_url: APPLE_PASSWORD_URL,
    },
    ProviderPreset {
        id: "fastmail",
        name: "Fastmail",
        domains: &["fastmail.com", "fastmail.fm"],
        mx_suffixes: &["messagingengine.com"],
        imap_host: "imap.fastmail.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.fastmail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords",
    },
    ProviderPreset {
        id: "yahoo",
        name: "Yahoo Mail",
        domains: &[
            "yahoo.com",
            "ymail.com",
            "rocketmail.com",
            "yahoo.ca",
            "yahoo.co.uk",
            "yahoo.com.au",
            "yahoo.co.in",
            "yahoo.de",
            "yahoo.es",
            "yahoo.fr",
            "yahoo.it",
        ],
        mx_suffixes: &[],
        imap_host: "imap.mail.yahoo.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mail.yahoo.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: "https://help.yahoo.com/kb/SLN15241.html",
    },
    ProviderPreset {
        id: "aol",
        name: "AOL Mail",
        domains: &["aol.com"],
        mx_suffixes: &[],
        imap_host: "imap.aol.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.aol.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: "https://help.aol.com/articles/Create-and-manage-app-password",
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail",
        domains: &["zoho.com", "zohomail.com"],
        mx_suffixes: &[],
        imap_host: "imap.zoho.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zoho.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: ZOHO_PASSWORD_URL,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail",
        domains: &[],
        mx_suffixes: &["zoho.com"],
        imap_host: "imappro.zoho.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtppro.zoho.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: ZOHO_PASSWORD_URL,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Europe",
        domains: &["zoho.eu", "zohomail.eu"],
        mx_suffixes: &[],
        imap_host: "imap.zoho.eu",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zoho.eu",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: ZOHO_PASSWORD_URL,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Europe",
        domains: &[],
        mx_suffixes: &["zoho.eu"],
        imap_host: "imappro.zoho.eu",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtppro.zoho.eu",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: ZOHO_PASSWORD_URL,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail India",
        domains: &["zoho.in", "zohomail.in"],
        mx_suffixes: &[],
        imap_host: "imap.zoho.in",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zoho.in",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: ZOHO_PASSWORD_URL,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail India",
        domains: &[],
        mx_suffixes: &["zoho.in"],
        imap_host: "imappro.zoho.in",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtppro.zoho.in",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: ZOHO_PASSWORD_URL,
    },
    ProviderPreset {
        id: "mailboxOrg",
        name: "mailbox.org",
        domains: &["mailbox.org"],
        mx_suffixes: &["mailbox.org"],
        imap_host: "imap.mailbox.org",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mailbox.org",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: "https://kb.mailbox.org/en/private/security/article/using-app-passwords-with-two-factor-authentication",
    },
    ProviderPreset {
        id: "gmx",
        name: "GMX Mail",
        domains: &["gmx.com"],
        mx_suffixes: &[],
        imap_host: "imap.gmx.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "mail.gmx.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: GMX_PASSWORD_URL,
    },
    ProviderPreset {
        id: "gmx",
        name: "GMX Mail",
        domains: &["gmx.net"],
        mx_suffixes: &[],
        imap_host: "imap.gmx.net",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "mail.gmx.net",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: GMX_PASSWORD_URL,
    },
];

struct UnsupportedProvider {
    id: &'static str,
    name: &'static str,
    domains: &'static [&'static str],
    message: &'static str,
}

const UNSUPPORTED: &[UnsupportedProvider] = &[
    UnsupportedProvider {
        id: "gmail",
        name: "Gmail",
        domains: &["gmail.com", "googlemail.com"],
        message: "Gmail requires OAuth for new third-party mail connections. Postal Snap does not support Gmail sign-in yet.",
    },
    UnsupportedProvider {
        id: "outlook",
        name: "Outlook",
        domains: &["outlook.com", "hotmail.com", "live.com", "msn.com"],
        message: "Outlook requires OAuth for third-party mail connections. Postal Snap does not support Outlook sign-in yet.",
    },
    UnsupportedProvider {
        id: "proton",
        name: "Proton Mail",
        domains: &["proton.me", "protonmail.com", "pm.me"],
        message: "Proton Mail requires Proton Mail Bridge for IMAP and SMTP. Postal Snap cannot connect directly.",
    },
    UnsupportedProvider {
        id: "tuta",
        name: "Tuta Mail",
        domains: &[
            "tuta.com",
            "tuta.io",
            "tutanota.com",
            "tutanota.de",
            "tutamail.com",
            "keemail.me",
        ],
        message: "Tuta Mail does not provide standard IMAP and SMTP access, so Postal Snap cannot connect directly.",
    },
];

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MailSettingsDiscovery {
    Found {
        provider_id: String,
        provider_name: String,
        account_provider: ProviderKind,
        source: String,
        imap: ServerConfig,
        smtp: ServerConfig,
        app_password_url: Option<String>,
    },
    Unsupported {
        provider_id: String,
        provider_name: String,
        message: String,
    },
    NotFound {
        domain: String,
    },
}

#[tauri::command]
pub async fn discover_mail_settings(email: String) -> Result<MailSettingsDiscovery, IpcError> {
    let (email, domain) = validate_discovery_email(&email).map_err(IpcError::from)?;

    if let Some(provider) = UNSUPPORTED
        .iter()
        .find(|provider| provider.domains.contains(&domain.as_str()))
    {
        return Ok(MailSettingsDiscovery::Unsupported {
            provider_id: provider.id.into(),
            provider_name: provider.name.into(),
            message: provider.message.into(),
        });
    }
    if let Some(preset) = match_preset(&domain) {
        return Ok(discovery_from_preset(preset, &email, "preset"));
    }
    if let Ok(Some(preset)) = lookup_mx_preset(&domain).await {
        return Ok(discovery_from_preset(preset, &email, "mx"));
    }

    let Ok(urls) = autoconfig_urls(&domain) else {
        return Ok(MailSettingsDiscovery::NotFound { domain });
    };
    for url in urls {
        let Ok(document) = fetch_autoconfig(&url).await else {
            continue;
        };
        let Ok((imap, smtp)) = parse_autoconfig(&document, &email) else {
            continue;
        };
        return Ok(MailSettingsDiscovery::Found {
            provider_id: "autoconfig".into(),
            provider_name: domain.clone(),
            account_provider: ProviderKind::Manual,
            source: "autoconfig".into(),
            imap,
            smtp,
            app_password_url: None,
        });
    }

    Ok(MailSettingsDiscovery::NotFound { domain })
}

fn validate_discovery_email(raw: &str) -> Result<(String, String), String> {
    let email = raw.trim().to_lowercase();
    if email.len() > 320 || email.parse::<lettre::Address>().is_err() {
        return Err("Enter a valid email address.".into());
    }
    let (_, domain) = email
        .rsplit_once('@')
        .ok_or_else(|| "Enter a valid email address.".to_string())?;
    let domain = domain.trim_end_matches('.').to_string();
    // The domain is interpolated into autoconfig URLs and shown as the
    // provider name, so only plain public DNS names are allowed.
    if !is_public_dns_name(&domain) {
        return Err("Enter a valid email address.".into());
    }
    Ok((email, domain))
}

fn autoconfig_urls(domain: &str) -> Result<[String; 2], String> {
    Ok([
        public_https_url(&format!("autoconfig.{domain}"), "/mail/config-v1.1.xml")?,
        public_https_url(domain, "/.well-known/autoconfig/mail/config-v1.1.xml")?,
    ])
}

fn public_https_url(host: &str, path: &str) -> Result<String, String> {
    let mut url = url::Url::parse("https://invalid.example/")
        .map_err(|_| "Could not build a settings address.".to_string())?;
    url.set_host(Some(host))
        .map_err(|_| "Enter a valid email address.".to_string())?;
    url.set_path(path);
    if url.scheme() != "https" || url.host_str() != Some(host) {
        return Err("Enter a valid email address.".into());
    }
    Ok(url.into())
}

/// ASCII letters, digits, and inner hyphens; at least two labels; a
/// non-numeric top-level label; no single-label or local-only names.
fn is_public_dns_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = name.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let valid_labels = labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    });
    let top = labels[labels.len() - 1];
    valid_labels
        && !top.bytes().all(|byte| byte.is_ascii_digit())
        && !matches!(
            top.to_ascii_lowercase().as_str(),
            "localhost" | "local" | "internal" | "lan" | "home" | "corp" | "arpa"
        )
}

fn match_preset(domain: &str) -> Option<&'static ProviderPreset> {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    PRESETS
        .iter()
        .find(|preset| preset.domains.contains(&domain.as_str()))
}

fn discovery_from_preset(
    preset: &'static ProviderPreset,
    email: &str,
    source: &str,
) -> MailSettingsDiscovery {
    let local = email.split('@').next().unwrap_or(email);
    let imap_username = if preset.id == "icloud" { local } else { email };
    MailSettingsDiscovery::Found {
        provider_id: preset.id.into(),
        provider_name: preset.name.into(),
        account_provider: if preset.id == "icloud" {
            ProviderKind::Icloud
        } else {
            ProviderKind::Manual
        },
        source: source.into(),
        imap: ServerConfig {
            host: preset.imap_host.into(),
            port: preset.imap_port,
            tls_mode: preset.imap_tls.clone(),
            username: imap_username.into(),
        },
        smtp: ServerConfig {
            host: preset.smtp_host.into(),
            port: preset.smtp_port,
            tls_mode: preset.smtp_tls.clone(),
            username: email.into(),
        },
        app_password_url: Some(preset.app_password_url.into()),
    }
}

async fn lookup_mx_preset(domain: &str) -> Result<Option<&'static ProviderPreset>, String> {
    let resolver = TokioResolver::builder_tokio()
        .map_err(|_| "Could not read system DNS settings.".to_string())?
        .build()
        .map_err(|_| "Could not start DNS lookup.".to_string())?;
    let lookup = tokio::time::timeout(
        Duration::from_secs(5),
        resolver.mx_lookup(format!("{domain}.")),
    )
    .await
    .map_err(|_| "Mail provider lookup timed out.".to_string())?
    .map_err(|_| "Mail provider lookup failed.".to_string())?;
    let hosts = lookup
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
            RData::MX(mx) => Some(format!("{} {}", mx.preference, mx.exchange)),
            _ => None,
        })
        .collect::<Vec<_>>();
    Ok(preset_for_mx_hosts(&hosts))
}

fn preset_for_mx_hosts(hosts: &[String]) -> Option<&'static ProviderPreset> {
    PRESETS.iter().find(|preset| {
        preset.mx_suffixes.iter().any(|suffix| {
            hosts.iter().any(|entry| {
                let host = entry
                    .split_whitespace()
                    .last()
                    .unwrap_or(entry)
                    .trim_end_matches('.')
                    .to_ascii_lowercase();
                host == *suffix || host.ends_with(&format!(".{suffix}"))
            })
        })
    })
}

#[derive(Default)]
struct ParsedServer {
    kind: String,
    host: String,
    port: String,
    socket_type: String,
    authentication: Vec<String>,
    username: String,
}

fn parse_autoconfig(document: &[u8], email: &str) -> Result<(ServerConfig, ServerConfig), String> {
    if document.len() > MAX_AUTOCONFIG_BYTES {
        return Err("The mail settings file is too large.".into());
    }
    let mut reader = Reader::from_reader(document);
    reader.config_mut().trim_text(true);
    reader.config_mut().check_end_names = true;
    let mut depth = 0usize;
    let mut events = 0usize;
    let mut active: Option<ParsedServer> = None;
    let mut field: Option<String> = None;
    let mut incoming = Vec::new();
    let mut outgoing = Vec::new();

    loop {
        events += 1;
        if events > MAX_AUTOCONFIG_EVENTS {
            return Err("The mail settings file is too complex.".into());
        }
        match reader
            .read_event()
            .map_err(|_| "The mail settings file is invalid.".to_string())?
        {
            Event::Start(start) => {
                depth += 1;
                if depth > MAX_AUTOCONFIG_DEPTH {
                    return Err("The mail settings file is too complex.".into());
                }
                let name = start.local_name().as_ref().to_ascii_lowercase();
                if matches!(name.as_str(), "incomingserver" | "outgoingserver") {
                    let kind = start
                        .attributes()
                        .filter_map(Result::ok)
                        .find(|attribute| attribute.key.local_name().as_ref() == "type")
                        .and_then(|attribute| {
                            attribute
                                .normalized_value(XmlVersion::Implicit1_0)
                                .ok()
                                .map(|value| value.into_owned().to_ascii_lowercase())
                        })
                        .unwrap_or_default();
                    active = Some(ParsedServer {
                        kind,
                        ..ParsedServer::default()
                    });
                } else if active.is_some()
                    && matches!(
                        name.as_str(),
                        "hostname" | "port" | "sockettype" | "authentication" | "username"
                    )
                {
                    field = Some(name);
                }
            }
            Event::Text(text) => {
                let Some(server) = active.as_mut() else {
                    continue;
                };
                let Some(field_name) = field.as_deref() else {
                    continue;
                };
                let value = quick_xml::escape::unescape(text.as_ref())
                    .map_err(|_| "The mail settings file is invalid.".to_string())?
                    .trim()
                    .to_string();
                match field_name {
                    "hostname" => server.host.push_str(&value),
                    "port" => server.port.push_str(&value),
                    "sockettype" => server.socket_type.push_str(&value),
                    "authentication" => server.authentication.push(value),
                    "username" => server.username.push_str(&value),
                    _ => {}
                }
            }
            Event::End(end) => {
                let name = end.local_name().as_ref().to_ascii_lowercase();
                if matches!(name.as_str(), "incomingserver" | "outgoingserver") {
                    if let Some(server) = active.take() {
                        if name == "incomingserver" {
                            incoming.push(server);
                        } else {
                            outgoing.push(server);
                        }
                    }
                }
                if field.as_deref() == Some(name.as_str()) {
                    field = None;
                }
                depth = depth.saturating_sub(1);
            }
            Event::DocType(_) => return Err("The mail settings file is invalid.".into()),
            Event::Eof => break,
            _ => {}
        }
    }

    let imap = incoming
        .into_iter()
        .filter(|server| server.kind.eq_ignore_ascii_case("imap"))
        .find_map(|server| secure_server(server, email).ok())
        .ok_or_else(|| "No secure password-based IMAP settings were found.".to_string())?;
    let smtp = outgoing
        .into_iter()
        .filter(|server| server.kind.eq_ignore_ascii_case("smtp"))
        .find_map(|server| secure_server(server, email).ok())
        .ok_or_else(|| "No secure password-based SMTP settings were found.".to_string())?;
    Ok((imap, smtp))
}

fn secure_server(server: ParsedServer, email: &str) -> Result<ServerConfig, String> {
    let socket = server.socket_type.trim().to_ascii_lowercase();
    let tls_mode = match socket.as_str() {
        "ssl" | "tls" | "ssl/tls" => TlsMode::Tls,
        "starttls" => TlsMode::StartTls,
        _ => return Err("Plaintext mail settings are not supported.".into()),
    };
    let password_auth = server.authentication.iter().any(|method| {
        matches!(
            method.trim().to_ascii_lowercase().as_str(),
            "password-cleartext" | "password-encrypted" | "plain" | "login"
        )
    });
    if !password_auth {
        return Err("OAuth-only mail settings are not supported.".into());
    }
    let local = email.split('@').next().unwrap_or(email);
    let domain = email
        .rsplit_once('@')
        .map(|(_, value)| value)
        .unwrap_or_default();
    let username = if server.username.trim().is_empty() {
        email.to_string()
    } else {
        server
            .username
            .trim()
            .replace("%EMAILADDRESS%", email)
            .replace("%EMAILLOCALPART%", local)
            .replace("%EMAILDOMAIN%", domain)
    };
    if username.contains('%') {
        return Err("The mail settings use an unsupported username format.".into());
    }
    let config = ServerConfig {
        host: server
            .host
            .trim()
            .trim_end_matches('.')
            .to_ascii_lowercase(),
        port: server
            .port
            .trim()
            .parse()
            .map_err(|_| "The mail settings contain an invalid port.".to_string())?,
        tls_mode,
        username,
    };
    if !is_public_dns_name(&config.host) {
        return Err("The mail settings point to an unsupported server name.".into());
    }
    validate_server(&config)?;
    Ok(config)
}

async fn fetch_autoconfig(raw_url: &str) -> Result<Vec<u8>, String> {
    tokio::time::timeout(AUTOCONFIG_TIMEOUT, fetch_autoconfig_inner(raw_url))
        .await
        .map_err(|_| "The mail settings request timed out.".to_string())?
}

async fn fetch_autoconfig_inner(raw_url: &str) -> Result<Vec<u8>, String> {
    let mut target = security::validate_public_https_url(raw_url).await?;
    for _ in 0..3 {
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(8))
            .user_agent(concat!(
                "Postal Snap/",
                env!("CARGO_PKG_VERSION"),
                " provider-discovery"
            ))
            .resolve_to_addrs(&target.host, &target.addresses)
            .build()
            .map_err(|_| "Could not create a secure settings request.".to_string())?;
        let mut response = client
            .get(target.url.clone())
            .send()
            .await
            .map_err(|_| "Could not load mail settings.".to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "The settings server returned an unsafe redirect.".to_string())?;
            let redirected = target
                .url
                .join(location)
                .map_err(|_| "The settings server returned an unsafe redirect.".to_string())?;
            target = security::validate_public_https_url(redirected.as_str()).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err("The settings server did not return mail settings.".into());
        }
        if response
            .content_length()
            .is_some_and(|size| size as usize > MAX_AUTOCONFIG_BYTES)
        {
            return Err("The mail settings file is too large.".into());
        }
        let mut document = Vec::with_capacity(
            response
                .content_length()
                .unwrap_or_default()
                .min(MAX_AUTOCONFIG_BYTES as u64) as usize,
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read mail settings.".to_string())?
        {
            if document.len().saturating_add(chunk.len()) > MAX_AUTOCONFIG_BYTES {
                return Err("The mail settings file is too large.".into());
            }
            document.extend_from_slice(&chunk);
        }
        return Ok(document);
    }
    Err("The settings server redirected too many times.".into())
}

#[cfg(test)]
async fn validate_autoconfig_target_with_resolver<F, Fut>(
    raw_url: &str,
    resolve: F,
) -> Result<(), String>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: Future<Output = Result<Vec<SocketAddr>, String>>,
{
    security::validate_public_https_url_with_resolver(raw_url, resolve)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{
        autoconfig_urls, match_preset, parse_autoconfig, preset_for_mx_hosts,
        validate_autoconfig_target_with_resolver, validate_discovery_email,
    };
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    #[test]
    fn preset_domains_match_exactly() {
        assert_eq!(
            match_preset("icloud.com").map(|preset| preset.id),
            Some("icloud")
        );
        assert_eq!(
            match_preset("me.com").map(|preset| preset.id),
            Some("icloud")
        );
        assert_eq!(
            match_preset("fastmail.com").map(|preset| preset.id),
            Some("fastmail")
        );
        assert_eq!(match_preset("evilicloud.com").map(|preset| preset.id), None);
        assert_eq!(
            match_preset("fastmail.com.example").map(|preset| preset.id),
            None
        );
        assert_eq!(
            match_preset("zoho.eu").map(|preset| preset.imap_host),
            Some("imap.zoho.eu")
        );
        assert_eq!(
            match_preset("zoho.in").map(|preset| preset.imap_host),
            Some("imap.zoho.in")
        );
    }

    #[test]
    fn autoconfig_rejects_plaintext_and_pop() {
        let xml = br#"<?xml version="1.0"?>
          <clientConfig><emailProvider id="example.test">
            <incomingServer type="pop3"><hostname>pop.example.test</hostname><port>995</port><socketType>SSL</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></incomingServer>
            <incomingServer type="imap"><hostname>imap.example.test</hostname><port>143</port><socketType>plain</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></incomingServer>
            <outgoingServer type="smtp"><hostname>smtp.example.test</hostname><port>25</port><socketType>plain</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></outgoingServer>
          </emailProvider></clientConfig>"#;

        assert!(parse_autoconfig(xml, "reader@example.test").is_err());
    }

    #[test]
    fn autoconfig_accepts_secure_password_servers() {
        let xml = br#"<?xml version="1.0"?>
          <clientConfig><emailProvider id="example.test">
            <incomingServer type="imap"><hostname>imap.example.test</hostname><port>993</port><socketType>SSL</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></incomingServer>
            <outgoingServer type="smtp"><hostname>smtp.example.test</hostname><port>587</port><socketType>STARTTLS</socketType><authentication>password-cleartext</authentication><username>%EMAILLOCALPART%</username></outgoingServer>
          </emailProvider></clientConfig>"#;

        let (imap, smtp) = parse_autoconfig(xml, "reader@example.test").unwrap();
        assert_eq!(imap.host, "imap.example.test");
        assert_eq!(imap.username, "reader@example.test");
        assert_eq!(smtp.host, "smtp.example.test");
        assert_eq!(smtp.username, "reader");
    }

    #[test]
    fn discovery_rejects_domains_that_alter_the_url() {
        for email in [
            "me@example.com/x?y",
            "me@attacker.example/x.victim.com",
            "me@example.com#frag",
            "me@exa%2emple.com",
            "me@localhost",
            "me@[127.0.0.1]",
            "me@example.123",
            "me@-bad.example",
        ] {
            assert!(validate_discovery_email(email).is_err(), "{email}");
        }
        assert_eq!(
            validate_discovery_email(" Reader@Mail.Example.COM ").unwrap(),
            (
                "reader@mail.example.com".to_string(),
                "mail.example.com".to_string()
            )
        );
        let [autoconfig, well_known] = autoconfig_urls("mail.example.com").unwrap();
        assert_eq!(
            autoconfig,
            "https://autoconfig.mail.example.com/mail/config-v1.1.xml"
        );
        assert_eq!(
            well_known,
            "https://mail.example.com/.well-known/autoconfig/mail/config-v1.1.xml"
        );
    }

    #[test]
    fn autoconfig_rejects_internal_or_lookalike_hosts() {
        for host in [
            "127.0.0.1",
            "192.168.1.1",
            "[::1]",
            "localhost",
            "mail",
            "imap.corp.internal",
            "printer.local",
            "imap.gm\u{0430}il.com",
        ] {
            let xml = format!(
                r#"<?xml version="1.0"?>
          <clientConfig><emailProvider id="example.test">
            <incomingServer type="imap"><hostname>{host}</hostname><port>993</port><socketType>SSL</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></incomingServer>
            <outgoingServer type="smtp"><hostname>smtp.example.test</hostname><port>587</port><socketType>STARTTLS</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></outgoingServer>
          </emailProvider></clientConfig>"#
            );
            assert!(
                parse_autoconfig(xml.as_bytes(), "reader@example.test").is_err(),
                "{host}"
            );
        }
    }

    #[test]
    fn autoconfig_rejects_oversized_documents() {
        let oversized = vec![b' '; 64 * 1024 + 1];
        assert!(parse_autoconfig(&oversized, "reader@example.test").is_err());
    }

    #[test]
    fn mx_maps_only_to_known_presets() {
        assert_eq!(
            preset_for_mx_hosts(&["10 in1-smtp.messagingengine.com.".into()])
                .map(|preset| preset.id),
            Some("fastmail")
        );
        assert_eq!(
            preset_for_mx_hosts(&["10 mail.unknown-provider.example.".into()])
                .map(|preset| preset.id),
            None
        );
        assert_eq!(
            preset_for_mx_hosts(&["10 mx.zoho.eu.".into()]).map(|preset| preset.imap_host),
            Some("imappro.zoho.eu")
        );
        assert_eq!(
            preset_for_mx_hosts(&["10 mx.zoho.in.".into()]).map(|preset| preset.imap_host),
            Some("imappro.zoho.in")
        );
    }

    #[tokio::test]
    async fn autoconfig_blocks_private_targets() {
        let result = validate_autoconfig_target_with_resolver(
            "https://autoconfig.example.test/mail/config-v1.1.xml",
            |_, port| async move {
                Ok(vec![SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
                    port,
                )])
            },
        )
        .await;

        assert!(result.is_err());
    }
}
