use super::*;

#[test]
fn icloud_uses_local_part_for_imap_and_full_address_for_smtp() {
    let request = AccountSetupRequest {
        certificate_reference: None,
        provider: ProviderKind::Icloud,
        email: "Jane@icloud.com".into(),
        display_name: "Jane".into(),
        password: "secret".into(),
        imap: None,
        smtp: None,
        cache_policy: None,
    };
    let (imap, smtp) = validated_setup(&request).unwrap();
    assert_eq!(imap.username, "jane");
    assert_eq!(smtp.username, "jane@icloud.com");
    assert_eq!(smtp.tls_mode, TlsMode::StartTls);
}

#[test]
fn maps_special_use_before_fallback_names() {
    assert_eq!(mailbox_role("Bin", &["Trash".into()]), MailboxRole::Trash);
    assert_eq!(mailbox_role("Bin", &["\\Trash".into()]), MailboxRole::Trash);
    assert_eq!(mailbox_role("Folder/Sent Messages", &[]), MailboxRole::Sent);
}

#[test]
fn manual_setup_rejects_unsafe_or_incomplete_servers() {
    let request = AccountSetupRequest {
        certificate_reference: None,
        provider: ProviderKind::Manual,
        email: "sam@example.com".into(),
        display_name: "Sam".into(),
        password: "secret".into(),
        imap: Some(ServerConfig {
            trusted_certificate: None,
            host: "http://imap.example.com".into(),
            port: 143,
            tls_mode: TlsMode::StartTls,
            username: "sam".into(),
        }),
        smtp: Some(ServerConfig {
            trusted_certificate: None,
            host: "smtp.example.com".into(),
            port: 587,
            tls_mode: TlsMode::StartTls,
            username: "sam".into(),
        }),
        cache_policy: None,
    };
    assert!(validated_setup(&request).is_err());
}

#[test]
fn server_names_reject_credentials_ports_and_paths() {
    let valid = |host: &str| {
        validate_server(&ServerConfig {
            trusted_certificate: None,
            host: host.into(),
            port: 993,
            tls_mode: TlsMode::Tls,
            username: "sam".into(),
        })
        .is_ok()
    };
    assert!(valid("imap.example.com"));
    assert!(valid("mail"));
    assert!(valid("192.0.2.10"));
    assert!(valid("::1"));
    assert!(!valid("user@imap.example.com"));
    assert!(!valid("imap.example.com:993"));
    assert!(!valid("http://imap.example.com"));
    assert!(!valid("imap.example.com/path"));
    assert!(!valid("imap example.com"));
    assert!(!valid("-imap.example.com"));
    assert!(!valid(""));
}

#[test]
fn compose_limits_reject_header_injection_and_excessive_recipients() {
    let mut draft = ComposeDraft {
        body_format: crate::models::BodyFormat::Html,
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
        subject: "Hello\r\nBcc: attacker@example.com".into(),
        html_body: "<p>Hello</p>".into(),
        text_body: "Hello".into(),
        attachments: vec![],
        in_reply_to: None,
        references: None,
        send_at: None,
    };
    assert!(validate_compose_draft(&draft).is_err());
    draft.subject = "Hello".into();
    draft.to = vec!["a@example.com".into(); 501];
    assert!(validate_compose_draft(&draft).is_err());
}

#[test]
fn compose_rejects_an_invalid_reply_to() {
    // Failure modes:
    // 1. A two-address Reply-To is accepted.
    // 2. An unparsable Reply-To is accepted and silently dropped.
    // 3. A Reply-To with a control character is accepted.
    // 4. A Reply-To over 320 characters is accepted.
    // 5. A valid Reply-To or an empty one is rejected.
    let mut draft = ComposeDraft {
        body_format: crate::models::BodyFormat::Plain,
        source_message_id: None,
        source_kind: None,
        include_signature: true,
        importance: String::new(),
        request_receipt: false,
        reply_to: Some("a@example.com, b@example.com".into()),
        id: None,
        account_id: "account-1".into(),
        from: None,
        to: vec!["jane@example.com".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hello".into(),
        html_body: String::new(),
        text_body: "Hello".into(),
        attachments: vec![],
        in_reply_to: None,
        references: None,
        send_at: None,
    };
    let message = Err("Enter one Reply-To address.".to_string());
    assert_eq!(validate_compose_draft(&draft), message);
    draft.reply_to = Some("not an address".into());
    assert_eq!(validate_compose_draft(&draft), message);
    draft.reply_to = Some("a@example.com\r\nBcc: x@example.com".into());
    assert_eq!(validate_compose_draft(&draft), message);
    draft.reply_to = Some(format!("{}@example.com", "a".repeat(320)));
    assert_eq!(validate_compose_draft(&draft), message);
    draft.reply_to = Some("Ada <ada@example.com>".into());
    assert!(validate_compose_draft(&draft).is_ok());
    draft.reply_to = Some("   ".into());
    assert!(validate_compose_draft(&draft).is_ok());
    draft.reply_to = None;
    assert!(validate_compose_draft(&draft).is_ok());
}

#[test]
fn ipc_errors_are_structured_and_hide_attachment_names() {
    let ownership = IpcError::from("Message does not belong to this account.");
    assert_eq!(ownership.code, "accessDenied");
    assert!(!ownership.retryable);
    let attachment = IpcError::from("Attachment 'private-name.pdf' is unavailable.");
    assert_eq!(attachment.code, "operationFailed");
    assert!(!attachment.message.contains("private-name.pdf"));
    let connection = IpcError::from("Incoming connection failed.");
    assert_eq!(connection.code, "connectionFailed");
    assert!(connection.retryable);
    let auth = IpcError::from("IMAP sign-in was rejected.");
    assert_eq!(auth.code, "authenticationFailed");
    assert!(auth.message.contains("password"));
    assert!(!auth.message.contains("app-specific"));
    let redacted_auth = IpcError::from(
        "Incoming sign-in failed. Check the server settings, password, and internet connection.",
    );
    assert_eq!(redacted_auth.code, "authenticationFailed");
    let redacted_conn = IpcError::from(
        "Incoming connection failed. Check the server settings, password, and internet connection.",
    );
    assert_eq!(redacted_conn.code, "connectionFailed");
    let redacted_move = IpcError::from(
        "Move failed. Check the server settings, password, and internet connection.",
    );
    assert_eq!(redacted_move.code, "operationFailed");
    let redacted_plain = IpcError::from(crate::security::redact_error(
        &"secret host",
        "Incoming sign-in",
    ));
    assert_eq!(redacted_plain.code, "authenticationFailed");
}

// Failure modes for passing authored error text through IPC:
// 1. A specific, actionable message collapses to "Try again".
// 2. An address, file name, host, or path reaches the UI.
// 3. Quoted server text or a template value slips through.
// 4. Non-ASCII or oversized text reaches the UI.
#[test]
fn ipc_errors_keep_authored_text_and_hide_data() {
    let duplicate = IpcError::from("An account with this email address is already set up.");
    assert_eq!(
        duplicate.message,
        "An account with this email address is already set up."
    );
    let restart = IpcError::from(
        "Postal Snap could not safely finish updating this password. Restart Postal Snap before trying again.",
    );
    assert!(restart.message.contains("Restart Postal Snap"));
    assert!(IpcError::from("This message isn't ready.")
        .message
        .contains("isn't"));
    for leaky in [
        "Could not send to jane@example.com.",
        "Attachment 'private-name.pdf' is unavailable.",
        "Could not open C:\\Users\\jane\\mail.eml.",
        "Could not reach imap.example.com right now.",
        "Server said: \"NO quota\"",
        "Folder [Gmail] failed.",
        "Ordner geöffnet.",
    ] {
        let error = IpcError::from(leaky);
        assert!(!error.message.contains("jane"), "{leaky}");
        assert!(!error.message.contains("private-name"), "{leaky}");
        assert!(!error.message.contains("example.com"), "{leaky}");
        assert!(!error.message.contains("quota"), "{leaky}");
        assert!(!error.message.contains("Gmail"), "{leaky}");
        assert!(!error.message.contains("Ordner"), "{leaky}");
    }
    assert!(!IpcError::from("x".repeat(400)).message.contains("xxxx"));
}

#[test]
fn compose_from_must_belong_to_the_account() {
    assert!(validate_compose_sender(None, "sam@example.com", &[]).is_ok());
    assert!(validate_compose_sender(Some("sam@example.com"), "sam@example.com", &[]).is_ok());
    assert!(validate_compose_sender(
        Some("Sam <family@icloud.com>"),
        "sam@example.com",
        &["family@icloud.com".into()]
    )
    .is_ok());
    assert!(validate_compose_sender(Some("attacker@example.com"), "sam@example.com", &[]).is_err());
}

#[test]
fn settings_errors_use_safe_actionable_categories() {
    assert_eq!(
        IpcError::from("Settings export is invalid or unsupported.").code,
        "settingsInvalid"
    );
    assert_eq!(
        IpcError::from("Settings file is too large.").code,
        "settingsTooLarge"
    );
    assert_eq!(
        IpcError::from("Could not replace application settings.").code,
        "settingsWriteFailed"
    );
    assert_eq!(
        IpcError::from("Settings file was not found.").code,
        "settingsNotFound"
    );
    assert_eq!(
        IpcError::from("Could not read application settings.").code,
        "settingsReadFailed"
    );
    assert_eq!(
        IpcError::from("Invalid application settings.").code,
        "settingsInvalid"
    );
    assert_eq!(
        IpcError::from("Saved application settings could not be migrated.").code,
        "settingsMigrationFailed"
    );
    assert_eq!(
        IpcError::from("Could not create application data directory.").code,
        "localStorageFailed"
    );
    assert_eq!(
        IpcError::from("The system password vault is unavailable.").code,
        "localStorageFailed"
    );
    assert_eq!(
        IpcError::from("The system password vault could not save this account.").code,
        "localStorageFailed"
    );
    assert_eq!(
        IpcError::from(
            "The password is unavailable. Remove and add this account again.".to_string()
        )
        .code,
        "localStorageFailed"
    );
}

#[test]
fn icloud_accepts_me_and_mac_addresses() {
    for email in ["Pat@me.com", "pat@mac.com"] {
        let request = AccountSetupRequest {
            certificate_reference: None,
            provider: ProviderKind::Icloud,
            email: email.into(),
            display_name: "Pat".into(),
            password: "secret".into(),
            imap: None,
            smtp: None,
            cache_policy: None,
        };
        let (imap, smtp) = validated_setup(&request).unwrap();
        assert_eq!(imap.username, "pat");
        assert_eq!(smtp.username, email.to_ascii_lowercase());
        assert_eq!(imap.host, "imap.mail.me.com");
        assert_eq!(smtp.host, "smtp.mail.me.com");
    }
}

#[test]
fn take_validated_setup_keeps_password_until_after_validation() {
    let mut request = AccountSetupRequest {
        certificate_reference: None,
        provider: ProviderKind::Icloud,
        email: "jane@icloud.com".into(),
        display_name: "Jane".into(),
        password: "abcd efgh ijkl mnop".into(),
        imap: None,
        smtp: None,
        cache_policy: None,
    };
    let (_, _, password) = take_validated_setup(&mut request).unwrap();
    assert_eq!(password.as_str(), "abcdefghijklmnop");
    assert!(request.password.is_empty());
}

#[test]
fn take_validated_setup_rejects_whitespace_only_icloud_password() {
    let mut request = AccountSetupRequest {
        certificate_reference: None,
        provider: ProviderKind::Icloud,
        email: "jane@icloud.com".into(),
        display_name: "Jane".into(),
        password: " \t  ".into(),
        imap: None,
        smtp: None,
        cache_policy: None,
    };
    assert!(take_validated_setup(&mut request).is_err());
}

#[test]
fn taking_password_before_validation_would_fail() {
    let mut request = AccountSetupRequest {
        certificate_reference: None,
        provider: ProviderKind::Icloud,
        email: "jane@icloud.com".into(),
        display_name: "Jane".into(),
        password: "secret".into(),
        imap: None,
        smtp: None,
        cache_policy: None,
    };
    let _taken = std::mem::take(&mut request.password);
    assert!(validated_setup(&request).is_err());
}

#[test]
fn manual_setup_trims_password_without_removing_internal_spaces() {
    let mut request = AccountSetupRequest {
        certificate_reference: None,
        provider: ProviderKind::Manual,
        email: "sam@example.com".into(),
        display_name: "Sam".into(),
        password: "  phrase with spaces  ".into(),
        imap: Some(ServerConfig {
            trusted_certificate: None,
            host: "imap.example.com".into(),
            port: 993,
            tls_mode: TlsMode::Tls,
            username: "sam@example.com".into(),
        }),
        smtp: Some(ServerConfig {
            trusted_certificate: None,
            host: "smtp.example.com".into(),
            port: 587,
            tls_mode: TlsMode::StartTls,
            username: "sam@example.com".into(),
        }),
        cache_policy: None,
    };
    let (_, _, password) = take_validated_setup(&mut request).unwrap();
    assert_eq!(password.as_str(), "phrase with spaces");
}

#[test]
fn maps_dot_hierarchy_and_extended_fallback_roles() {
    assert_eq!(mailbox_role("INBOX.Sent", &[]), MailboxRole::Sent);
    assert_eq!(mailbox_role("INBOX.Drafts", &[]), MailboxRole::Drafts);
    assert_eq!(mailbox_role("INBOX.Trash", &[]), MailboxRole::Trash);
    assert_eq!(mailbox_role("Deleted Items", &[]), MailboxRole::Trash);
    assert_eq!(mailbox_role("Sent Items", &[]), MailboxRole::Sent);
    assert_eq!(mailbox_role("Junk Email", &[]), MailboxRole::Junk);
    assert_eq!(mailbox_role("Bin", &[]), MailboxRole::Trash);
}

#[test]
fn maps_gmail_and_international_fallback_roles() {
    assert_eq!(mailbox_role("[Gmail]/Sent Mail", &[]), MailboxRole::Sent);
    assert_eq!(mailbox_role("[Gmail]/All Mail", &[]), MailboxRole::Archive);
    assert_eq!(mailbox_role("Gesendet", &[]), MailboxRole::Sent);
    assert_eq!(mailbox_role("Entwürfe", &[]), MailboxRole::Drafts);
    assert_eq!(mailbox_role("Papierkorb", &[]), MailboxRole::Trash);
}

#[test]
fn folder_names_reject_blanks_reserved_and_control_chars() {
    assert_eq!(validate_folder_name("Receipts").unwrap(), "Receipts");
    assert_eq!(validate_folder_name("Bills 2026").unwrap(), "Bills 2026");
    assert!(validate_folder_name("").is_err());
    assert!(validate_folder_name("   ").is_err());
    assert!(validate_folder_name("INBOX").is_err());
    assert!(validate_folder_name("inbox").is_err());
    assert!(validate_folder_name(" Receipts").is_err());
    assert!(validate_folder_name("Receipts ").is_err());
    assert!(validate_folder_name("a\nb").is_err());
    assert!(validate_folder_name(&"a".repeat(129)).is_err());
    assert!(validate_folder_name("a/b").is_err());
    assert!(validate_folder_name("a*b").is_err());
    assert!(validate_folder_name("a%b").is_err());
    assert!(validate_folder_name("a\"b").is_err());
    assert_eq!(
        nested_folder_name("Projects", "/", "2026").unwrap(),
        "Projects/2026"
    );
    assert_eq!(
        nested_folder_name("Projects/", "/", "Notes").unwrap(),
        "Projects/Notes"
    );
    assert_eq!(
        nested_folder_name("INBOX", ".", "Receipts").unwrap(),
        "INBOX.Receipts"
    );
    assert!(nested_folder_name("Projects", "/", "a/b").is_err());
    assert!(nested_folder_name("Projects", "", "Notes").is_err());
    assert!(nested_folder_name("Projects", "/", "inbox").is_err());
    assert!(nested_folder_name("INBOX", ".", "a.b").is_err());
    assert_eq!(
        renamed_folder_name("Projects/2026", "/", "Notes").unwrap(),
        "Projects/Notes"
    );
    assert_eq!(
        renamed_folder_name("Projects/2026/Launch", "/", "Kickoff").unwrap(),
        "Projects/2026/Kickoff"
    );
    assert_eq!(
        renamed_folder_name("Projects", "/", "Client work").unwrap(),
        "Client work"
    );
    assert!(renamed_folder_name("Projects/2026", "/", "a/b").is_err());
    assert_eq!(
        moved_folder_name("Projects/2026", "/", Some("Archive")).unwrap(),
        "Archive/2026"
    );
    assert_eq!(
        moved_folder_name("Projects/2026", "/", None).unwrap(),
        "2026"
    );
    assert_eq!(
        moved_folder_name("Projects", "/", Some("Archive")).unwrap(),
        "Archive/Projects"
    );
    assert_eq!(
        moved_folder_name("Projects/2026", "/", Some("Projects")).unwrap(),
        "Projects/2026"
    );
    assert!(moved_folder_name("Projects", "/", Some("Projects")).is_err());
    assert!(moved_folder_name("Projects", "/", Some("Projects/2026")).is_err());
}

fn valid_rule() -> FilterRule {
    FilterRule {
        id: String::new(),
        account_id: "account-1".into(),
        name: "Bills".into(),
        field: "from".into(),
        contains: "power".into(),
        action: "move_archive".into(),
        target_mailbox: None,
        enabled: true,
    }
}

#[test]
fn filter_rules_validate_fields_actions_and_ownership() {
    assert!(validate_filter_rule(&valid_rule(), "account-1").is_ok());
    assert!(validate_filter_rule(&valid_rule(), "other").is_err());
    let mut rule = valid_rule();
    rule.field = "body".into();
    assert!(validate_filter_rule(&rule, "account-1").is_err());
    rule.field = "to".into();
    assert!(validate_filter_rule(&rule, "account-1").is_ok());
    rule = valid_rule();
    rule.action = "move_mailbox".into();
    assert!(validate_filter_rule(&rule, "account-1").is_err());
    rule.target_mailbox = Some("".into());
    assert!(validate_filter_rule(&rule, "account-1").is_err());
    rule.target_mailbox = Some("7".into());
    assert!(validate_filter_rule(&rule, "account-1").is_ok());
    rule = valid_rule();
    rule.contains = "   ".into();
    assert!(validate_filter_rule(&rule, "account-1").is_err());
    rule = valid_rule();
    rule.field = "domain".into();
    rule.contains = "example.com".into();
    assert!(validate_filter_rule(&rule, "account-1").is_ok());
    rule.contains = "example".into();
    assert!(validate_filter_rule(&rule, "account-1").is_err());
    rule.contains = "jane@example.com".into();
    assert!(validate_filter_rule(&rule, "account-1").is_err());
}

#[test]
fn timeouts_are_not_authentication_failures() {
    // W6: a slow network must never park the account as "Sign-in failed".
    for transient in [
        "Incoming server timed out.",
        "Incoming connection failed. Check the mail server, password, and internet connection.",
        "Incoming TLS negotiation timed out.",
    ] {
        assert_eq!(
            IpcError::from(transient).code,
            "connectionFailed",
            "{transient}"
        );
    }
    assert_eq!(
        IpcError::from(
            "Incoming sign-in failed. Check the mail server, password, and internet connection."
        )
        .code,
        "authenticationFailed"
    );
}
