// Failure modes, written before the parser:
// - input over 64 KiB or an unbounded line count is parsed
// - folded lines are not unfolded; escapes (\, \; \n) stay in the text
// - a second VEVENT or a VALARM property overrides the event
// - a quoted parameter containing ':' breaks the name/value split
// - date-only, UTC "Z", and TZID values are mishandled; bad dates pass
// - a missing DTEND fails the invite
// - ORGANIZER without mailto:/'@' is shown as an address
// - unknown METHOD/STATUS text is echoed into the UI
// - control characters and very long fields pass through
// - non-calendar text or an empty calendar yields an invite

use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

pub(crate) const MAX_ICS_BYTES: usize = 64 * 1024;
pub(crate) const MAX_LINES: usize = 1000;
const MAX_LINE_CHARS: usize = 4096;
pub(crate) const MAX_TEXT_CHARS: usize = 300;
const MAX_TZID_CHARS: usize = 64;
const MAX_EMAIL_CHARS: usize = 254;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsTime {
    /// `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS`, or the same with a trailing `Z`.
    pub iso: String,
    pub all_day: bool,
    pub utc: bool,
    pub tzid: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInvite {
    pub method: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub start: Option<IcsTime>,
    pub end: Option<IcsTime>,
    pub location: Option<String>,
    pub organizer_name: Option<String>,
    pub organizer_email: Option<String>,
}

const METHODS: [&str; 8] = [
    "PUBLISH",
    "REQUEST",
    "REPLY",
    "ADD",
    "CANCEL",
    "REFRESH",
    "COUNTER",
    "DECLINECOUNTER",
];
const STATUSES: [&str; 3] = ["TENTATIVE", "CONFIRMED", "CANCELLED"];

fn unfold_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix([' ', '\t']) {
            if let Some(last) = lines.last_mut() {
                if last.chars().count() < MAX_LINE_CHARS {
                    last.push_str(rest);
                }
                continue;
            }
        }
        if lines.len() >= MAX_LINES {
            break;
        }
        lines.push(line.to_string());
    }
    lines
}

/// Split `NAME;PARAM=v:value` at the first ':' outside double quotes.
type Params = Vec<(String, String)>;

fn split_property(line: &str) -> Option<(String, Params, &str)> {
    let mut in_quotes = false;
    let mut colon = None;
    for (index, ch) in line.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                colon = Some(index);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut pieces = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in head.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            ';' if !quoted => pieces.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    pieces.push(current);
    let mut pieces = pieces.into_iter();
    let name = pieces.next()?.trim().to_ascii_uppercase();
    let params = pieces
        .filter_map(|piece| {
            let (key, val) = piece.split_once('=')?;
            Some((
                key.trim().to_ascii_uppercase(),
                val.trim().trim_matches('"').to_string(),
            ))
        })
        .collect();
    Some((name, params, value))
}

fn is_hidden_format(ch: char) -> bool {
    matches!(ch, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

fn clean_text(value: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        let ch = if ch == '\\' {
            match chars.next() {
                Some('n' | 'N') => '\n',
                Some(other) => other,
                None => break,
            }
        } else {
            ch
        };
        if ch == '\n' || (!ch.is_control() && !is_hidden_format(ch)) {
            out.push(ch);
        }
        if out.chars().count() >= MAX_TEXT_CHARS {
            break;
        }
    }
    let out: String = out.chars().take(MAX_TEXT_CHARS).collect();
    let trimmed = out.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn parse_time(params: &[(String, String)], value: &str) -> Option<IcsTime> {
    let value = value.trim();
    let date_only = params
        .iter()
        .any(|(key, val)| key == "VALUE" && val.eq_ignore_ascii_case("DATE"));
    if date_only || (value.len() == 8 && !value.contains('T')) {
        let date = NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        return Some(IcsTime {
            iso: date.format("%Y-%m-%d").to_string(),
            all_day: true,
            utc: false,
            tzid: None,
        });
    }
    let (body, utc) = match value.strip_suffix(['Z', 'z']) {
        Some(body) => (body, true),
        None => (value, false),
    };
    let stamp = NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S").ok()?;
    let tzid = params
        .iter()
        .find(|(key, _)| key == "TZID")
        .map(|(_, val)| val.as_str())
        .filter(|val| {
            !utc && !val.is_empty()
                && val.chars().count() <= MAX_TZID_CHARS
                && val
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "/_+-. ".contains(c))
        })
        .map(str::to_string);
    let mut iso = stamp.format("%Y-%m-%dT%H:%M:%S").to_string();
    if utc {
        iso.push('Z');
    }
    Some(IcsTime {
        iso,
        all_day: false,
        utc,
        tzid,
    })
}

fn organizer(params: &[(String, String)], value: &str, invite: &mut CalendarInvite) {
    let address = value.trim();
    let address = address
        .get(..7)
        .filter(|prefix| prefix.eq_ignore_ascii_case("mailto:"))
        .map(|_| address[7..].trim());
    if let Some(address) = address {
        let valid = address.contains('@')
            && !address.starts_with('@')
            && !address.ends_with('@')
            && address.chars().count() <= MAX_EMAIL_CHARS
            && !address.chars().any(|c| c.is_whitespace() || c.is_control());
        if valid {
            invite.organizer_email = Some(address.to_string());
        }
    }
    invite.organizer_name = params
        .iter()
        .find(|(key, _)| key == "CN")
        .and_then(|(_, val)| clean_text(val));
}

/// Bounded parse of the first VEVENT. Returns `None` when nothing displayable
/// is found.
pub fn parse_invite(bytes: &[u8]) -> Option<CalendarInvite> {
    if bytes.is_empty() || bytes.len() > MAX_ICS_BYTES {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    let mut invite = CalendarInvite::default();
    let mut depth = 0usize;
    let mut event_state = 0u8; // 0 unseen, 1 inside, 2 finished
    let mut saw_calendar = false;
    for line in unfold_lines(&text) {
        let Some((name, params, value)) = split_property(&line) else {
            continue;
        };
        match name.as_str() {
            "BEGIN" => {
                let component = value.trim().to_ascii_uppercase();
                depth += 1;
                if component == "VCALENDAR" && depth == 1 {
                    saw_calendar = true;
                } else if component == "VEVENT" && depth == 2 && event_state == 0 {
                    event_state = 1;
                }
                continue;
            }
            "END" => {
                let component = value.trim().to_ascii_uppercase();
                if component == "VEVENT" && depth == 2 && event_state == 1 {
                    event_state = 2;
                }
                depth = depth.saturating_sub(1);
                continue;
            }
            _ => {}
        }
        if !saw_calendar {
            continue;
        }
        if depth == 1 && name == "METHOD" {
            let method = value.trim().to_ascii_uppercase();
            invite.method = METHODS.contains(&method.as_str()).then_some(method);
        } else if depth == 2 && event_state == 1 {
            match name.as_str() {
                "SUMMARY" => invite.summary = clean_text(value),
                "LOCATION" => invite.location = clean_text(value),
                "DTSTART" => invite.start = parse_time(&params, value),
                "DTEND" => invite.end = parse_time(&params, value),
                "ORGANIZER" => organizer(&params, value, &mut invite),
                "STATUS" => {
                    let status = value.trim().to_ascii_uppercase();
                    invite.status = STATUSES.contains(&status.as_str()).then_some(status);
                }
                _ => {}
            }
        }
    }
    (event_state > 0 && (invite.summary.is_some() || invite.start.is_some())).then_some(invite)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrap(event: &str) -> Vec<u8> {
        format!("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n{event}END:VEVENT\r\nEND:VCALENDAR\r\n")
            .into_bytes()
    }

    #[test]
    fn parses_core_fields_and_utc_times() {
        let raw = wrap(
            "SUMMARY:Planning\r\nDTSTART:20261001T150000Z\r\nDTEND:20261001T160000Z\r\n\
             LOCATION:Room 4\r\nORGANIZER;CN=Sam Lee:mailto:sam@example.com\r\nSTATUS:CONFIRMED\r\n",
        );
        let invite = parse_invite(&raw).unwrap();
        assert_eq!(invite.method.as_deref(), Some("REQUEST"));
        assert_eq!(invite.status.as_deref(), Some("CONFIRMED"));
        assert_eq!(invite.summary.as_deref(), Some("Planning"));
        assert_eq!(invite.location.as_deref(), Some("Room 4"));
        assert_eq!(invite.organizer_name.as_deref(), Some("Sam Lee"));
        assert_eq!(invite.organizer_email.as_deref(), Some("sam@example.com"));
        let start = invite.start.unwrap();
        assert_eq!(start.iso, "2026-10-01T15:00:00Z");
        assert!(start.utc && !start.all_day && start.tzid.is_none());
        assert_eq!(invite.end.unwrap().iso, "2026-10-01T16:00:00Z");
    }

    #[test]
    fn date_only_tzid_and_floating_times() {
        let raw = wrap("DTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261002\r\n");
        let invite = parse_invite(&raw).unwrap();
        let start = invite.start.unwrap();
        assert_eq!((start.iso.as_str(), start.all_day), ("2026-10-01", true));
        let raw = wrap("SUMMARY:x\r\nDTSTART;TZID=America/New_York:20261001T090000\r\n");
        let start = parse_invite(&raw).unwrap().start.unwrap();
        assert_eq!(start.iso, "2026-10-01T09:00:00");
        assert_eq!(start.tzid.as_deref(), Some("America/New_York"));
        assert!(!start.utc);
        let raw = wrap("SUMMARY:x\r\nDTSTART:20261001T090000\r\n");
        let start = parse_invite(&raw).unwrap().start.unwrap();
        assert!(start.tzid.is_none() && !start.utc);
        assert!(parse_invite(&wrap("SUMMARY:x\r\n")).unwrap().end.is_none());
    }

    #[test]
    fn rejects_impossible_dates_and_bad_tzid() {
        let raw = wrap("SUMMARY:x\r\nDTSTART:20261340T150000Z\r\nDTEND:2026\r\n");
        let invite = parse_invite(&raw).unwrap();
        assert!(invite.start.is_none() && invite.end.is_none());
        let raw = wrap("SUMMARY:x\r\nDTSTART;TZID=<script>:20261001T090000\r\n");
        assert!(parse_invite(&raw).unwrap().start.unwrap().tzid.is_none());
    }

    #[test]
    fn unfolds_and_unescapes() {
        let raw = wrap(
            "SUMMARY:Budget\r\n  review\\, Q4\\; final\\nline\\\\end\r\nDESCRIPTION:ignored\r\n",
        );
        let summary = parse_invite(&raw).unwrap().summary.unwrap();
        assert_eq!(summary, "Budget review, Q4; final\nline\\end");
    }

    #[test]
    fn only_the_first_event_and_never_alarm_fields() {
        let raw = b"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:First\r\n\
            BEGIN:VALARM\r\nSUMMARY:Alarm text\r\nEND:VALARM\r\nLOCATION:Here\r\nEND:VEVENT\r\n\
            BEGIN:VEVENT\r\nSUMMARY:Second\r\nLOCATION:There\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let invite = parse_invite(raw).unwrap();
        assert_eq!(invite.summary.as_deref(), Some("First"));
        assert_eq!(invite.location.as_deref(), Some("Here"));
    }

    #[test]
    fn quoted_params_and_case_insensitive_names() {
        let raw = wrap(
            "summary:Lower\r\norganizer;CN=\"Doe: Jane\";ROLE=CHAIR:MAILTO:jane@example.com\r\n",
        );
        let invite = parse_invite(&raw).unwrap();
        assert_eq!(invite.summary.as_deref(), Some("Lower"));
        assert_eq!(invite.organizer_name.as_deref(), Some("Doe: Jane"));
        assert_eq!(invite.organizer_email.as_deref(), Some("jane@example.com"));
    }

    #[test]
    fn organizer_must_be_a_mailto_address() {
        let raw = wrap("SUMMARY:x\r\nORGANIZER:https://evil.example/x\r\n");
        assert!(parse_invite(&raw).unwrap().organizer_email.is_none());
        let raw = wrap("SUMMARY:x\r\nORGANIZER:mailto:not-an-address\r\n");
        assert!(parse_invite(&raw).unwrap().organizer_email.is_none());
    }

    #[test]
    fn unknown_method_and_status_are_dropped() {
        let raw = b"BEGIN:VCALENDAR\r\nMETHOD:<b>hi</b>\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nSTATUS:EVIL\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let invite = parse_invite(raw).unwrap();
        assert!(invite.method.is_none() && invite.status.is_none());
        let cancel = b"BEGIN:VCALENDAR\r\nMETHOD:cancel\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(
            parse_invite(cancel).unwrap().method.as_deref(),
            Some("CANCEL")
        );
    }

    #[test]
    fn caps_size_lines_and_field_length() {
        let big = vec![b'a'; MAX_ICS_BYTES + 1];
        assert!(parse_invite(&big).is_none());
        let mut many = String::from("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n");
        for _ in 0..(MAX_LINES + 50) {
            many.push_str("X-FILL:1\r\n");
        }
        many.push_str("SUMMARY:late\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
        assert!(parse_invite(many.as_bytes()).is_none());
        let long = "y".repeat(2000);
        let raw = wrap(&format!("SUMMARY:{long}\r\nLOCATION:{long}\r\n"));
        let invite = parse_invite(&raw).unwrap();
        assert_eq!(invite.summary.unwrap().chars().count(), MAX_TEXT_CHARS);
        assert_eq!(invite.location.unwrap().chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn strips_control_characters() {
        let raw = wrap("SUMMARY:a\u{0007}b\u{202e}c\r\n");
        assert_eq!(parse_invite(&raw).unwrap().summary.as_deref(), Some("abc"));
    }

    #[test]
    fn non_calendar_or_empty_input_is_none() {
        assert!(parse_invite(b"hello world").is_none());
        assert!(parse_invite(b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").is_none());
        assert!(parse_invite(&wrap("X-OTHER:1\r\n")).is_none());
        assert!(parse_invite(b"").is_none());
    }
}
