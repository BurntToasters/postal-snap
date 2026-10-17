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

fn mailbox_role_from_name(name: &str) -> MailboxRole {
    let leaf = name
        .rsplit(['/', '.'])
        .next()
        .unwrap_or(name)
        .to_ascii_lowercase();
    match leaf.as_str() {
        "inbox" | "posteingang" | "boîte de réception" => MailboxRole::Inbox,
        "sent" | "sent messages" | "sent mail" | "sent items" | "gesendet" | "gesendete"
        | "gesendete objekte" | "messages envoyés" | "enviados" => MailboxRole::Sent,
        "drafts" | "entwürfe" | "entwurfe" | "brouillons" | "borradores" => MailboxRole::Drafts,
        "archive" | "all mail" | "archiv" | "alle e-mails" | "tous les messages" | "archivados" => {
            MailboxRole::Archive
        }
        "trash" | "deleted messages" | "deleted items" | "bin" | "papierkorb"
        | "gelöschte objekte" | "corbeille" | "papelera" => MailboxRole::Trash,
        "junk" | "spam" | "junk email" | "junk e-mail" | "spamverdacht" | "indésirables"
        | "correo no deseado" => MailboxRole::Junk,
        _ => MailboxRole::Other,
    }
}
