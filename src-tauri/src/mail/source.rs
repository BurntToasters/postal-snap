// Failure modes, written before the code:
// - body lines containing ':' are listed as headers (header block must end
//   at the first blank line, CRLF or LF)
// - folded header lines are not unfolded
// - header count, name length, or value length is unbounded
// - a malformed name (spaces, control characters) is shown as a header
// - invalid UTF-8 panics or is rejected instead of shown lossily
// - display truncation splits a UTF-8 character or is not flagged
// - empty input panics

use serde::Serialize;

pub(crate) const MAX_DISPLAY_BYTES: usize = 1024 * 1024;
const MAX_HEADERS: usize = 200;
const MAX_NAME_CHARS: usize = 100;
const MAX_VALUE_CHARS: usize = 2000;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SourceHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSource {
    pub headers: Vec<SourceHeader>,
    pub source: String,
    pub truncated: bool,
    pub size: u64,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && name.chars().all(|c| c.is_ascii_graphic() && c != ':')
}

/// Parsed view of the header block for display. Values stay undecoded.
pub(crate) fn split_source_headers(raw: &[u8]) -> Vec<SourceHeader> {
    let text = String::from_utf8_lossy(raw);
    let mut logical: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            break;
        }
        if line.starts_with([' ', '\t']) {
            if let Some(last) = logical.last_mut() {
                last.push(' ');
                last.push_str(line.trim());
            }
            continue;
        }
        if logical.len() >= MAX_HEADERS * 2 {
            break;
        }
        logical.push(line.to_string());
    }
    logical
        .into_iter()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            valid_name(name).then(|| SourceHeader {
                name: name.to_string(),
                value: value.trim().chars().take(MAX_VALUE_CHARS).collect(),
            })
        })
        .take(MAX_HEADERS)
        .collect()
}

pub(crate) fn build_source(raw: &[u8]) -> MessageSource {
    let mut end = raw.len().min(MAX_DISPLAY_BYTES);
    if end < raw.len() {
        while end > 0 && (raw[end] & 0xC0) == 0x80 {
            end -= 1;
        }
    }
    MessageSource {
        headers: split_source_headers(raw),
        source: String::from_utf8_lossy(&raw[..end]).into_owned(),
        truncated: end < raw.len(),
        size: raw.len() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_block_ends_at_first_blank_line() {
        let raw = b"From: a@example.com\r\nSubject: Hi\r\n\r\nNot-A-Header: body\r\n";
        let headers = split_source_headers(raw);
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[1].name, "Subject");
        let lf = b"A: 1\nB: 2\n\nC: 3\n";
        assert_eq!(split_source_headers(lf).len(), 2);
    }

    #[test]
    fn unfolds_continuations() {
        let raw = b"Subject: one\r\n two\r\n\tthree\r\nTo: x@example.com\r\n\r\n";
        let headers = split_source_headers(raw);
        assert_eq!(headers[0].value, "one two three");
        assert_eq!(headers[1].name, "To");
    }

    #[test]
    fn bounds_count_name_and_value() {
        let mut raw = String::new();
        for i in 0..(MAX_HEADERS + 20) {
            raw.push_str(&format!("X-H{i}: v\r\n"));
        }
        raw.push_str("\r\n");
        assert_eq!(split_source_headers(raw.as_bytes()).len(), MAX_HEADERS);
        let long = format!("X-Long: {}\r\n\r\n", "v".repeat(5000));
        let headers = split_source_headers(long.as_bytes());
        assert_eq!(headers[0].value.chars().count(), MAX_VALUE_CHARS);
        let name = format!("{}: v\r\n\r\n", "N".repeat(300));
        assert!(split_source_headers(name.as_bytes()).is_empty());
    }

    #[test]
    fn malformed_names_are_dropped() {
        let raw = b"Bad Name: x\r\nOk-Name: y\r\nno colon line\r\n\r\n";
        let headers = split_source_headers(raw);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].name, "Ok-Name");
    }

    #[test]
    fn invalid_utf8_is_lossy_and_empty_is_fine() {
        let raw = b"Subject: caf\xe9\r\n\r\nbody";
        assert!(split_source_headers(raw)[0].value.starts_with("caf"));
        assert!(split_source_headers(b"").is_empty());
        let source = build_source(b"");
        assert!(source.source.is_empty() && !source.truncated && source.size == 0);
    }

    #[test]
    fn truncation_respects_char_boundaries_and_is_flagged() {
        let mut raw = vec![b'a'; MAX_DISPLAY_BYTES - 1];
        raw.extend_from_slice("é".as_bytes());
        raw.extend_from_slice(b"tail");
        let source = build_source(&raw);
        assert!(source.truncated);
        assert!(source.source.len() <= MAX_DISPLAY_BYTES);
        assert_eq!(source.size, raw.len() as u64);
        let small = build_source(b"Subject: x\r\n\r\nhi");
        assert!(!small.truncated);
    }
}
