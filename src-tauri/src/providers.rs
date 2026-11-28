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

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppPasswordPolicy {
    Required,
    RequiredWith2fa,
    None,
}

impl AppPasswordPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::RequiredWith2fa => "requiredWith2fa",
            Self::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PasswordFormat {
    AppleHyphenated,
    GroupedSpaces,
    Standard,
}

impl PasswordFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AppleHyphenated => "appleHyphenated",
            Self::GroupedSpaces => "groupedSpaces",
            Self::Standard => "standard",
        }
    }
}

pub struct ProviderAccountMeta {
    pub provider_id: Option<String>,
    pub app_password_policy: AppPasswordPolicy,
    pub app_password_url: Option<String>,
    pub password_format: PasswordFormat,
}

struct ProviderPreset {
    id: &'static str,
    name: &'static str,
    domains: &'static [&'static str],
    mx_suffixes: &'static [&'static str],
    account_provider: ProviderKind,
    imap_host: &'static str,
    imap_port: u16,
    imap_tls: TlsMode,
    smtp_host: &'static str,
    smtp_port: u16,
    smtp_tls: TlsMode,
    app_password_url: Option<&'static str>,
    app_password_policy: AppPasswordPolicy,
    password_format: PasswordFormat,
    setup_hint_key: Option<&'static str>,
    blank_username_for_mx: bool,
}

const APPLE_PASSWORD_URL: &str = "https://support.apple.com/102654";
const GMAIL_PASSWORD_URL: &str = "https://support.google.com/accounts/answer/185833";
const FASTMAIL_PASSWORD_URL: &str =
    "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords";
const YAHOO_PASSWORD_URL: &str = "https://help.yahoo.com/kb/SLN15241.html";
const ATT_PASSWORD_URL: &str = "https://www.att.com/support/article/email-support/KM1240308/";
const AOL_PASSWORD_URL: &str = "https://help.aol.com/articles/Create-and-manage-app-password";
const GMX_PASSWORD_URL: &str =
    "https://support.gmx.com/security/2fa/application-specific-passwords.html";
const WEBDE_PASSWORD_URL: &str =
    "https://hilfe.web.de/sicherheit/2fa/anwendungsspezifisches-passwort.html";
const MAILCOM_PASSWORD_URL: &str =
    "https://support.mail.com/security/2fa/application-specific-passwords.html";
const POSTEO_PASSWORD_URL: &str = "https://posteo.de/en/help/app-passwords";
const PURELYMAIL_PASSWORD_URL: &str = "https://purelymail.com/docs/twoFactorAuthentication";
const INFOMANIAK_PASSWORD_URL: &str =
    "https://www.infomaniak.com/gtl/support.faq.faq_question/id/2904";
const MAILFENCE_PASSWORD_URL: &str = "https://kb.mailfence.com/kb/service-specific-passwords/";
const RUNBOX_PASSWORD_URL: &str = "https://help.runbox.com/account-security/";

const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "icloud",
        name: "iCloud Mail",
        domains: &["icloud.com", "me.com", "mac.com"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Icloud,
        imap_host: "imap.mail.me.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mail.me.com",
        smtp_port: 587,
        smtp_tls: TlsMode::StartTls,
        app_password_url: Some(APPLE_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::AppleHyphenated,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "icloud",
        name: "iCloud Mail",
        domains: &[],
        mx_suffixes: &["mail.icloud.com"],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.mail.me.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mail.me.com",
        smtp_port: 587,
        smtp_tls: TlsMode::StartTls,
        app_password_url: Some(APPLE_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::AppleHyphenated,
        setup_hint_key: Some("icloudCustomDomain"),
        blank_username_for_mx: true,
    },
    ProviderPreset {
        id: "gmail",
        name: "Gmail",
        domains: &["gmail.com", "googlemail.com"],
        mx_suffixes: &["google.com", "googlemail.com", "smtp.google.com"],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.gmail.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.gmail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(GMAIL_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("gmail2sv"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "fastmail",
        name: "Fastmail",
        domains: &[
            "fastmail.com",
            "fastmail.fm",
            "fastmail.us",
            "fastmail.co.uk",
            "fastmail.org",
            "fastmail.net",
            "sent.com",
            "pobox.com",
        ],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.fastmail.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.fastmail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(FASTMAIL_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "fastmail",
        name: "Fastmail",
        domains: &[],
        mx_suffixes: &["messagingengine.com"],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.fastmail.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.fastmail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(FASTMAIL_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("fastmailCustomDomain"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "yahoo",
        name: "Yahoo Mail",
        domains: &[
            "yahoo.com",
            "ymail.com",
            "rocketmail.com",
            "myyahoo.com",
            "yahoo.ca",
            "yahoo.co.uk",
            "yahoo.com.au",
            "yahoo.co.in",
            "yahoo.de",
            "yahoo.es",
            "yahoo.fr",
            "yahoo.it",
            "yahoo.com.br",
            "yahoo.com.mx",
            "yahoo.com.sg",
            "yahoo.com.hk",
            "yahoo.com.tw",
            "yahoo.co.jp",
            "rogers.com",
            "sky.com",
            "btinternet.com",
        ],
        mx_suffixes: &["yahoodns.net"],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.mail.yahoo.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mail.yahoo.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(YAHOO_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "att",
        name: "AT&T Mail",
        domains: &[
            "att.net",
            "sbcglobal.net",
            "bellsouth.net",
            "nvbell.net",
            "pacbell.net",
            "prodigy.net",
            "swbell.net",
        ],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.mail.att.net",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mail.att.net",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(ATT_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::Standard,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "aol",
        name: "AOL Mail",
        domains: &["aol.com", "aim.com", "verizon.net", "aol.co.uk"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.aol.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.aol.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(AOL_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail",
        domains: &["zoho.com", "zohomail.com"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.zoho.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zoho.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail",
        domains: &[],
        mx_suffixes: &["zoho.com"],
        account_provider: ProviderKind::Manual,
        imap_host: "imappro.zoho.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtppro.zoho.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Europe",
        domains: &["zoho.eu", "zohomail.eu"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.zoho.eu",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zoho.eu",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Europe",
        domains: &[],
        mx_suffixes: &["zoho.eu"],
        account_provider: ProviderKind::Manual,
        imap_host: "imappro.zoho.eu",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtppro.zoho.eu",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail India",
        domains: &["zoho.in", "zohomail.in"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.zoho.in",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zoho.in",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail India",
        domains: &[],
        mx_suffixes: &["zoho.in"],
        account_provider: ProviderKind::Manual,
        imap_host: "imappro.zoho.in",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtppro.zoho.in",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Australia",
        domains: &["zoho.com.au", "zohomail.com.au"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.zoho.com.au",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zoho.com.au",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Australia",
        domains: &[],
        mx_suffixes: &["zoho.com.au"],
        account_provider: ProviderKind::Manual,
        imap_host: "imappro.zoho.com.au",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtppro.zoho.com.au",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Japan",
        domains: &["zoho.jp", "zohomail.jp"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.zoho.jp",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zoho.jp",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Japan",
        domains: &[],
        mx_suffixes: &["zoho.jp"],
        account_provider: ProviderKind::Manual,
        imap_host: "imappro.zoho.jp",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtppro.zoho.jp",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "zoho",
        name: "Zoho Mail Canada",
        domains: &["zohocloud.ca", "zohomail.ca"],
        mx_suffixes: &["zohocloud.ca"],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.zohocloud.ca",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.zohocloud.ca",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "mailboxOrg",
        name: "mailbox.org",
        domains: &["mailbox.org"],
        mx_suffixes: &["mailbox.org"],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.mailbox.org",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mailbox.org",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::Standard,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "gmx",
        name: "GMX Mail",
        domains: &[
            "gmx.com",
            "gmx.us",
            "gmx.co.uk",
            "gmx.fr",
            "gmx.es",
            "gmx.org",
        ],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.gmx.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "mail.gmx.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(GMX_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::Standard,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "gmx",
        name: "GMX Mail",
        domains: &[
            "gmx.net", "gmx.de", "gmx.at", "gmx.ch", "gmx.eu", "gmx.info",
        ],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.gmx.net",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "mail.gmx.net",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(GMX_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::Standard,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "webde",
        name: "WEB.DE Mail",
        domains: &["web.de"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.web.de",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.web.de",
        smtp_port: 587,
        smtp_tls: TlsMode::StartTls,
        app_password_url: Some(WEBDE_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::Standard,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "mailcom",
        name: "mail.com",
        domains: &["mail.com"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.mail.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(MAILCOM_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::Standard,
        setup_hint_key: Some("imapEnable"),
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "posteo",
        name: "Posteo",
        domains: &[
            "posteo.de",
            "posteo.net",
            "posteo.org",
            "posteo.eu",
            "posteo.ch",
            "posteo.at",
            "posteo.co",
            "posteo.uk",
            "posteo.us",
            "posteo.ca",
            "posteo.me",
            "posteo.name",
        ],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "posteo.de",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "posteo.de",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(POSTEO_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::Standard,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "purelymail",
        name: "Purelymail",
        domains: &["purelymail.com"],
        mx_suffixes: &["purelymail.com"],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.purelymail.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.purelymail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(PURELYMAIL_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::Standard,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "startmail",
        name: "StartMail",
        domains: &["startmail.com", "use.startmail.com"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.startmail.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.startmail.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::GroupedSpaces,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "infomaniak",
        name: "Infomaniak Mail",
        domains: &["ik.me", "ikmail.com", "etik.com"],
        mx_suffixes: &["infomaniak.ch"],
        account_provider: ProviderKind::Manual,
        imap_host: "mail.infomaniak.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "mail.infomaniak.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(INFOMANIAK_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::Required,
        password_format: PasswordFormat::Standard,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "mailfence",
        name: "Mailfence",
        domains: &["mailfence.com"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.mailfence.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.mailfence.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(MAILFENCE_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::None,
        password_format: PasswordFormat::Standard,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "runbox",
        name: "Runbox",
        domains: &["runbox.com", "runbox.no", "runbox.me", "runbox.email"],
        mx_suffixes: &[],
        account_provider: ProviderKind::Manual,
        imap_host: "mail.runbox.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "mail.runbox.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: Some(RUNBOX_PASSWORD_URL),
        app_password_policy: AppPasswordPolicy::RequiredWith2fa,
        password_format: PasswordFormat::Standard,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
    ProviderPreset {
        id: "migadu",
        name: "Migadu",
        domains: &[],
        mx_suffixes: &["migadu.com"],
        account_provider: ProviderKind::Manual,
        imap_host: "imap.migadu.com",
        imap_port: 993,
        imap_tls: TlsMode::Tls,
        smtp_host: "smtp.migadu.com",
        smtp_port: 465,
        smtp_tls: TlsMode::Tls,
        app_password_url: None,
        app_password_policy: AppPasswordPolicy::None,
        password_format: PasswordFormat::Standard,
        setup_hint_key: None,
        blank_username_for_mx: false,
    },
];

struct UnsupportedProvider {
    id: &'static str,
    name: &'static str,
    domains: &'static [&'static str],
    mx_suffixes: &'static [&'static str],
    message: &'static str,
}

const UNSUPPORTED: &[UnsupportedProvider] = &[
    UnsupportedProvider {
        id: "outlook",
        name: "Outlook",
        domains: &[
            "outlook.com",
            "hotmail.com",
            "live.com",
            "msn.com",
            "outlook.co.uk",
            "outlook.de",
            "outlook.fr",
            "outlook.jp",
            "hotmail.co.uk",
            "hotmail.de",
            "hotmail.fr",
            "live.co.uk",
        ],
        mx_suffixes: &["mail.protection.outlook.com", "olc.protection.outlook.com"],
        message: "Outlook requires OAuth for third-party mail connections. Postal Snap does not support Outlook sign-in yet.",
    },
    UnsupportedProvider {
        id: "proton",
        name: "Proton Mail",
        domains: &["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
        mx_suffixes: &["protonmail.ch"],
        message: "Proton Mail requires Proton Mail Bridge for IMAP and SMTP. Go back and choose Proton Bridge.",
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
        mx_suffixes: &["tutanota.de"],
        message: "Tuta Mail does not provide standard IMAP and SMTP access, so Postal Snap cannot connect directly.",
    },
];

#[allow(clippy::large_enum_variant)]
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
        app_password_policy: AppPasswordPolicy,
        password_format: PasswordFormat,
        setup_hint_key: Option<String>,
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

pub fn infer_provider_id(provider: &ProviderKind, imap_host: &str) -> Option<String> {
    match provider {
        ProviderKind::Icloud => Some("icloud".into()),
        ProviderKind::ProtonBridge => Some("protonBridge".into()),
        ProviderKind::Gmail => Some("gmail".into()),
        ProviderKind::Outlook => Some("outlook".into()),
        ProviderKind::Manual => {
            let host = imap_host.trim().trim_end_matches('.').to_ascii_lowercase();
            PRESETS
                .iter()
                .find(|preset| preset.imap_host == host)
                .map(|preset| preset.id.to_string())
        }
    }
}

pub fn provider_account_meta(
    provider: &ProviderKind,
    provider_id: Option<&str>,
    imap_host: &str,
) -> ProviderAccountMeta {
    let resolved_id = provider_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| infer_provider_id(provider, imap_host));
    if let Some(id) = resolved_id.as_deref() {
        if let Some(preset) = PRESETS.iter().find(|preset| preset.id == id) {
            return ProviderAccountMeta {
                provider_id: Some(preset.id.to_string()),
                app_password_policy: preset.app_password_policy,
                app_password_url: preset.app_password_url.map(ToOwned::to_owned),
                password_format: preset.password_format,
            };
        }
    }
    ProviderAccountMeta {
        provider_id: resolved_id,
        app_password_policy: AppPasswordPolicy::None,
        app_password_url: None,
        password_format: PasswordFormat::Standard,
    }
}

pub fn strips_password_spaces(provider: &ProviderKind, provider_id: Option<&str>) -> bool {
    if *provider == ProviderKind::Icloud {
        return true;
    }
    let Some(id) = provider_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    PRESETS.iter().any(|preset| {
        preset.id == id
            && matches!(
                preset.password_format,
                PasswordFormat::AppleHyphenated | PasswordFormat::GroupedSpaces
            )
    })
}

#[tauri::command]
pub async fn discover_mail_settings(email: String) -> Result<MailSettingsDiscovery, IpcError> {
    let (email, domain) = validate_discovery_email(&email).map_err(IpcError::from)?;

    if let Some(provider) = match_unsupported(&domain) {
        return Ok(MailSettingsDiscovery::Unsupported {
            provider_id: provider.id.into(),
            provider_name: provider.name.into(),
            message: provider.message.into(),
        });
    }
    if let Some(preset) = match_preset(&domain) {
        return Ok(discovery_from_preset(preset, &email, "preset"));
    }
    if let Ok(mx_hosts) = lookup_mx_hosts(&domain).await {
        if let Some(provider) = unsupported_for_mx_hosts(&mx_hosts) {
            return Ok(MailSettingsDiscovery::Unsupported {
                provider_id: provider.id.into(),
                provider_name: provider.name.into(),
                message: provider.message.into(),
            });
        }
        if let Some(preset) = preset_for_mx_hosts(&mx_hosts) {
            return Ok(discovery_from_preset(preset, &email, "mx"));
        }
    }

    if let Ok(urls) = autoconfig_urls(&domain) {
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
                app_password_policy: AppPasswordPolicy::None,
                password_format: PasswordFormat::Standard,
                setup_hint_key: None,
            });
        }
    }

    if let Ok(Some((imap, smtp))) = lookup_srv_settings(&domain, &email).await {
        return Ok(MailSettingsDiscovery::Found {
            provider_id: "srv".into(),
            provider_name: domain.clone(),
            account_provider: ProviderKind::Manual,
            source: "srv".into(),
            imap,
            smtp,
            app_password_url: None,
            app_password_policy: AppPasswordPolicy::None,
            password_format: PasswordFormat::Standard,
            setup_hint_key: None,
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

fn match_unsupported(domain: &str) -> Option<&'static UnsupportedProvider> {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    UNSUPPORTED
        .iter()
        .find(|provider| provider.domains.contains(&domain.as_str()))
}

fn discovery_from_preset(
    preset: &'static ProviderPreset,
    email: &str,
    source: &str,
) -> MailSettingsDiscovery {
    let local = email.split('@').next().unwrap_or(email);
    let blank = source == "mx" && preset.blank_username_for_mx;
    let imap_username = if blank {
        ""
    } else if preset.account_provider == ProviderKind::Icloud {
        local
    } else {
        email
    };
    let smtp_username = if blank { "" } else { email };
    MailSettingsDiscovery::Found {
        provider_id: preset.id.into(),
        provider_name: preset.name.into(),
        account_provider: preset.account_provider.clone(),
        source: source.into(),
        imap: ServerConfig {
            trusted_certificate: None,
            host: preset.imap_host.into(),
            port: preset.imap_port,
            tls_mode: preset.imap_tls.clone(),
            username: imap_username.into(),
        },
        smtp: ServerConfig {
            trusted_certificate: None,
            host: preset.smtp_host.into(),
            port: preset.smtp_port,
            tls_mode: preset.smtp_tls.clone(),
            username: smtp_username.into(),
        },
        app_password_url: preset.app_password_url.map(ToOwned::to_owned),
        app_password_policy: preset.app_password_policy,
        password_format: preset.password_format,
        setup_hint_key: preset.setup_hint_key.map(ToOwned::to_owned),
    }
}

async fn lookup_mx_hosts(domain: &str) -> Result<Vec<String>, String> {
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
    Ok(lookup
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
            RData::MX(mx) => Some(format!("{} {}", mx.preference, mx.exchange)),
            _ => None,
        })
        .collect())
}

fn mx_hosts_match_suffixes(hosts: &[String], suffixes: &[&str]) -> bool {
    suffixes.iter().any(|suffix| {
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
}

fn preset_for_mx_hosts(hosts: &[String]) -> Option<&'static ProviderPreset> {
    PRESETS
        .iter()
        .find(|preset| mx_hosts_match_suffixes(hosts, preset.mx_suffixes))
}

fn unsupported_for_mx_hosts(hosts: &[String]) -> Option<&'static UnsupportedProvider> {
    UNSUPPORTED
        .iter()
        .find(|provider| mx_hosts_match_suffixes(hosts, provider.mx_suffixes))
}

async fn lookup_srv_settings(
    domain: &str,
    email: &str,
) -> Result<Option<(ServerConfig, ServerConfig)>, String> {
    let resolver = TokioResolver::builder_tokio()
        .map_err(|_| "Could not read system DNS settings.".to_string())?
        .build()
        .map_err(|_| "Could not start DNS lookup.".to_string())?;
    let imap = lookup_srv_role(
        &resolver,
        &[
            (format!("_imaps._tcp.{domain}."), TlsMode::Tls),
            (format!("_imap._tcp.{domain}."), TlsMode::StartTls),
        ],
        email,
    )
    .await;
    let Some(imap) = imap else {
        return Ok(None);
    };
    let smtp = lookup_srv_role(
        &resolver,
        &[
            (format!("_submissions._tcp.{domain}."), TlsMode::Tls),
            (format!("_submission._tcp.{domain}."), TlsMode::StartTls),
        ],
        email,
    )
    .await;
    Ok(smtp.map(|smtp| (imap, smtp)))
}

async fn lookup_srv_role(
    resolver: &TokioResolver,
    candidates: &[(String, TlsMode); 2],
    email: &str,
) -> Option<ServerConfig> {
    for (name, tls_mode) in candidates {
        let Ok(Ok(lookup)) =
            tokio::time::timeout(Duration::from_secs(5), resolver.srv_lookup(name.as_str())).await
        else {
            continue;
        };
        let records = lookup
            .answers()
            .iter()
            .filter_map(|record| match &record.data {
                RData::SRV(srv) => Some((srv.priority, srv.weight, srv.port, srv.target.to_utf8())),
                _ => None,
            })
            .collect::<Vec<_>>();
        if let Some(config) = select_srv_server(&records, tls_mode.clone(), email) {
            return Some(config);
        }
    }
    None
}

fn select_srv_server(
    records: &[(u16, u16, u16, String)],
    tls_mode: TlsMode,
    email: &str,
) -> Option<ServerConfig> {
    let mut ordered = records.to_vec();
    ordered.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| right.1.cmp(&left.1)));
    for (_, _, port, target) in ordered {
        let host = target.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() || host == "." || port == 0 || !is_public_dns_name(&host) {
            continue;
        }
        let config = ServerConfig {
            trusted_certificate: None,
            host,
            port,
            tls_mode: tls_mode.clone(),
            username: email.to_string(),
        };
        if validate_server(&config).is_ok() {
            return Some(config);
        }
    }
    None
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
            "password-cleartext" | "plain" | "login"
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
        trusted_certificate: None,
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
    for hop in 0..3 {
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
            if hop == 2 {
                break;
            }
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

    // Failure modes for 0.5.4 provider presets, custom domains, SRV, and autoconfig:
    // 1. Gmail is blocked as unsupported or forces OAuth ProviderKind instead of Manual + App Password.
    // 2. Outlook/M365 or Proton/Tuta MX hosts fall through to NotFound instead of Unsupported.
    // 3. iCloud+ custom domain MX match returns ProviderKind::Icloud, locking out Apple Account username entry.
    // 4. Autoconfig accepts password-encrypted (CRAM-MD5) without plain/login support.
    // 5. SRV discovery accepts ".", port 0, private/internal hosts, or fails to prefer priority/weight.
    // 6. infer_provider_id / strips_password_spaces misclassifies legacy hosts.
    #[test]
    fn expanded_presets_custom_domains_and_srv_rules() {
        use super::{
            discovery_from_preset, infer_provider_id, match_unsupported, preset_for_mx_hosts,
            select_srv_server, strips_password_spaces, unsupported_for_mx_hosts, AppPasswordPolicy,
            PasswordFormat,
        };
        use crate::models::{ProviderKind, TlsMode};

        // Gmail uses Manual + App Password, never ProviderKind::Gmail or Unsupported.
        assert!(match_unsupported("gmail.com").is_none());
        let gmail = match_preset("gmail.com").unwrap();
        assert_eq!(gmail.id, "gmail");
        assert_eq!(gmail.account_provider, ProviderKind::Manual);
        assert_eq!(gmail.app_password_policy, AppPasswordPolicy::Required);
        assert_eq!(gmail.password_format, PasswordFormat::GroupedSpaces);
        assert_eq!(gmail.setup_hint_key, Some("gmail2sv"));

        // Outlook/Hotmail/Live remain Unsupported, including M365 MX.
        assert_eq!(
            match_unsupported("outlook.com").map(|p| p.id),
            Some("outlook")
        );
        assert_eq!(
            unsupported_for_mx_hosts(&["10 contoso-com.mail.protection.outlook.com.".into()])
                .map(|p| p.id),
            Some("outlook")
        );
        assert_eq!(
            match_unsupported("protonmail.ch").map(|p| p.id),
            Some("proton")
        );

        // iCloud domain -> Icloud; iCloud custom domain MX -> Manual + blank usernames + hint.
        assert_eq!(
            match_preset("icloud.com").unwrap().account_provider,
            ProviderKind::Icloud
        );
        let icloud_mx = preset_for_mx_hosts(&["10 mx01.mail.icloud.com.".into()]).unwrap();
        assert_eq!(icloud_mx.id, "icloud");
        assert_eq!(icloud_mx.account_provider, ProviderKind::Manual);
        assert_eq!(icloud_mx.setup_hint_key, Some("icloudCustomDomain"));
        if let super::MailSettingsDiscovery::Found { imap, smtp, .. } =
            discovery_from_preset(icloud_mx, "alice@custom.example", "mx")
        {
            assert_eq!(imap.username, "");
            assert_eq!(smtp.username, "");
        } else {
            panic!("expected found discovery");
        }

        // Fastmail custom domain MX keeps Manual + fastmailCustomDomain hint.
        let fm_mx = preset_for_mx_hosts(&["10 in1-smtp.messagingengine.com.".into()]).unwrap();
        assert_eq!(fm_mx.setup_hint_key, Some("fastmailCustomDomain"));

        // Expanded presets.
        assert_eq!(match_preset("web.de").map(|p| p.id), Some("webde"));
        assert_eq!(match_preset("gmx.de").map(|p| p.id), Some("gmx"));
        assert_eq!(match_preset("posteo.de").map(|p| p.id), Some("posteo"));
        assert_eq!(
            match_preset("purelymail.com").map(|p| p.id),
            Some("purelymail")
        );
        assert_eq!(
            match_preset("startmail.com").map(|p| p.id),
            Some("startmail")
        );
        assert_eq!(match_preset("ik.me").map(|p| p.id), Some("infomaniak"));
        assert_eq!(
            match_preset("mailfence.com").map(|p| p.id),
            Some("mailfence")
        );
        assert_eq!(match_preset("runbox.com").map(|p| p.id), Some("runbox"));
        assert_eq!(
            preset_for_mx_hosts(&["10 aspmx1.migadu.com.".into()]).map(|p| p.id),
            Some("migadu")
        );

        // Autoconfig rejects CRAM-MD5-only password-encrypted.
        let cram_only = br#"<?xml version="1.0"?>
          <clientConfig><emailProvider id="example.test">
            <incomingServer type="imap"><hostname>imap.example.test</hostname><port>993</port><socketType>SSL</socketType><authentication>password-encrypted</authentication><username>%EMAILADDRESS%</username></incomingServer>
            <outgoingServer type="smtp"><hostname>smtp.example.test</hostname><port>587</port><socketType>STARTTLS</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></outgoingServer>
          </emailProvider></clientConfig>"#;
        assert!(parse_autoconfig(cram_only, "reader@example.test").is_err());

        // SRV selection: ignores ".", port 0, private/non-public hosts; picks lowest priority.
        let srv = select_srv_server(
            &[
                (0, 1, 993, ".".into()),
                (5, 1, 0, "imap.example.test.".into()),
                (5, 1, 993, "imap.local.".into()),
                (20, 10, 993, "backup.example.test.".into()),
                (10, 5, 993, "primary.example.test.".into()),
            ],
            TlsMode::Tls,
            "reader@example.test",
        )
        .unwrap();
        assert_eq!(srv.host, "primary.example.test");
        assert_eq!(srv.port, 993);

        // Provider inference & space-stripping.
        assert_eq!(
            infer_provider_id(&ProviderKind::Manual, "imap.gmail.com").as_deref(),
            Some("gmail")
        );
        assert_eq!(
            infer_provider_id(&ProviderKind::Icloud, "imap.mail.me.com").as_deref(),
            Some("icloud")
        );
        assert!(strips_password_spaces(&ProviderKind::Manual, Some("gmail")));
        assert!(!strips_password_spaces(&ProviderKind::Manual, None));
    }
}
