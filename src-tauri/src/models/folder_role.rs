use super::dto::MailboxRole;

pub const ROLE_SOURCE_SPECIAL_USE: &str = "specialUse";
pub const ROLE_SOURCE_NAME: &str = "name";

#[allow(dead_code)]
pub fn mailbox_role(name: &str, attributes: &[String]) -> MailboxRole {
    mailbox_role_assignment(name, attributes).0
}

pub fn mailbox_role_assignment(name: &str, attributes: &[String]) -> (MailboxRole, &'static str) {
    let special_use = mailbox_role_from_attributes(attributes);
    if special_use != MailboxRole::Other {
        return (special_use, ROLE_SOURCE_SPECIAL_USE);
    }
    (mailbox_role_from_name(name), ROLE_SOURCE_NAME)
}

fn mailbox_role_from_attributes(attributes: &[String]) -> MailboxRole {
    let has = |expected: &str| {
        attributes.iter().any(|attribute| {
            attribute
                .trim()
                .trim_start_matches('\\')
                .eq_ignore_ascii_case(expected)
        })
    };
    if has("inbox") {
        return MailboxRole::Inbox;
    }
    if has("sent") {
        return MailboxRole::Sent;
    }
    if has("drafts") {
        return MailboxRole::Drafts;
    }
    if has("archive") || has("all") {
        return MailboxRole::Archive;
    }
    if has("trash") {
        return MailboxRole::Trash;
    }
    if has("junk") || has("spam") {
        return MailboxRole::Junk;
    }
    MailboxRole::Other
}

pub fn is_all_mail_folder(name: &str, attributes: &[String]) -> bool {
    let has_all = attributes.iter().any(|attribute| {
        attribute
            .trim()
            .trim_start_matches('\\')
            .eq_ignore_ascii_case("all")
    });
    if has_all {
        return true;
    }
    let normalized = name.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "all mail"
            | "alle e-mails"
            | "tous les messages"
            | "[gmail]/all mail"
            | "[google mail]/all mail"
    )
}

fn role_lookup_segment(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if let Some((prefix, leaf)) = trimmed.rsplit_once(['/', '.']) {
        let ns = prefix.to_ascii_lowercase();
        let allowed_ns = matches!(
            ns.as_str(),
            "inbox" | "[gmail]" | "[google mail]" | "folders" | "labels"
        );
        if !allowed_ns {
            return None;
        }
        Some(leaf.to_ascii_lowercase())
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn mailbox_role_from_name(name: &str) -> MailboxRole {
    let Some(leaf) = role_lookup_segment(name) else {
        return MailboxRole::Other;
    };
    let in_gmail = name.to_ascii_lowercase().starts_with("[gmail]/")
        || name.to_ascii_lowercase().starts_with("[google mail]/");
    match leaf.as_str() {
        "inbox" | "posteingang" | "boîte de réception" => MailboxRole::Inbox,
        "sent" | "sent messages" | "sent mail" | "sent items" | "gesendet" | "gesendete"
        | "gesendete objekte" | "messages envoyés" | "enviados" => MailboxRole::Sent,
        "draft" | "drafts" | "entwürfe" | "entwurfe" | "brouillons" | "borradores" => {
            MailboxRole::Drafts
        }
        "archive" | "archiv" | "archivados" => MailboxRole::Archive,
        "all mail" | "alle e-mails" | "tous les messages" => {
            if !name.contains(['/', '.']) || in_gmail {
                MailboxRole::Archive
            } else {
                MailboxRole::Other
            }
        }
        "trash" | "deleted" | "deleted messages" | "deleted items" | "bin" | "papierkorb"
        | "gelöscht" | "geloscht" | "gelöschte objekte" | "corbeille" | "papelera" => {
            MailboxRole::Trash
        }
        "junk" | "spam" | "bulk" | "bulk mail" | "junk email" | "junk e-mail" | "spamverdacht"
        | "indésirables" | "correo no deseado" => MailboxRole::Junk,
        _ => MailboxRole::Other,
    }
}
