//! Search operators: `from:` `to:` `from:me` `to:me` `cc:` `cc:me` `subject:` `body:` `has:attachment`
//! `filename:` `larger:` `smaller:` `is:unread` `is:read` `is:flagged`
//! `is:starred` `is:muted` `is:pinned` `is:important` `is:low` `is:replied` `is:forwarded` `before:YYYY-MM-DD`
//! `after:YYYY-MM-DD` `on:YYYY-MM-DD` `in:folder`.
//!
//! Failure modes this parser must survive:
//! - FTS syntax in user text (`OR`, `NEAR(`, `col:`, `*`, `-`, stray quotes)
//!   must stay literal: every term is emitted double-quoted;
//! - column names in the FTS expression come only from a fixed list;
//! - an unknown operator (`foo:bar`) or unknown value (`is:spam`) is plain text;
//! - impossible dates (`before:2026-13-45`) are plain text, never a filter;
//! - an operator with no usable value adds no clause;
//! - IMAP values escape `\` and `"` and drop control characters (no CRLF or
//!   extra-key injection); non-ASCII values add `CHARSET UTF-8`;
//! - quotes left open still parse; huge input is truncated;
//! - conflicting `is:read` / `is:unread` is decided (last wins), not both.

use chrono::{Datelike, NaiveDate};

const MAX_INPUT_CHARS: usize = 200;
const MAX_CLAUSES: usize = 12;
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Term {
    pub text: String,
    /// Quoted in the input: match the words as a phrase.
    pub phrase: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ParsedSearch {
    pub plain: Vec<Term>,
    pub from: Vec<String>,
    pub to: Vec<String>,
    /// `from:me` — sender is this account's address or an alias.
    pub from_self: bool,
    /// `to:me` — this account's address or an alias is a recipient.
    pub to_self: bool,
    /// `cc:` address or local-part needles. Matched only against Cc.
    pub cc: Vec<String>,
    /// `cc:me` — this account's address or an alias is on Cc.
    pub cc_self: bool,
    pub subject: Vec<String>,
    /// `body:` words. Matched only against the message text.
    pub body: Vec<String>,
    pub has_attachment: bool,
    /// `filename:` needles. Matched against downloaded attachment names.
    pub filenames: Vec<String>,
    /// `larger:` size in bytes, exclusive.
    pub larger_than: Option<i64>,
    /// `smaller:` size in bytes, exclusive.
    pub smaller_than: Option<i64>,
    /// `in:` folder names or roles. A message in any named folder matches.
    pub folders: Vec<String>,
    /// `Some(true)` for `is:read`, `Some(false)` for `is:unread`.
    pub read: Option<bool>,
    pub flagged: bool,
    /// `is:replied` (`\Answered`).
    pub answered: bool,
    /// `is:forwarded` (`$Forwarded`).
    pub forwarded: bool,
    /// `is:muted` — this device has muted the conversation. Not an IMAP flag.
    pub muted: bool,
    /// `is:pinned` — pinned on this computer. Not an IMAP flag.
    pub pinned: bool,
    /// `is:important` / `is:high`, or `is:low`. The stored mark, not one header.
    pub importance: Option<&'static str>,
    pub before: Option<NaiveDate>,
    pub after: Option<NaiveDate>,
    /// `on:` one UTC day. The last `on:` wins.
    pub on: Option<NaiveDate>,
}

fn has_alnum(value: &str) -> bool {
    value.chars().any(char::is_alphanumeric)
}

/// Split on whitespace outside quotes. Quote marks are dropped; the flag
/// says the token contained a quoted part.
fn tokenize(text: &str) -> Vec<(String, bool)> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut inside = false;
    let mut flush = |current: &mut String, quoted: &mut bool| {
        let trimmed = current.trim();
        if !trimmed.is_empty() {
            tokens.push((trimmed.to_string(), *quoted));
        }
        current.clear();
        *quoted = false;
    };
    for character in text.chars().take(MAX_INPUT_CHARS) {
        if character == '"' {
            inside = !inside;
            quoted = true;
        } else if character.is_whitespace() {
            if inside {
                current.push(' ');
            } else {
                flush(&mut current, &mut quoted);
            }
        } else if !character.is_control() {
            current.push(character);
        }
    }
    flush(&mut current, &mut quoted);
    tokens
}

/// `10`, `2K`, `5MB`, `1G`. Zero, fractions, and unknown units are rejected.
fn parse_size(value: &str) -> Option<i64> {
    let value = value.trim();
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let (number, unit) = value.split_at(digits);
    let number: u64 = number.parse().ok()?;
    if number == 0 {
        return None;
    }
    let multiplier: u64 = match unit.to_ascii_lowercase().as_str() {
        "" => 1,
        "k" | "kb" => 1024,
        "m" | "mb" => 1024 * 1024,
        "g" | "gb" => 1024 * 1024 * 1024,
        _ => return None,
    };
    i64::try_from(number.checked_mul(multiplier)?).ok()
}

/// Substring match for an attachment name. `%` and `_` stay literal.
pub(crate) fn filename_matches(name: &str, needle: &str) -> bool {
    name.to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

/// `in:` matches a role (`inbox`, `spam` for junk), the folder's full name,
/// or its last path segment. `other` is not a role shortcut.
pub(crate) fn folder_needle_matches(
    needle: &str,
    role: &str,
    name: &str,
    display_name: &str,
    delimiter: Option<&str>,
) -> bool {
    let needle = needle.trim().to_ascii_lowercase();
    if !has_alnum(&needle) {
        return false;
    }
    let role_needle = if needle == "spam" {
        "junk"
    } else {
        needle.as_str()
    };
    if role != "other" && role.eq_ignore_ascii_case(role_needle) {
        return true;
    }
    let name = name.to_ascii_lowercase();
    let display = display_name.to_ascii_lowercase();
    if name == needle || display == needle {
        return true;
    }
    let mark = delimiter.map(str::to_ascii_lowercase);
    ends_with_segment(&name, &needle, mark.as_deref())
        || ends_with_segment(&display, &needle, mark.as_deref())
}

fn ends_with_segment(value: &str, needle: &str, delimiter: Option<&str>) -> bool {
    match delimiter {
        Some(delimiter) if !delimiter.is_empty() => value.rsplit(delimiter).next() == Some(needle),
        _ => false,
    }
}

/// `lee` becomes `lee@%`, with LIKE wildcards escaped.
pub(crate) fn cc_local_like(needle: &str) -> String {
    let mut escaped = String::new();
    for character in needle.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character.to_ascii_lowercase());
    }
    format!("{escaped}@%")
}

pub(crate) fn filename_like_pattern(needle: &str) -> String {
    let mut escaped = String::new();
    for character in needle.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character.to_ascii_lowercase());
    }
    format!("%{escaped}%")
}

fn parse_date(value: &str) -> Option<NaiveDate> {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if !shaped {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

pub(crate) fn parse(text: &str) -> ParsedSearch {
    let mut out = ParsedSearch::default();
    let mut clauses = 0usize;
    for (token, quoted) in tokenize(text) {
        if clauses >= MAX_CLAUSES {
            break;
        }
        let mut plain = false;
        match token.split_once(':') {
            Some((name, value)) => {
                let value = value.trim();
                let lowered = value.to_ascii_lowercase();
                match name.to_ascii_lowercase().as_str() {
                    "cc" => {
                        if lowered == "me" {
                            out.cc_self = true;
                            clauses += 1;
                        } else if has_alnum(value) {
                            out.cc.push(value.to_string());
                            clauses += 1;
                        }
                    }
                    "body" => {
                        if has_alnum(value) {
                            out.body.push(value.to_string());
                            clauses += 1;
                        }
                    }
                    "from" | "to" | "subject" => {
                        let field = name.to_ascii_lowercase();
                        if (field == "from" || field == "to") && lowered == "me" {
                            if field == "from" {
                                out.from_self = true;
                            } else {
                                out.to_self = true;
                            }
                            clauses += 1;
                        } else if has_alnum(value) {
                            let list = match field.as_str() {
                                "from" => &mut out.from,
                                "to" => &mut out.to,
                                _ => &mut out.subject,
                            };
                            list.push(value.to_string());
                            clauses += 1;
                        }
                    }
                    "has" if lowered == "attachment" => {
                        out.has_attachment = true;
                        clauses += 1;
                    }
                    "filename" => {
                        if has_alnum(value) {
                            out.filenames.push(value.to_string());
                            clauses += 1;
                        }
                    }
                    "in" => {
                        if has_alnum(value) {
                            out.folders.push(value.to_string());
                            clauses += 1;
                        }
                    }
                    "larger" | "smaller" => {
                        if let Some(size) = parse_size(value) {
                            if name.eq_ignore_ascii_case("larger") {
                                out.larger_than = Some(size);
                            } else {
                                out.smaller_than = Some(size);
                            }
                            clauses += 1;
                        } else {
                            plain = true;
                        }
                    }
                    "is" if lowered == "unread" => {
                        out.read = Some(false);
                        clauses += 1;
                    }
                    "is" if lowered == "read" => {
                        out.read = Some(true);
                        clauses += 1;
                    }
                    "is" if lowered == "flagged" || lowered == "starred" => {
                        out.flagged = true;
                        clauses += 1;
                    }
                    "is" if lowered == "replied" || lowered == "answered" => {
                        out.answered = true;
                        clauses += 1;
                    }
                    "is" if lowered == "forwarded" => {
                        out.forwarded = true;
                        clauses += 1;
                    }
                    "is" if lowered == "muted" => {
                        out.muted = true;
                        clauses += 1;
                    }
                    "is" if lowered == "pinned" => {
                        out.pinned = true;
                        clauses += 1;
                    }
                    "is" if lowered == "important" || lowered == "high" => {
                        out.importance = Some("high");
                        clauses += 1;
                    }
                    "is" if lowered == "low" => {
                        out.importance = Some("low");
                        clauses += 1;
                    }
                    "before" | "after" | "on" if parse_date(value).is_some() => {
                        let date = parse_date(value);
                        if name.eq_ignore_ascii_case("before") {
                            out.before = date;
                        } else if name.eq_ignore_ascii_case("after") {
                            out.after = date;
                        } else {
                            out.on = date;
                        }
                        clauses += 1;
                    }
                    _ => plain = true,
                }
            }
            None => plain = true,
        }
        if plain && has_alnum(&token) {
            out.plain.push(Term {
                text: token,
                phrase: quoted,
            });
            clauses += 1;
        }
    }
    out
}

fn clean_word(word: &str) -> String {
    word.replace('*', "")
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.' && c != '_')
        .to_string()
}

/// One double-quoted, prefix-matched FTS phrase, or None without words.
fn fts_phrase(value: &str) -> Option<String> {
    let words = value
        .split_whitespace()
        .map(clean_word)
        .filter(|word| has_alnum(word))
        .take(12)
        .collect::<Vec<_>>();
    if words.is_empty() {
        return None;
    }
    Some(format!("\"{}\"*", words.join(" ").replace('"', "\"\"")))
}

/// Double-quoted IMAP string: control characters dropped, `\` and `"`
/// escaped.
fn imap_quote(value: &str) -> Option<String> {
    let cleaned = value
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_INPUT_CHARS)
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    (!cleaned.trim().is_empty()).then(|| format!("\"{cleaned}\""))
}

/// Account address and aliases, lowercased, for `from:me` and `to:me`.
pub(crate) fn search_identities(email: &str, aliases: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for value in std::iter::once(email).chain(aliases.iter().map(String::as_str)) {
        let id = value.trim().to_ascii_lowercase();
        if id.len() > 254
            || !id.contains('@')
            || id.chars().any(char::is_control)
            || out.iter().any(|existing: &String| existing == &id)
        {
            continue;
        }
        out.push(id);
    }
    out
}

/// `FROM a`, or `OR FROM a FROM b`, or `OR OR FROM a FROM b FROM c`.
fn imap_any(key: &str, identities: &[String], ascii: &mut bool) -> Option<String> {
    let mut keys = Vec::new();
    for value in identities {
        let quoted = imap_quote(value)?;
        *ascii &= value.is_ascii();
        keys.push(format!("{key} {quoted}"));
    }
    let mut keys = keys.into_iter();
    let mut combined = keys.next()?;
    for next in keys {
        combined = format!("OR {combined} {next}");
    }
    Some(combined)
}

fn imap_date(date: NaiveDate) -> String {
    format!(
        // IMAP date-year is 4DIGIT; `0001` must not become `1`.
        "{}-{}-{:04}",
        date.day(),
        MONTHS[date.month0() as usize],
        date.year()
    )
}

impl ParsedSearch {
    pub(crate) fn is_empty(&self) -> bool {
        self.plain.is_empty()
            && self.from.is_empty()
            && self.to.is_empty()
            && !self.from_self
            && !self.to_self
            && self.cc.is_empty()
            && !self.cc_self
            && self.subject.is_empty()
            && self.body.is_empty()
            && !self.has_attachment
            && self.filenames.is_empty()
            && self.larger_than.is_none()
            && self.smaller_than.is_none()
            && self.folders.is_empty()
            && self.read.is_none()
            && !self.flagged
            && !self.answered
            && !self.forwarded
            && !self.muted
            && !self.pinned
            && self.importance.is_none()
            && self.before.is_none()
            && self.after.is_none()
            && self.on.is_none()
    }

    /// FTS5 MATCH expression for text and column operators.
    pub(crate) fn fts_match(&self) -> Option<String> {
        let mut parts = Vec::new();
        for term in &self.plain {
            let part = if term.phrase {
                fts_phrase(&term.text)
            } else {
                Some(crate::db::fts_query(&term.text)).filter(|value| !value.is_empty())
            };
            parts.extend(part);
        }
        let columns = [
            ("sender", &self.from),
            ("recipients", &self.to),
            ("subject", &self.subject),
            ("body", &self.body),
        ];
        for (column, values) in columns {
            for value in values {
                if let Some(phrase) = fts_phrase(value) {
                    parts.push(format!("{column} : {phrase}"));
                }
            }
        }
        (!parts.is_empty()).then(|| parts.join(" AND "))
    }

    /// IMAP SEARCH criteria. `has:attachment` has no standard key, so a
    /// search with only that operator lists ALL and the caller filters.
    /// `from:me` and `to:me` need the account addresses from
    /// [`Self::imap_criteria_with`].
    #[cfg(test)]
    pub(crate) fn imap_criteria(&self) -> Option<String> {
        self.imap_criteria_with(&[])
    }

    pub(crate) fn imap_criteria_with(&self, identities: &[String]) -> Option<String> {
        if self.is_empty() || self.muted || self.pinned || self.importance.is_some() {
            // Mute, pins, and importance live in the local database. A server
            // search cannot see them, and one Importance header would miss
            // mail stored from X-Priority or Priority.
            return None;
        }
        let mut keys = Vec::new();
        let mut ascii = true;
        let operators = [
            ("FROM", &self.from),
            ("TO", &self.to),
            ("CC", &self.cc),
            ("SUBJECT", &self.subject),
            ("BODY", &self.body),
        ];
        for (key, values) in operators {
            for value in values {
                if let Some(quoted) = imap_quote(value) {
                    ascii &= value.is_ascii();
                    keys.push(format!("{key} {quoted}"));
                }
            }
        }
        if self.from_self {
            keys.push(imap_any("FROM", identities, &mut ascii)?);
        }
        if self.to_self {
            keys.push(imap_any("TO", identities, &mut ascii)?);
        }
        if self.cc_self {
            keys.push(imap_any("CC", identities, &mut ascii)?);
        }
        match self.read {
            Some(true) => keys.push("SEEN".into()),
            Some(false) => keys.push("UNSEEN".into()),
            None => {}
        }
        if self.flagged {
            keys.push("FLAGGED".into());
        }
        if self.answered {
            keys.push("ANSWERED".into());
        }
        if self.forwarded {
            keys.push("KEYWORD $Forwarded".into());
        }
        if let Some(date) = self.before {
            keys.push(format!("BEFORE {}", imap_date(date)));
        }
        if let Some(date) = self.after {
            keys.push(format!("SINCE {}", imap_date(date)));
        }
        if let Some(date) = self.on {
            keys.push(format!("ON {}", imap_date(date)));
        }
        if let Some(size) = self.larger_than {
            keys.push(format!("LARGER {size}"));
        }
        if let Some(size) = self.smaller_than {
            keys.push(format!("SMALLER {size}"));
        }
        for term in &self.plain {
            if let Some(quoted) = imap_quote(&term.text) {
                ascii &= term.text.is_ascii();
                keys.push(format!("TEXT {quoted}"));
            }
        }
        if keys.is_empty() {
            // Attachment names have no IMAP key. ALL would list the mailbox
            // and then throw away rows whose files are not downloaded yet.
            if !self.filenames.is_empty() {
                return None;
            }
            keys.push("ALL".into());
        }
        let joined = keys.join(" ");
        Some(if ascii {
            joined
        } else {
            format!("CHARSET UTF-8 {joined}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn parses_every_operator() {
        let parsed = parse(
            "invoice from:jane to:sam subject:\"q3 report\" has:attachment is:unread is:flagged before:2026-09-01 after:2026-08-01",
        );
        assert_eq!(parsed.plain.len(), 1);
        assert_eq!(parsed.from, vec!["jane"]);
        assert_eq!(parsed.to, vec!["sam"]);
        assert_eq!(parsed.subject, vec!["q3 report"]);
        assert!(parsed.body.is_empty());
        let letter = parse("body:\"bring sandwiches\" BODY:numbers");
        assert_eq!(letter.body, vec!["bring sandwiches", "numbers"]);
        assert!(letter.plain.is_empty());
        assert_eq!(
            parse("body:budget").imap_criteria().unwrap(),
            "BODY \"budget\""
        );
        assert_eq!(
            parse("body:\"bring sandwiches\" from:jane")
                .imap_criteria()
                .unwrap(),
            "FROM \"jane\" BODY \"bring sandwiches\""
        );
        assert!(parse("body:").body.is_empty());
        assert!(parse("body:*").body.is_empty());
        assert!(parse("body:*").plain.is_empty());
        assert_eq!(parse("bodies:budget").body, Vec::<String>::new());
        assert_eq!(parse("bodies:budget").plain[0].text, "bodies:budget");
        assert_eq!(parse("body:me").body, vec!["me"]);
        assert!(!parse("body:me").from_self);
        assert_eq!(parse("body:budget is:pinned").imap_criteria(), None);
        assert!(parsed.has_attachment && parsed.flagged);
        assert_eq!(parsed.read, Some(false));
        let replied = parse("is:replied is:forwarded IS:Answered");
        assert!(replied.answered && replied.forwarded);
        assert!(replied.plain.is_empty());
        assert_eq!(parse("is:replied").imap_criteria().unwrap(), "ANSWERED");
        assert_eq!(
            parse("is:forwarded").imap_criteria().unwrap(),
            "KEYWORD $Forwarded"
        );
        assert_eq!(parsed.before, Some(date("2026-09-01")));
        assert_eq!(parsed.after, Some(date("2026-08-01")));
        assert!(parsed.on.is_none());
        let day = parse("ON:2026-08-20 on:2026-08-01");
        assert_eq!(day.on, Some(date("2026-08-01")));
        assert!(day.plain.is_empty());
        assert_eq!(
            parse("on:2026-08-20").imap_criteria().unwrap(),
            "ON 20-Aug-2026"
        );
        assert_eq!(
            parse("on:2026-08-20 from:jane").imap_criteria().unwrap(),
            "FROM \"jane\" ON 20-Aug-2026"
        );
        assert_eq!(parse("on:2026-08-20 is:pinned").imap_criteria(), None);
        assert_eq!(parse("on:tomorrow").plain[0].text, "on:tomorrow");
        assert!(parse("on:tomorrow").on.is_none());
        let sized = parse("filename:Plan.PDF larger:1M smaller:2kb");
        assert_eq!(sized.filenames, vec!["Plan.PDF"]);
        assert_eq!(sized.larger_than, Some(1024 * 1024));
        assert_eq!(sized.smaller_than, Some(2 * 1024));
        assert!(sized.plain.is_empty());
        assert_eq!(parse("filename:pdf").imap_criteria(), None);
        assert_eq!(
            parse("filename:pdf from:jane").imap_criteria().unwrap(),
            "FROM \"jane\""
        );
        assert_eq!(
            parse("larger:1M").imap_criteria().unwrap(),
            "LARGER 1048576"
        );
        assert_eq!(parse("smaller:10").imap_criteria().unwrap(), "SMALLER 10");
        let folder = parse("in:Inbox in:spam");
        assert_eq!(folder.folders, vec!["Inbox", "spam"]);
        assert!(folder.plain.is_empty());
        assert_eq!(parse("in:inbox").imap_criteria().unwrap(), "ALL");
        assert_eq!(
            parse("in:archive from:jane").imap_criteria().unwrap(),
            "FROM \"jane\""
        );
        assert!(folder_needle_matches(
            "Inbox", "inbox", "INBOX", "Inbox", None
        ));
        assert!(folder_needle_matches("spam", "junk", "Junk", "Junk", None));
        assert!(folder_needle_matches(
            "Receipts",
            "other",
            "Work/Receipts",
            "Work/Receipts",
            Some("/"),
        ));
        assert!(!folder_needle_matches(
            "Work",
            "other",
            "Work/Receipts",
            "Work/Receipts",
            Some("/"),
        ));
        assert!(!folder_needle_matches(
            "other", "other", "Projects", "Projects", None
        ));
        assert!(filename_matches("100%plan.pdf", "100%"));
        assert!(!filename_matches("1000plan.pdf", "100%"));
        assert_eq!(filename_like_pattern("100%_a"), "%100\\%\\_a%");
        assert_eq!(cc_local_like("100%_a"), "100\\%\\_a@%");
        assert!(parse("from:me").from_self && parse("from:me").from.is_empty());
        assert!(parse("cc:me").cc_self && parse("cc:me").cc.is_empty());
        assert_eq!(parse("CC:Lee@Example.com").cc, vec!["Lee@Example.com"]);
        assert!(!parse("cc:medea").cc_self);
        assert_eq!(
            parse("cc:me")
                .imap_criteria_with(&["sam@example.com".into()])
                .unwrap(),
            "CC \"sam@example.com\""
        );
        assert_eq!(parse("cc:me").imap_criteria(), None);
        assert!(parse("TO:Me").to_self && parse("TO:Me").to.is_empty());
        assert!(!parse("from:medea").from_self);
        assert_eq!(parse("from:medea").from, vec!["medea"]);
        assert_eq!(parse("from:me@example.com").from, vec!["me@example.com"]);
        assert!(!parse("from:me@example.com").from_self);
        assert!(parse("is:muted").muted && parse("is:muted").plain.is_empty());
        assert!(!parse("is:mute").muted);
        assert_eq!(parse("is:muted").imap_criteria(), None);
        assert_eq!(parse("is:muted from:jane").imap_criteria(), None);
        assert!(parse("is:pinned").pinned && parse("is:pinned").plain.is_empty());
        assert!(parse("IS:Pinned").pinned);
        assert!(!parse("is:pin").pinned);
        assert_eq!(parse("is:pin").plain[0].text, "is:pin");
        assert_eq!(parse("is:pinned").imap_criteria(), None);
        assert_eq!(parse("is:pinned from:jane").imap_criteria(), None);
        assert_eq!(parse("is:important").importance, Some("high"));
        assert_eq!(parse("is:high").importance, Some("high"));
        assert_eq!(parse("IS:Low").importance, Some("low"));
        assert_eq!(parse("is:important is:low").importance, Some("low"));
        assert!(parse("is:important").plain.is_empty());
        assert!(parse("is:urgent").importance.is_none());
        assert_eq!(parse("is:urgent").plain[0].text, "is:urgent");
        assert_eq!(parse("is:important").imap_criteria(), None);
        assert_eq!(parse("is:low from:jane").imap_criteria(), None);
        assert!(parse("is:starred").flagged && parse("is:starred").plain.is_empty());
        assert_eq!(parse("is:starred").imap_criteria().unwrap(), "FLAGGED");
        assert_eq!(parse("from:me").imap_criteria(), None);
        assert_eq!(
            parse("from:me")
                .imap_criteria_with(&["Sam@Example.com".into()])
                .unwrap(),
            "FROM \"Sam@Example.com\""
        );
        assert_eq!(
            parse("from:me to:me")
                .imap_criteria_with(&["a@b.co".into(), "c@d.co".into()])
                .unwrap(),
            "OR FROM \"a@b.co\" FROM \"c@d.co\" OR TO \"a@b.co\" TO \"c@d.co\""
        );
        assert_eq!(
            search_identities(
                " Sam@Example.com ",
                &["sam@example.com".into(), "Alias@Example.com".into()]
            ),
            vec![
                "sam@example.com".to_string(),
                "alias@example.com".to_string()
            ]
        );
    }

    #[test]
    fn operators_are_case_insensitive_and_read_last_wins() {
        let parsed = parse("FROM:Jane IS:Read is:unread");
        assert_eq!(parsed.from, vec!["Jane"]);
        assert_eq!(parsed.read, Some(false));
    }

    #[test]
    fn unknown_operator_or_value_is_plain_text() {
        for text in [
            "foo:bar",
            "is:spam",
            "has:pets",
            "before:2026-13-45",
            "after:tomorrow",
            "before:2026-8-1",
            "on:2026-13-45",
            "on:2026-8-1",
            "larger:lots",
            "smaller:1.5M",
            "larger:0",
        ] {
            let parsed = parse(text);
            assert_eq!(parsed.plain.len(), 1, "{text}");
            assert_eq!(parsed.plain[0].text, text);
            assert!(
                parsed.from.is_empty()
                    && parsed.before.is_none()
                    && parsed.on.is_none()
                    && parsed.read.is_none()
            );
        }
    }

    #[test]
    fn empty_operator_value_adds_nothing() {
        let parsed = parse("from: to:\"\"");
        assert!(parsed.from.is_empty() && parsed.to.is_empty());
        assert_eq!(parsed.fts_match(), None);
    }

    #[test]
    fn fts_expression_quotes_everything() {
        let parsed = parse("hello from:jane subject:\"quarterly report\" to:sam@example.com");
        assert_eq!(
            parsed.fts_match().unwrap(),
            "\"hello\"* AND sender : \"jane\"* AND recipients : \"sam@example.com\"* AND subject : \"quarterly report\"*"
        );
        assert_eq!(parse("is:unread").fts_match(), None);
        assert_eq!(
            parse("\"exact words\"").fts_match().unwrap(),
            "\"exact words\"*"
        );
        assert_eq!(
            parse("body:\"quarterly notes\"").fts_match().unwrap(),
            "body : \"quarterly notes\"*"
        );
    }

    #[test]
    fn fts_syntax_stays_literal() {
        let expr = parse("a OR b NEAR(x y) note:* -secret \"unterminated")
            .fts_match()
            .unwrap();
        // Outside quotes only the fixed joiner appears.
        let mut outside = String::new();
        let mut inside = false;
        let mut chars = expr.chars().peekable();
        while let Some(character) = chars.next() {
            if character == '"' {
                if inside && chars.peek() == Some(&'"') {
                    chars.next();
                    continue;
                }
                inside = !inside;
            } else if !inside {
                outside.push(character);
            }
        }
        let outside = outside.replace('*', "");
        assert!(
            outside.split_whitespace().all(|word| word == "AND"),
            "{expr}"
        );
    }

    #[test]
    fn input_and_clauses_are_bounded() {
        let long = format!("from:{}", "x".repeat(10_000));
        assert!(parse(&long).from[0].chars().count() <= MAX_INPUT_CHARS);
        let many = (0..100)
            .map(|i| format!("from:u{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(parse(&many).from.len() <= MAX_CLAUSES);
    }

    #[test]
    fn imap_criteria_maps_keys_and_quotes() {
        let parsed = parse(
            "from:jane subject:\"a b\" is:unread is:flagged before:2026-09-01 after:2026-08-05 hello",
        );
        assert_eq!(
            parsed.imap_criteria().unwrap(),
            "FROM \"jane\" SUBJECT \"a b\" UNSEEN FLAGGED BEFORE 1-Sep-2026 SINCE 5-Aug-2026 TEXT \"hello\""
        );
        assert_eq!(parse("is:read").imap_criteria().unwrap(), "SEEN");
        assert_eq!(parse("to:sam").imap_criteria().unwrap(), "TO \"sam\"");
        // Short years would be a BAD response and fail server search.
        assert_eq!(
            parse("before:0001-05-05").imap_criteria().unwrap(),
            "BEFORE 5-May-0001"
        );
        // IMAP TEXT is contiguous; separate keys AND-match like local FTS.
        assert_eq!(
            parse("hello world").imap_criteria().unwrap(),
            "TEXT \"hello\" TEXT \"world\""
        );
        assert_eq!(
            parse("\"hello world\"").imap_criteria().unwrap(),
            "TEXT \"hello world\""
        );
    }

    #[test]
    fn imap_values_cannot_inject() {
        for input in [
            "from:\"a\\\" OR ALL\r\nA1 LOGOUT\"",
            "subject:x\"y ALL) (OR",
            "body:x\"y ALL) (OR",
            "to:\\ \"\\\"",
        ] {
            let criteria = parse(input).imap_criteria().unwrap_or_default();
            assert!(
                !criteria.contains('\r') && !criteria.contains('\n'),
                "{criteria}"
            );
            let mut outside = String::new();
            let mut inside = false;
            let mut escaped = false;
            for character in criteria.chars() {
                if inside && escaped {
                    escaped = false;
                } else if inside && character == '\\' {
                    escaped = true;
                } else if character == '"' {
                    inside = !inside;
                    outside.push(' ');
                } else if !inside {
                    outside.push(character);
                }
            }
            assert!(!inside, "{criteria}");
            assert!(
                outside
                    .split_whitespace()
                    .all(|word| ["FROM", "TO", "SUBJECT", "BODY", "TEXT"].contains(&word)),
                "{criteria}"
            );
        }
    }

    #[test]
    fn non_ascii_uses_utf8_charset() {
        let criteria = parse("from:josé").imap_criteria().unwrap();
        assert!(criteria.starts_with("CHARSET UTF-8 FROM "), "{criteria}");
        assert!(!parse("from:jose")
            .imap_criteria()
            .unwrap()
            .contains("CHARSET"));
    }

    #[test]
    fn attachment_only_uses_all_and_empty_is_none() {
        let parsed = parse("has:attachment");
        assert_eq!(parsed.imap_criteria().unwrap(), "ALL");
        assert!(!parsed.is_empty());
        assert!(parse("   ").is_empty());
        assert_eq!(parse("   ").imap_criteria(), None);
        assert_eq!(parse("!!! ???").imap_criteria(), None);
    }
}
