//! Search operators: `from:` `to:` `subject:` `has:attachment` `is:unread`
//! `is:read` `is:flagged` `before:YYYY-MM-DD` `after:YYYY-MM-DD`.
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
    pub subject: Vec<String>,
    pub has_attachment: bool,
    /// `Some(true)` for `is:read`, `Some(false)` for `is:unread`.
    pub read: Option<bool>,
    pub flagged: bool,
    pub before: Option<NaiveDate>,
    pub after: Option<NaiveDate>,
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
                    "from" | "to" | "subject" => {
                        if has_alnum(value) {
                            let list = match name.to_ascii_lowercase().as_str() {
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
                    "is" if lowered == "unread" => {
                        out.read = Some(false);
                        clauses += 1;
                    }
                    "is" if lowered == "read" => {
                        out.read = Some(true);
                        clauses += 1;
                    }
                    "is" if lowered == "flagged" => {
                        out.flagged = true;
                        clauses += 1;
                    }
                    "before" | "after" if parse_date(value).is_some() => {
                        let date = parse_date(value);
                        if name.eq_ignore_ascii_case("before") {
                            out.before = date;
                        } else {
                            out.after = date;
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
            && self.subject.is_empty()
            && !self.has_attachment
            && self.read.is_none()
            && !self.flagged
            && self.before.is_none()
            && self.after.is_none()
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
    pub(crate) fn imap_criteria(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let mut keys = Vec::new();
        let mut ascii = true;
        let operators = [
            ("FROM", &self.from),
            ("TO", &self.to),
            ("SUBJECT", &self.subject),
        ];
        for (key, values) in operators {
            for value in values {
                if let Some(quoted) = imap_quote(value) {
                    ascii &= value.is_ascii();
                    keys.push(format!("{key} {quoted}"));
                }
            }
        }
        match self.read {
            Some(true) => keys.push("SEEN".into()),
            Some(false) => keys.push("UNSEEN".into()),
            None => {}
        }
        if self.flagged {
            keys.push("FLAGGED".into());
        }
        if let Some(date) = self.before {
            keys.push(format!("BEFORE {}", imap_date(date)));
        }
        if let Some(date) = self.after {
            keys.push(format!("SINCE {}", imap_date(date)));
        }
        let text = self
            .plain
            .iter()
            .map(|term| term.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if let Some(quoted) = imap_quote(&text) {
            ascii &= text.is_ascii();
            keys.push(format!("TEXT {quoted}"));
        }
        if keys.is_empty() {
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
        assert!(parsed.has_attachment && parsed.flagged);
        assert_eq!(parsed.read, Some(false));
        assert_eq!(parsed.before, Some(date("2026-09-01")));
        assert_eq!(parsed.after, Some(date("2026-08-01")));
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
        ] {
            let parsed = parse(text);
            assert_eq!(parsed.plain.len(), 1, "{text}");
            assert_eq!(parsed.plain[0].text, text);
            assert!(parsed.from.is_empty() && parsed.before.is_none() && parsed.read.is_none());
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
    }

    #[test]
    fn fts_syntax_stays_literal() {
        let expr = parse("a OR b NEAR(x y) body:* -secret \"unterminated")
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
    }

    #[test]
    fn imap_values_cannot_inject() {
        for input in [
            "from:\"a\\\" OR ALL\r\nA1 LOGOUT\"",
            "subject:x\"y ALL) (OR",
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
                    .all(|word| ["FROM", "TO", "SUBJECT", "TEXT"].contains(&word)),
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
