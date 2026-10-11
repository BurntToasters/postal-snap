use super::{db_error, replace_attachment_refs, Database, DraftSyncRecord};
use rusqlite::{params, OptionalExtension};

use crate::models::{ComposeDraft, DraftSummary};

impl Database {
    pub fn save_draft(&self, draft: &ComposeDraft) -> Result<String, String> {
        let id = draft
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut stored = draft.clone();
        stored.id = Some(id.clone());
        let mut conn = self.conn()?;
        let existing: Option<(String, u32)> = conn
            .query_row(
                "SELECT account_id,revision FROM drafts WHERE id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        if existing
            .as_ref()
            .map(|value| value.0.as_str())
            .is_some_and(|account_id| account_id != draft.account_id)
        {
            return Err("Draft does not belong to this account.".into());
        }
        stored.html_body = crate::html_sanitize::sanitize_compose_html(&stored.html_body);
        let json =
            serde_json::to_string(&stored).map_err(|_| "Could not save draft.".to_string())?;
        let revision = existing.map_or(1, |value| value.1.saturating_add(1));
        let remote_message_id = format!("<draft-{id}-{revision}@run.rosie.snap>");
        let transaction = conn.transaction().map_err(db_error)?;
        transaction.execute(
            "INSERT INTO drafts(id,account_id,draft_json,updated_at,sync_state,remote_message_id,revision,deleted_at,
             body_format,source_message_id,source_kind)
             VALUES(?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'localPending',?4,?5,NULL,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,updated_at=excluded.updated_at,
             sync_state='localPending',sync_detail=NULL,remote_message_id=excluded.remote_message_id,
             revision=excluded.revision,deleted_at=NULL,body_format=excluded.body_format,
             source_message_id=excluded.source_message_id,source_kind=excluded.source_kind",
            params![
                id,
                draft.account_id,
                json,
                remote_message_id,
                revision,
                stored.body_format.as_str(),
                stored.source_message_id,
                stored.source_kind.map(|kind| kind.as_str()),
            ],
        ).map_err(db_error)?;
        replace_attachment_refs(
            &transaction,
            &draft.account_id,
            "draft",
            &id,
            &stored.attachments,
        )?;
        transaction.commit().map_err(db_error)?;
        Ok(id)
    }

    pub fn list_drafts(&self, account_id: &str) -> Result<Vec<DraftSummary>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                // Older rows hold SQLite's "YYYY-MM-DD HH:MM:SS" (UTC, no zone)
                // and imports hold RFC 3339; normalize both so the list sorts
                // by time and JavaScript does not read them as local time.
                "SELECT id,draft_json,COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),updated_at),
                 sync_state,sync_detail FROM drafts
                 WHERE account_id=?1 AND (deleted_at IS NULL OR sync_state='deletePending')
                 ORDER BY datetime(updated_at) DESC",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows.into_iter()
            .map(|(id, json, updated_at, sync_state, sync_detail)| {
                let draft: ComposeDraft = serde_json::from_str(&json)
                    .map_err(|_| "A saved draft could not be read.".to_string())?;
                Ok(DraftSummary {
                    id,
                    account_id: account_id.to_string(),
                    recipients: draft.to.join(", "),
                    subject: draft.subject,
                    updated_at,
                    sync_state,
                    sync_detail,
                    preview: draft_preview(&draft.text_body, &draft.html_body),
                    attachment_count: draft_file_count(&draft.attachments),
                    from_address: draft_from_address(draft.from.as_deref()),
                    source_message_id: draft.source_message_id,
                    source_kind: draft.source_kind,
                })
            })
            .collect()
    }

    pub fn draft(&self, id: &str, account_id: &str) -> Result<ComposeDraft, String> {
        let json: String = self
            .conn()?
            .query_row(
                "SELECT draft_json FROM drafts WHERE id=?1 AND account_id=?2 AND (deleted_at IS NULL OR sync_state='deletePending')",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Draft not found.".to_string())?;
        let mut draft: ComposeDraft = serde_json::from_str(&json)
            .map_err(|_| "This saved draft could not be read.".to_string())?;
        draft.html_body = crate::html_sanitize::sanitize_compose_html(&draft.html_body);
        Ok(draft)
    }

    pub fn remove_draft(&self, id: &str, account_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let remote_uid: Option<Option<u32>> = transaction
            .query_row(
                "SELECT remote_uid FROM drafts WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        match remote_uid {
            Some(Some(_)) => {
                transaction
                    .execute(
                        "UPDATE drafts SET deleted_at=CURRENT_TIMESTAMP,sync_state='deletePending',sync_detail=NULL WHERE id=?1 AND account_id=?2",
                        params![id, account_id],
                    )
                    .map_err(db_error)?;
            }
            Some(None) => {
                transaction
                    .execute(
                        "DELETE FROM attachment_refs WHERE owner_kind='draft' AND owner_id=?1",
                        [id],
                    )
                    .map_err(db_error)?;
                transaction
                    .execute(
                        "DELETE FROM drafts WHERE id=?1 AND account_id=?2",
                        params![id, account_id],
                    )
                    .map_err(db_error)?;
            }
            None => return Err("Draft not found.".into()),
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn pending_draft_sync(&self, account_id: &str) -> Result<Vec<DraftSyncRecord>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id,draft_json,remote_mailbox,remote_uid,remote_uid_validity,
                 COALESCE(remote_message_id,''),revision,deleted_at IS NOT NULL
                 FROM drafts WHERE account_id=?1 AND sync_state IN ('localPending','deletePending','localOnly')
                 ORDER BY datetime(updated_at)",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<u32>>(3)?,
                    row.get::<_, Option<u32>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, u32>(6)?,
                    row.get::<_, bool>(7)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows.into_iter()
            .map(
                |(
                    id,
                    json,
                    remote_mailbox,
                    remote_uid,
                    remote_uid_validity,
                    remote_message_id,
                    revision,
                    deleted,
                )| {
                    let draft = serde_json::from_str(&json)
                        .map_err(|_| "A saved draft could not be synchronized.".to_string())?;
                    Ok(DraftSyncRecord {
                        id,
                        draft,
                        remote_mailbox,
                        remote_uid,
                        remote_uid_validity,
                        remote_message_id,
                        revision,
                        deleted,
                    })
                },
            )
            .collect()
    }

    pub fn set_draft_sync_warning(&self, account_id: &str, detail: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE drafts SET sync_state='localOnly',sync_detail=?2
                 WHERE account_id=?1 AND sync_state IN ('localPending','localOnly') AND deleted_at IS NULL",
                params![account_id, detail],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn set_one_draft_sync_warning(
        &self,
        id: &str,
        account_id: &str,
        detail: &str,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE drafts SET sync_state='localOnly',sync_detail=?3
                 WHERE id=?1 AND account_id=?2",
                params![id, account_id, detail],
            )
            .map_err(db_error)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_draft_synced(
        &self,
        id: &str,
        account_id: &str,
        mailbox: &str,
        uid: u32,
        uid_validity: Option<u32>,
        message_id: &str,
        revision: u32,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE drafts SET sync_state='synced',sync_detail=NULL,remote_mailbox=?3,remote_uid=?4,
                 remote_uid_validity=?5,remote_message_id=?6 WHERE id=?1 AND account_id=?2 AND revision=?7",
                params![id, account_id, mailbox, uid, uid_validity, message_id, revision],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn finish_remote_draft_delete(&self, id: &str, account_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM attachment_refs WHERE owner_kind='draft' AND owner_id=?1",
                [id],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM drafts WHERE id=?1 AND account_id=?2 AND deleted_at IS NOT NULL",
                params![id, account_id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn remote_draft_uids(
        &self,
        account_id: &str,
        mailbox: &str,
        uid_validity: Option<u32>,
    ) -> Result<std::collections::HashSet<u32>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT remote_uid FROM drafts WHERE account_id=?1 AND remote_mailbox=?2
                 AND remote_uid_validity IS ?3 AND remote_uid IS NOT NULL",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![account_id, mailbox, uid_validity], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>()
            .map_err(db_error)
    }

    pub fn draft_sync_state(
        &self,
        id: &str,
        account_id: &str,
    ) -> Result<Option<(String, u32)>, String> {
        self.conn()?
            .query_row(
                "SELECT sync_state,revision FROM drafts WHERE id=?1 AND account_id=?2",
                params![id, account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn import_remote_draft(
        &self,
        id: &str,
        draft: &ComposeDraft,
        mailbox: &str,
        uid: u32,
        uid_validity: Option<u32>,
        message_id: Option<&str>,
        revision: u32,
        updated_at: &str,
        sync_state: &str,
        sync_detail: Option<&str>,
    ) -> Result<String, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        // Draft IDs come from a Message-ID the server returned. The same ID in
        // another account's Drafts folder (shared mailbox, copied draft) must
        // never overwrite that account's row; import it as a new draft.
        let owner: Option<String> = transaction
            .query_row("SELECT account_id FROM drafts WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)?;
        let id = match owner {
            Some(owner) if owner != draft.account_id => uuid::Uuid::new_v4().to_string(),
            _ => id.to_string(),
        };
        let id = id.as_str();
        let mut stored = draft.clone();
        stored.id = Some(id.to_string());
        let json = serde_json::to_string(&stored)
            .map_err(|_| "Could not save a server draft.".to_string())?;
        transaction
            .execute(
                "INSERT INTO drafts(id,account_id,draft_json,updated_at,sync_state,sync_detail,
                 remote_mailbox,remote_uid,remote_uid_validity,remote_message_id,revision,deleted_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL)
                 ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,updated_at=excluded.updated_at,
                 sync_state=excluded.sync_state,sync_detail=excluded.sync_detail,
                 remote_mailbox=excluded.remote_mailbox,remote_uid=excluded.remote_uid,
                 remote_uid_validity=excluded.remote_uid_validity,
                 remote_message_id=excluded.remote_message_id,revision=excluded.revision,deleted_at=NULL
                 WHERE drafts.account_id=excluded.account_id",
                params![
                    id,
                    draft.account_id,
                    json,
                    updated_at,
                    sync_state,
                    sync_detail,
                    mailbox,
                    uid,
                    uid_validity,
                    message_id,
                    revision,
                ],
            )
            .map_err(db_error)?;
        replace_attachment_refs(
            &transaction,
            &draft.account_id,
            "draft",
            id,
            &stored.attachments,
        )?;
        transaction.commit().map_err(db_error)?;
        Ok(id.to_string())
    }

    pub fn update_remote_draft_tracking(
        &self,
        id: &str,
        account_id: &str,
        mailbox: &str,
        uid: u32,
        uid_validity: Option<u32>,
        message_id: Option<&str>,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE drafts SET remote_mailbox=?3,remote_uid=?4,remote_uid_validity=?5,remote_message_id=?6 WHERE id=?1 AND account_id=?2",
                params![id, account_id, mailbox, uid, uid_validity, message_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn reconcile_remote_drafts(
        &self,
        account_id: &str,
        mailbox: &str,
        uid_validity: Option<u32>,
        server_uids: &std::collections::HashSet<u32>,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let ids = {
            let mut statement = conn
                .prepare(
                    "SELECT id,remote_uid FROM drafts WHERE account_id=?1 AND remote_mailbox=?2
                     AND remote_uid_validity IS ?3 AND sync_state IN ('synced','conflict')",
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(params![account_id, mailbox, uid_validity], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            rows
        };
        let transaction = conn.transaction().map_err(db_error)?;
        for (id, _) in ids
            .into_iter()
            .filter(|(_, uid)| !server_uids.contains(uid))
        {
            transaction
                .execute(
                    "DELETE FROM attachment_refs WHERE owner_kind='draft' AND owner_id=?1",
                    [&id],
                )
                .map_err(db_error)?;
            transaction
                .execute("DELETE FROM drafts WHERE id=?1", [&id])
                .map_err(db_error)?;
        }
        // Rows tracked under a previous UIDVALIDITY generation belong to a
        // deleted server mailbox incarnation. Drop them so the next import
        // starts clean instead of duplicating foreign drafts.
        let stale: Vec<String> = transaction
            .prepare(
                "SELECT id FROM drafts WHERE account_id=?1 AND remote_mailbox=?2
                 AND NOT (remote_uid_validity IS ?3) AND sync_state IN ('synced','conflict')",
            )
            .map_err(db_error)?
            .query_map(params![account_id, mailbox, uid_validity], |row| row.get(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for id in stale {
            transaction
                .execute(
                    "DELETE FROM attachment_refs WHERE owner_kind='draft' AND owner_id=?1",
                    [&id],
                )
                .map_err(db_error)?;
            transaction
                .execute("DELETE FROM drafts WHERE id=?1", [&id])
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }
}

const PREVIEW_CHARS: usize = 180;

/// The first line a person wrote. Quoted reply lines and script blocks stay out.
pub(crate) fn draft_preview(text_body: &str, html_body: &str) -> String {
    let plain = if text_body.trim().is_empty() {
        html_to_plain(html_body)
    } else {
        text_body.to_string()
    };
    let line = plain
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('>'))
        .unwrap_or("");
    let cleaned = line
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    cleaned.chars().take(PREVIEW_CHARS).collect()
}

fn html_to_plain(html: &str) -> String {
    let without_script = strip_element(html, "script");
    let without_style = strip_element(&without_script, "style");
    let mut out = String::new();
    let mut chars = without_style.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '<' {
            let mut tag = String::new();
            for inner in chars.by_ref() {
                if inner == '>' {
                    break;
                }
                tag.push(inner);
            }
            let name = tag
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_start_matches('/')
                .to_ascii_lowercase();
            if matches!(
                name.as_str(),
                "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "blockquote"
            ) {
                out.push('\n');
            }
            continue;
        }
        if character == '&' {
            let mut entity = String::new();
            while let Some(next) = chars.peek() {
                if *next == ';' || entity.len() > 12 {
                    break;
                }
                entity.push(chars.next().unwrap());
            }
            if chars.peek() == Some(&';') {
                chars.next();
                out.push_str(&decode_entity(&entity));
            } else {
                out.push('&');
                out.push_str(&entity);
            }
            continue;
        }
        out.push(character);
    }
    out
}

fn strip_element(html: &str, name: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut out = String::new();
    let mut rest = html;
    let mut lower_rest = lower.as_str();
    while let Some(start) = lower_rest.find(&open) {
        out.push_str(&rest[..start]);
        let after_open = start + open.len();
        let Some(relative_end) = lower_rest[after_open..].find(&close) else {
            return out;
        };
        let next = after_open + relative_end + close.len();
        rest = &rest[next..];
        lower_rest = &lower_rest[next..];
    }
    out.push_str(rest);
    out
}

pub(crate) fn draft_file_count(attachments: &[crate::models::ComposeAttachment]) -> usize {
    attachments.iter().filter(|item| !item.inline).count()
}

fn draft_from_address(from: Option<&str>) -> String {
    from.unwrap_or("").trim().to_string()
}

fn decode_entity(entity: &str) -> String {
    match entity {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        "nbsp" => " ".into(),
        _ => decode_numeric_entity(entity).unwrap_or_else(|| format!("&{entity};")),
    }
}

fn decode_numeric_entity(entity: &str) -> Option<String> {
    let hex = entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"));
    let code = if let Some(digits) = hex {
        u32::from_str_radix(digits, 16).ok()?
    } else {
        let digits = entity.strip_prefix('#')?;
        digits.parse::<u32>().ok()?
    };
    char::from_u32(code).map(|character| character.to_string())
}

#[cfg(test)]
mod tests {
    use super::{draft_file_count, draft_from_address, draft_preview};
    use crate::models::ComposeAttachment;

    fn file(inline: bool) -> ComposeAttachment {
        ComposeAttachment {
            token: "token".into(),
            filename: "notes.txt".into(),
            content_type: None,
            inline,
            content_id: None,
            size: Some(4),
        }
    }

    #[test]
    fn draft_from_address_keeps_a_saved_address() {
        assert_eq!(draft_from_address(None), "");
        assert_eq!(draft_from_address(Some("  ")), "");
        assert_eq!(
            draft_from_address(Some(" alias@example.com ")),
            "alias@example.com"
        );
    }

    #[test]
    fn draft_file_count_skips_pictures_in_the_letter() {
        assert_eq!(draft_file_count(&[]), 0);
        assert_eq!(draft_file_count(&[file(true)]), 0);
        assert_eq!(draft_file_count(&[file(false), file(true)]), 1);
    }

    #[test]
    fn draft_preview_keeps_the_written_line() {
        assert_eq!(draft_preview("   ", "   "), "");
        assert_eq!(
            draft_preview("Thanks for the note\n\n> older line", ""),
            "Thanks for the note"
        );
        assert_eq!(
            draft_preview(
                "",
                "<script>alert(1)</script><style>p{}</style><p>Hello&amp; welcome</p><blockquote>old</blockquote>"
            ),
            "Hello& welcome"
        );
        let long = "a".repeat(200);
        assert_eq!(draft_preview(&long, "").chars().count(), 180);
        assert_eq!(draft_preview("Line\u{0007} two", ""), "Line two");
        assert_eq!(draft_preview("", "<p>&#39;Yes&#39;</p>"), "'Yes'");
    }
}
