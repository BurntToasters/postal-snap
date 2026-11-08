use super::{db_error, map_message_summary, Database, MESSAGE_SUMMARY_SELECT};
use rusqlite::{params, OptionalExtension};

use crate::models::{rule_lists, FilterMatchPreview, FilterRule, MessageSummary};

/// Filter rules one account may keep. Enforced on create and reorder.
const MAX_FILTER_RULES: usize = 200;
const FILTER_RULE_LIMIT_MESSAGE: &str = "Too many rules. You can have up to 200.";

impl Database {
    pub fn list_filter_rules(&self, account_id: &str) -> Result<Vec<FilterRule>, String> {
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare(
                "SELECT id,account_id,name,field,contains,action,target_mailbox,enabled,match_mode,conditions_json,actions_json FROM filter_rules WHERE account_id=?1 ORDER BY position,id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok(normalized(FilterRule {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    name: row.get(2)?,
                    field: row.get(3)?,
                    contains: row.get(4)?,
                    action: row.get(5)?,
                    target_mailbox: row.get(6)?,
                    enabled: row.get::<_, i64>(7)? != 0,
                    match_mode: row.get(8)?,
                    conditions: crate::db::json_or_default(row.get::<_, String>(9)?),
                    actions: crate::db::json_or_default(row.get::<_, String>(10)?),
                }))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    pub fn create_filter_rule(&self, rule: &FilterRule) -> Result<FilterRule, String> {
        let rule = &normalized(rule.clone());
        let id = uuid::Uuid::new_v4().to_string();
        // Count, position, and insert share one writer transaction so two
        // creates cannot read the same MAX(position).
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM filter_rules WHERE account_id=?1",
                [&rule.account_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if count >= MAX_FILTER_RULES as i64 {
            return Err(FILTER_RULE_LIMIT_MESSAGE.into());
        }
        let position: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(position),-1)+1 FROM filter_rules WHERE account_id=?1",
                [&rule.account_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "INSERT INTO filter_rules(id,account_id,name,field,contains,action,target_mailbox,enabled,position,match_mode,conditions_json,actions_json)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    id,
                    rule.account_id,
                    rule.name.trim(),
                    rule.field,
                    rule.contains.trim(),
                    rule.action,
                    rule.target_mailbox,
                    i64::from(rule.enabled),
                    position,
                    rule.match_mode,
                    json_text(&rule.conditions),
                    json_text(&rule.actions),
                ],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(FilterRule {
            id,
            name: rule.name.trim().to_string(),
            ..rule.clone()
        })
    }

    pub fn update_filter_rule(&self, rule: &FilterRule) -> Result<FilterRule, String> {
        let rule = &normalized(rule.clone());
        let changed = self
            .conn()?
            .execute(
                "UPDATE filter_rules SET name=?3,field=?4,contains=?5,action=?6,target_mailbox=?7,enabled=?8,match_mode=?9,conditions_json=?10,actions_json=?11 WHERE id=?1 AND account_id=?2",
                params![
                    rule.id,
                    rule.account_id,
                    rule.name.trim(),
                    rule.field,
                    rule.contains.trim(),
                    rule.action,
                    rule.target_mailbox,
                    i64::from(rule.enabled),
                    rule.match_mode,
                    json_text(&rule.conditions),
                    json_text(&rule.actions),
                ],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("That rule is no longer available.".into());
        }
        Ok(FilterRule {
            name: rule.name.trim().to_string(),
            ..rule.clone()
        })
    }

    pub fn delete_filter_rule(&self, account_id: &str, id: &str) -> Result<(), String> {
        let changed = self
            .conn()?
            .execute(
                "DELETE FROM filter_rules WHERE id=?1 AND account_id=?2",
                params![id, account_id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("That rule is no longer available.".into());
        }
        Ok(())
    }

    /// Persist rule order. `ordered_ids` must list this account's rules once.
    pub fn reorder_filter_rules(
        &self,
        account_id: &str,
        ordered_ids: &[String],
    ) -> Result<Vec<FilterRule>, String> {
        if ordered_ids.len() > MAX_FILTER_RULES {
            return Err(FILTER_RULE_LIMIT_MESSAGE.into());
        }
        let existing = self.list_filter_rules(account_id)?;
        let have: std::collections::HashSet<&str> =
            existing.iter().map(|rule| rule.id.as_str()).collect();
        let requested: std::collections::HashSet<&str> =
            ordered_ids.iter().map(String::as_str).collect();
        if requested.len() != ordered_ids.len() || requested != have {
            return Err("Rule order is invalid.".into());
        }
        {
            let mut conn = self.conn()?;
            let transaction = conn.transaction().map_err(db_error)?;
            for (position, id) in ordered_ids.iter().enumerate() {
                transaction
                    .execute(
                        "UPDATE filter_rules SET position=?3 WHERE id=?1 AND account_id=?2",
                        params![id, account_id, position as i64],
                    )
                    .map_err(db_error)?;
            }
            transaction.commit().map_err(db_error)?;
        }
        self.list_filter_rules(account_id)
    }

    /// Unread Inbox candidates for one rule. Bounded so a broad match cannot
    /// flood the offline queue. `newer_than_id` limits evaluation to rows
    /// cached by the current sync pass.
    pub fn find_rule_matches(
        &self,
        account_id: &str,
        rule: &FilterRule,
        newer_than_id: Option<i64>,
    ) -> Result<Vec<(i64, u32, String, i64)>, String> {
        let Some((clause, mut bound)) = rule_match_clause(rule) else {
            return Ok(Vec::new());
        };
        bound.push((":account_id".into(), Box::new(account_id.to_string())));
        bound.push((":newer_than_id".into(), Box::new(newer_than_id)));
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare(&format!(
                "SELECT m.id,m.uid,f.name,f.id FROM messages m JOIN mailboxes f ON f.id=m.mailbox_id
                 WHERE m.account_id=:account_id AND f.role='inbox' AND m.is_read=0 AND m.pending_move_to IS NULL
                 AND (:newer_than_id IS NULL OR m.id > :newer_than_id)
                 AND {clause}
                 ORDER BY m.uid DESC LIMIT 100"
            ))
            .map_err(db_error)?;
        let refs = named_refs(&bound);
        let rows = statement
            .query_map(refs.as_slice(), |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    /// Summary for a rule notice. Only rows of this account resolve.
    pub fn rule_notice_message(
        &self,
        account_id: &str,
        message_id: i64,
    ) -> Result<Option<MessageSummary>, String> {
        self.read_conn()?
            .query_row(
                &format!("{MESSAGE_SUMMARY_SELECT} WHERE m.account_id=?1 AND m.id=?2"),
                params![account_id, message_id],
                map_message_summary,
            )
            .optional()
            .map_err(db_error)
    }

    /// Same unread Inbox scan as filing, without changing mail.
    pub fn preview_rule_matches(
        &self,
        account_id: &str,
        rule: &FilterRule,
    ) -> Result<FilterMatchPreview, String> {
        let Some((clause, mut bound)) = rule_match_clause(rule) else {
            return Ok(FilterMatchPreview {
                matched: 0,
                capped: false,
                subjects: Vec::new(),
            });
        };
        bound.push((":account_id".into(), Box::new(account_id.to_string())));
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare(&format!(
                "SELECT m.subject FROM messages m JOIN mailboxes f ON f.id=m.mailbox_id
                 WHERE m.account_id=:account_id AND f.role='inbox' AND m.is_read=0 AND m.pending_move_to IS NULL
                 AND {clause}
                 ORDER BY m.uid DESC LIMIT 100"
            ))
            .map_err(db_error)?;
        let refs = named_refs(&bound);
        let subjects = statement
            .query_map(refs.as_slice(), |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let capped = subjects.len() == 100;
        Ok(FilterMatchPreview {
            matched: subjects.len() as u32,
            capped,
            subjects: subjects.into_iter().take(5).map(preview_subject).collect(),
        })
    }
}

/// Keeps the legacy single-condition columns and the list fields in step.
/// Rules with no lists derive one condition and one action from the legacy
/// columns; rules with lists set the legacy columns from their first entries.
pub(crate) fn normalized(mut rule: FilterRule) -> FilterRule {
    rule.match_mode = if rule.match_mode == "any" {
        "any".into()
    } else {
        "all".into()
    };
    let (conditions, actions) = rule_lists(&rule);
    rule.conditions = conditions;
    rule.actions = actions;
    for condition in &mut rule.conditions {
        condition.value = condition.value.trim().to_string();
    }
    rule.field = rule.conditions[0].field.clone();
    rule.contains = rule.conditions[0].value.clone();
    rule.action = rule.actions[0].kind.clone();
    rule.target_mailbox = rule.actions[0].target_mailbox.clone();
    rule
}

fn json_text<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[]".into())
}

enum RuleMatchPattern {
    ColumnLike {
        column: &'static str,
        like: String,
        domain_like: String,
    },
    ToAddressExact {
        address: String,
    },
}

/// Named SQL parameters and their values, bound together.
type NamedParams = Vec<(String, Box<dyn rusqlite::ToSql>)>;

fn named_refs(bound: &NamedParams) -> Vec<(&str, &dyn rusqlite::ToSql)> {
    bound
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_ref()))
        .collect()
}

/// WHERE fragment for a rule's conditions, joined by its match mode.
/// Values are bound as named parameters, never spliced into the SQL.
/// Returns None when no condition can match, so the rule matches nothing.
fn rule_match_clause(rule: &FilterRule) -> Option<(String, NamedParams)> {
    let (conditions, _) = rule_lists(rule);
    let any = rule.match_mode == "any";
    let mut fragments = Vec::new();
    let mut bound: NamedParams = Vec::new();
    for (index, condition) in conditions.iter().enumerate() {
        match rule_match_pattern(&condition.field, &condition.value) {
            Some(pattern) => fragments.push(condition_sql(&pattern, index, &mut bound)),
            None if any => {}
            None => return None,
        }
    }
    if fragments.is_empty() {
        return None;
    }
    let joiner = if any { " OR " } else { " AND " };
    Some((format!("({})", fragments.join(joiner)), bound))
}

fn condition_sql(pattern: &RuleMatchPattern, index: usize, bound: &mut NamedParams) -> String {
    let needle = format!(":c{index}l");
    match pattern {
        RuleMatchPattern::ColumnLike {
            column,
            like,
            domain_like,
        } => {
            let domain = format!(":c{index}d");
            bound.push((needle.clone(), Box::new(like.clone())));
            bound.push((domain.clone(), Box::new(domain_like.clone())));
            format!(
                "(
                   LOWER({column}) LIKE {needle} ESCAPE '\\'
                   OR (LENGTH({domain}) > 0 AND LOWER(m.sender_address) LIKE {domain} ESCAPE '\\')
                 )"
            )
        }
        RuleMatchPattern::ToAddressExact { address } => {
            bound.push((needle.clone(), Box::new(address.clone())));
            format!(
                "(
                   EXISTS (
                     SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) AS addr
                     WHERE lower(addr.value)={needle}
                   )
                   OR EXISTS (
                     SELECT 1 FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) AS addr
                     WHERE lower(addr.value)={needle}
                   )
                 )"
            )
        }
    }
}

fn rule_match_pattern(field: &str, value: &str) -> Option<RuleMatchPattern> {
    let trimmed = value.trim();
    let lowered = trimmed.to_ascii_lowercase();
    let needle: String = lowered
        .chars()
        .flat_map(|character| match character {
            '\\' => vec!['\\', '\\'],
            '%' => vec!['\\', '%'],
            '_' => vec!['\\', '_'],
            other => vec![other],
        })
        .collect();
    if needle.is_empty() {
        return None;
    }
    if field == "domain" {
        if !crate::models::valid_sender_domain(trimmed) {
            return None;
        }
        return Some(RuleMatchPattern::ColumnLike {
            column: "m.sender_address",
            like: format!("%@{needle}"),
            domain_like: format!("%@%.{needle}"),
        });
    }
    if field == "from" && is_full_address(trimmed) {
        // Exact address: no wildcards, so "me@x.io" never hits "me@x.io.com".
        return Some(RuleMatchPattern::ColumnLike {
            column: "m.sender_address",
            like: needle,
            domain_like: String::new(),
        });
    }
    if field == "to" && is_full_address(trimmed) {
        return Some(RuleMatchPattern::ToAddressExact { address: lowered });
    }
    let column = match field {
        "subject" => "m.subject",
        "to" => "m.recipients",
        "from" => "(m.sender_name || ' ' || m.sender_address)",
        _ => return None,
    };
    Some(RuleMatchPattern::ColumnLike {
        column,
        like: format!("%{needle}%"),
        domain_like: String::new(),
    })
}

/// One bare `local@domain.tld`: one '@', non-empty local part, dotted domain, no spaces.
fn is_full_address(value: &str) -> bool {
    if value.contains(char::is_whitespace) || value.matches('@').count() != 1 {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn preview_subject(value: String) -> String {
    let mut subject = String::new();
    let mut pending_space = false;
    for character in value.trim().chars() {
        if character.is_control() || character.is_whitespace() {
            pending_space = !subject.is_empty();
            continue;
        }
        if pending_space {
            if subject.chars().count() + 1 >= 80 {
                break;
            }
            subject.push(' ');
            pending_space = false;
        }
        if subject.chars().count() == 80 {
            break;
        }
        subject.push(character);
    }
    subject
}

#[cfg(test)]
mod tests {
    // Rule v2 failure modes:
    // - "any" and "all" disagree on mail matching only one condition
    // - 11 conditions, 2 move actions, 6 actions, an over-long value, or a
    //   flag without a valid color is refused with a typed error
    // - a retroactive apply (rule create or edit) never notifies
    // - a pass notifies at most once, about the newest matching message
    // - a legacy single-field rule matches the same mail as before v43
    use super::*;
    use crate::commands::sync::apply_filter_rules_notifying;
    use crate::db::CachedMessage;
    use crate::models::{
        validate_filter_rule, AccountRecord, AccountSummary, BodyFormat, IpcError, MailboxRole,
        ProviderKind, RuleAction, RuleCondition, ServerConfig, TlsMode,
    };
    use std::collections::BTreeSet;

    fn account() -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                notify_new_mail: true,
                default_body_format: BodyFormat::Html,
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                signature_html: String::new(),
                reply_to: String::new(),
                color: None,
            },
            imap: ServerConfig {
                trusted_certificate: None,
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
            },
            smtp: ServerConfig {
                trusted_certificate: None,
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
            },
        }
    }

    fn inbox(db: &Database, account_id: &str) -> i64 {
        db.upsert_mailbox(
            account_id,
            "INBOX",
            &MailboxRole::Inbox,
            Some(1),
            Some(2),
            Some(0),
            0,
        )
        .unwrap()
    }

    fn put(
        db: &Database,
        account_id: &str,
        mailbox: i64,
        uid: u32,
        subject: &str,
        sender: &str,
    ) -> i64 {
        let message = CachedMessage {
            uid,
            internal_at: None,
            message_id: Some(format!("<{uid}@rules.example.com>")),
            subject: subject.into(),
            sender_name: String::new(),
            sender_address: sender.into(),
            recipients: "sam@example.com".into(),
            received_at: "2026-08-18T12:00:00Z".into(),
            preview: String::new(),
            is_read: false,
            is_starred: false,
            size: 32,
            to: vec!["sam@example.com".into()],
            cc: vec![],
            bcc: vec![],
            reply_to: None,
            thread_parent: None,
            text_body: "body".into(),
            html_body: None,
            attachments: vec![],
            raw_message: format!("Subject: {subject}\r\n\r\nbody").into_bytes(),
            has_attachments: false,
            is_answered: false,
            is_forwarded: false,
            has_calendar: false,
            calendar_json: None,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            importance: String::new(),
            disposition_to: String::new(),
        };
        db.upsert_message(account_id, mailbox, &message).unwrap();
        db.message_summary_by_uid(mailbox, uid).unwrap().unwrap().id
    }

    fn rule(
        account_id: &str,
        mode: &str,
        conditions: &[(&str, &str)],
        actions: &[(&str, Option<&str>, Option<u8>)],
    ) -> FilterRule {
        FilterRule {
            id: String::new(),
            account_id: account_id.into(),
            name: "Rule".into(),
            field: String::new(),
            contains: String::new(),
            action: String::new(),
            target_mailbox: None,
            enabled: true,
            match_mode: mode.into(),
            conditions: conditions
                .iter()
                .map(|(field, value)| RuleCondition {
                    field: (*field).into(),
                    value: (*value).into(),
                })
                .collect(),
            actions: actions
                .iter()
                .map(|(kind, target, color)| RuleAction {
                    kind: (*kind).into(),
                    target_mailbox: target.map(Into::into),
                    flag_color: *color,
                })
                .collect(),
        }
    }

    fn matched_uids(db: &Database, account_id: &str, rule: &FilterRule) -> BTreeSet<u32> {
        db.find_rule_matches(account_id, rule, None)
            .unwrap()
            .into_iter()
            .map(|(_, uid, _, _)| uid)
            .collect()
    }

    fn refusal_code(rule: &FilterRule) -> String {
        let error = validate_filter_rule(rule, &rule.account_id).unwrap_err();
        IpcError::from(error).code
    }

    #[test]
    fn any_matches_one_condition_and_all_needs_both() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = inbox(&db, "account-1");
        put(
            &db,
            "account-1",
            mailbox,
            1,
            "Invoice 42",
            "bob@x.example.com",
        );
        put(
            &db,
            "account-1",
            mailbox,
            2,
            "Invoice",
            "carol@y.example.com",
        );
        put(&db, "account-1", mailbox, 3, "Lunch", "bob@x.example.com");
        let conditions = [("subject", "invoice"), ("from", "bob")];

        let all = db
            .create_filter_rule(&rule(
                "account-1",
                "all",
                &conditions,
                &[("mark_read", None, None)],
            ))
            .unwrap();
        assert_eq!(matched_uids(&db, "account-1", &all), BTreeSet::from([1]));

        let any = db
            .create_filter_rule(&rule(
                "account-1",
                "any",
                &conditions,
                &[("mark_read", None, None)],
            ))
            .unwrap();
        assert_eq!(
            matched_uids(&db, "account-1", &any),
            BTreeSet::from([1, 2, 3])
        );
    }

    #[test]
    fn eleven_conditions_are_refused_and_ten_are_allowed() {
        let ten: Vec<(&str, &str)> = (0..10).map(|_| ("subject", "bill")).collect();
        let eleven: Vec<(&str, &str)> = (0..11).map(|_| ("subject", "bill")).collect();
        let action = [("mark_read", None, None)];
        assert!(
            validate_filter_rule(&rule("account-1", "all", &ten, &action), "account-1").is_ok()
        );
        let refused = rule("account-1", "all", &eleven, &action);
        assert_eq!(refusal_code(&refused), "limitExceeded");
        let message = validate_filter_rule(&refused, "account-1").unwrap_err();
        assert!(message.to_ascii_lowercase().contains("too many"));
    }

    #[test]
    fn two_move_actions_are_refused_with_invalid_input() {
        let conditions = [("subject", "bill")];
        let two_moves = rule(
            "account-1",
            "all",
            &conditions,
            &[("move_archive", None, None), ("move_trash", None, None)],
        );
        assert_eq!(refusal_code(&two_moves), "invalidInput");
        let move_and_read = rule(
            "account-1",
            "all",
            &conditions,
            &[("move_archive", None, None), ("mark_read", None, None)],
        );
        assert!(validate_filter_rule(&move_and_read, "account-1").is_ok());
    }

    #[test]
    fn action_and_value_limits_are_enforced() {
        let conditions = [("subject", "bill")];
        let six: Vec<(&str, Option<&str>, Option<u8>)> =
            (0..6).map(|_| ("pin", None, None)).collect();
        assert_eq!(
            refusal_code(&rule("account-1", "all", &conditions, &six)),
            "limitExceeded"
        );
        let long = "x".repeat(321);
        let long_value = [("subject", long.as_str())];
        assert_eq!(
            refusal_code(&rule(
                "account-1",
                "all",
                &long_value,
                &[("pin", None, None)]
            )),
            "invalidInput"
        );
        let flag_without_color = [("flag", None, None)];
        assert_eq!(
            refusal_code(&rule("account-1", "all", &conditions, &flag_without_color)),
            "invalidInput"
        );
        let flag_color_seven = [("flag", None, Some(7))];
        assert_eq!(
            refusal_code(&rule("account-1", "all", &conditions, &flag_color_seven)),
            "invalidInput"
        );
        let unknown_mode = rule("account-1", "some", &conditions, &[("pin", None, None)]);
        assert_eq!(refusal_code(&unknown_mode), "invalidInput");
    }

    #[test]
    fn retroactive_apply_never_notifies() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = inbox(&db, "account-1");
        put(
            &db,
            "account-1",
            mailbox,
            1,
            "Power bill",
            "bills@power.example.com",
        );
        db.create_filter_rule(&rule(
            "account-1",
            "all",
            &[("subject", "bill")],
            &[("notify", None, None)],
        ))
        .unwrap();
        let mut notices = Vec::new();
        apply_filter_rules_notifying(&db, &account, None, &mut |id| notices.push(id));
        assert!(notices.is_empty());
    }

    #[test]
    fn a_pass_notifies_once_about_the_newest_matching_message() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = inbox(&db, "account-1");
        let older = put(
            &db,
            "account-1",
            mailbox,
            1,
            "Bill one",
            "bills@power.example.com",
        );
        let newest = put(
            &db,
            "account-1",
            mailbox,
            2,
            "Bill two",
            "bills@power.example.com",
        );
        put(
            &db,
            "account-1",
            mailbox,
            3,
            "Lunch",
            "amy@friends.example.com",
        );
        for _ in 0..2 {
            db.create_filter_rule(&rule(
                "account-1",
                "all",
                &[("subject", "bill")],
                &[("notify", None, None)],
            ))
            .unwrap();
        }
        let mut notices = Vec::new();
        apply_filter_rules_notifying(&db, &account, Some(older - 1), &mut |id| notices.push(id));
        assert_eq!(notices, vec![newest]);
    }

    #[test]
    fn flag_and_pin_actions_apply_locally_and_queue_the_color() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = inbox(&db, "account-1");
        let id = put(
            &db,
            "account-1",
            mailbox,
            1,
            "Power bill",
            "bills@power.example.com",
        );
        db.create_filter_rule(&rule(
            "account-1",
            "all",
            &[("subject", "bill")],
            &[("flag", None, Some(3)), ("pin", None, None)],
        ))
        .unwrap();
        assert!(apply_filter_rules_notifying(
            &db,
            &account,
            None,
            &mut |_| {}
        ));
        let summary = db.message_summary_by_uid(mailbox, 1).unwrap().unwrap();
        assert_eq!(summary.id, id);
        assert_eq!(summary.flag_color, 3);
        assert!(summary.pinned);
        let payloads: Vec<String> = db
            .queued_operations("account-1")
            .unwrap()
            .into_iter()
            .filter(|(_, kind, _)| kind == "flags")
            .map(|(_, _, payload)| payload)
            .collect();
        assert_eq!(payloads.len(), 1);
        assert!(payloads[0].contains("\"flagColor\":3"));
    }

    #[test]
    fn legacy_single_field_rules_match_as_they_did_before_v43() {
        let db = Database::memory();
        let account = account();
        db.insert_account(&account).unwrap();
        let mailbox = inbox(&db, "account-1");
        put(
            &db,
            "account-1",
            mailbox,
            1,
            "Power bill",
            "bills@power.example.com",
        );
        put(
            &db,
            "account-1",
            mailbox,
            2,
            "Lunch plans",
            "amy@friends.example.com",
        );
        put(
            &db,
            "account-1",
            mailbox,
            3,
            "Re: Power bill again",
            "ops@power.example.com",
        );
        // A v42 row: only the legacy columns. The v43 defaults leave the lists empty.
        let legacy: [(&str, &str); 6] = [
            ("subject", "bill"),
            ("from", "power.example.com"),
            ("domain", "example.com"),
            ("from", "amy@friends.example.com"),
            ("to", "sam@example.com"),
            ("subject", "lunch"),
        ];
        let expected = [
            BTreeSet::from([1, 3]),
            BTreeSet::from([1, 3]),
            BTreeSet::from([1, 2, 3]),
            BTreeSet::from([2]),
            BTreeSet::from([1, 2, 3]),
            BTreeSet::from([2]),
        ];
        for (index, (field, value)) in legacy.iter().enumerate() {
            let id = format!("legacy-{index}");
            db.conn()
                .unwrap()
                .execute(
                    "INSERT INTO filter_rules(id,account_id,name,field,contains,action,target_mailbox,enabled,position)
                     VALUES(?1,'account-1','Legacy',?2,?3,'mark_read',NULL,1,?4)",
                    rusqlite::params![id, field, value, index as i64],
                )
                .unwrap();
        }
        let rules = db.list_filter_rules("account-1").unwrap();
        assert_eq!(rules.len(), legacy.len());
        for (rule, want) in rules.iter().zip(expected) {
            assert_eq!(
                matched_uids(&db, "account-1", rule),
                want,
                "{}",
                rule.contains
            );
        }
    }
}
