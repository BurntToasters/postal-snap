//! RFC 3676 `format=flowed` encoding for plain-text mail.

/// Longest output line, counting the trailing soft-break space.
const MAX_LINE: usize = 72;
const SIGNATURE_MARKER: &str = "-- ";

/// Encode plain text as flowed lines joined by `\n`. Soft breaks end in one
/// space, risky line starts are space-stuffed, and `-- ` stays a fixed line.
pub(crate) fn encode_flowed(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines = Vec::new();
    for line in normalized.split('\n') {
        if line == SIGNATURE_MARKER {
            lines.push(line.to_string());
        } else {
            wrap_line(line.trim_end_matches(' '), &mut lines);
        }
    }
    lines.join("\n")
}

fn needs_stuffing(chars: &[char]) -> bool {
    matches!(chars.first(), Some(' ' | '>')) || chars.starts_with(&['F', 'r', 'o', 'm', ' '])
}

fn push_stuffed(chars: &[char], lines: &mut Vec<String>) {
    let mut line = String::with_capacity(chars.len() + 1);
    if needs_stuffing(chars) {
        line.push(' ');
    }
    line.extend(chars);
    lines.push(line);
}

/// A space that can end a line: real text comes before it.
fn breakable(chars: &[char], index: usize) -> bool {
    chars[index] == ' ' && chars[..index].iter().any(|c| *c != ' ')
}

fn wrap_line(line: &str, lines: &mut Vec<String>) {
    let mut rest: &[char] = &line.chars().collect::<Vec<_>>();
    loop {
        let budget = MAX_LINE - usize::from(needs_stuffing(rest));
        if rest.len() <= budget {
            push_stuffed(rest, lines);
            return;
        }
        // Prefer the last space that fits; a long word may run past the
        // limit but is never cut.
        let cut = (0..budget)
            .rev()
            .find(|&i| breakable(rest, i))
            .or_else(|| (budget..rest.len()).find(|&i| breakable(rest, i)));
        let Some(cut) = cut else {
            push_stuffed(rest, lines);
            return;
        };
        push_stuffed(&rest[..=cut], lines);
        rest = &rest[cut + 1..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure modes this encoder must not have:
    // 1. A line passes 72 chars, or a soft break lacks its trailing space.
    // 2. A hard line ends in a space and is unfolded into the next line.
    // 3. Lines starting with space, ">" or "From " are not stuffed, also
    //    when they start a wrapped continuation.
    // 4. The "-- " signature marker is stripped, stuffed, wrapped or joined.
    // 5. A long unbroken word (URL) is cut in the middle.
    // 6. Blank lines are lost; CR or CRLF input leaks a stray "\r".
    // 7. Wrapping counts bytes and splits a multibyte character.
    // 8. Inner space runs collapse when unfolded.
    // 9. Whitespace-only input is not blank.
    // 10. Unfolding the output does not give back the input.

    /// RFC 3676 receiver: unfold soft breaks, then remove space stuffing.
    fn decode(encoded: &str) -> String {
        let mut out = String::new();
        let lines: Vec<&str> = encoded.split('\n').collect();
        for (index, line) in lines.iter().enumerate() {
            let fixed_sig = *line == "-- ";
            let body = line.strip_prefix(' ').unwrap_or(line);
            out.push_str(body);
            let soft = line.ends_with(' ') && !fixed_sig && index + 1 < lines.len();
            if !soft && index + 1 < lines.len() {
                out.push('\n');
            }
        }
        out
    }

    #[test]
    fn wraps_at_72_with_trailing_space_on_soft_breaks() {
        let text = "word ".repeat(40).trim_end().to_string();
        let encoded = encode_flowed(&text);
        let lines: Vec<&str> = encoded.split('\n').collect();
        assert!(lines.len() > 1);
        for line in &lines[..lines.len() - 1] {
            assert!(line.ends_with(' '), "soft break needs trailing space");
            assert!(line.chars().count() <= 72, "line too long: {line:?}");
        }
        let last = lines.last().unwrap();
        assert!(!last.ends_with(' '), "paragraph end must be a fixed line");
        assert_eq!(decode(&encoded), text);
    }

    #[test]
    fn short_lines_are_untouched() {
        assert_eq!(
            encode_flowed("Hello there\nSecond line"),
            "Hello there\nSecond line"
        );
    }

    #[test]
    fn hard_line_trailing_spaces_are_stripped() {
        assert_eq!(encode_flowed("one   \ntwo"), "one\ntwo");
        assert_eq!(decode(&encode_flowed("one   \ntwo")), "one\ntwo");
    }

    #[test]
    fn stuffs_space_gt_and_from_lines() {
        let encoded = encode_flowed(" indented\n> quoted\nFrom me\nplain");
        assert_eq!(encoded, "  indented\n > quoted\n From me\nplain");
        assert_eq!(decode(&encoded), " indented\n> quoted\nFrom me\nplain");
        assert_eq!(encode_flowed("Fromage"), "Fromage");
    }

    #[test]
    fn stuffs_wrapped_continuations() {
        let text = format!("{} >tail and more words to follow", "x".repeat(66));
        let encoded = encode_flowed(&text);
        let lines: Vec<&str> = encoded.split('\n').collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].starts_with(" >tail"));
        assert_eq!(decode(&encoded), text);
        let from = format!("{} From here on out", "y".repeat(67));
        let encoded = encode_flowed(&from);
        assert!(encoded
            .split('\n')
            .nth(1)
            .unwrap()
            .starts_with(" From here"));
        assert_eq!(decode(&encoded), from);
    }

    #[test]
    fn signature_marker_is_kept_verbatim() {
        let text = "Body text\n\n-- \nSam\nsam@example.com";
        let encoded = encode_flowed(text);
        assert_eq!(encoded, text);
        assert!(encoded.contains("\n-- \n"));
        assert_eq!(decode(&encoded), text);
    }

    #[test]
    fn signature_after_wrapped_paragraph_stays_separate() {
        let text = format!("{}\n-- \nSam", "word ".repeat(30).trim_end());
        let encoded = encode_flowed(&text);
        assert!(encoded.contains("\n-- \nSam"));
        assert_eq!(decode(&encoded), text);
    }

    #[test]
    fn long_words_are_never_split() {
        let url = format!("https://example.com/{}", "a".repeat(200));
        let text = format!("see {url} now");
        let encoded = encode_flowed(&text);
        assert!(encoded.contains(&url));
        assert_eq!(decode(&encoded), text);
        assert_eq!(encode_flowed(&url), url);
    }

    #[test]
    fn blank_lines_stay_hard_breaks() {
        let text = format!("{}\n\nnext", "word ".repeat(20).trim_end());
        let encoded = encode_flowed(&text);
        assert!(encoded.contains("\n\nnext"));
        assert_eq!(decode(&encoded), text);
        assert_eq!(encode_flowed("a\n\n\nb"), "a\n\n\nb");
    }

    #[test]
    fn carriage_returns_are_normalized() {
        assert_eq!(encode_flowed("a\r\nb\rc"), "a\nb\nc");
    }

    #[test]
    fn multibyte_text_wraps_by_characters() {
        let text = "héllo ".repeat(30).trim_end().to_string();
        let encoded = encode_flowed(&text);
        for line in encoded.split('\n') {
            assert!(line.chars().count() <= 72);
        }
        assert_eq!(decode(&encoded), text);
        let cjk = "日本語 ".repeat(40).trim_end().to_string();
        assert_eq!(decode(&encode_flowed(&cjk)), cjk);
    }

    #[test]
    fn inner_space_runs_survive() {
        let text = format!("{}  {}", "a".repeat(70), "b".repeat(20));
        let encoded = encode_flowed(&text);
        assert_eq!(decode(&encoded), text);
        let many = format!("{}{}c", "x ".repeat(35), " ".repeat(6));
        assert_eq!(decode(&encode_flowed(&many)), many);
    }

    #[test]
    fn whitespace_only_input_is_empty() {
        assert_eq!(encode_flowed("   \n  "), "\n");
        assert_eq!(encode_flowed(""), "");
    }

    #[test]
    fn mixed_document_round_trips() {
        let text = String::from(
            "Hi all,\n\n> quoted line\n  indented aside\nFrom the desk of Sam\nA very long paragraph that keeps going and going well past the seventy two column limit so it must be folded into several lines.\n\n-- \nSam",
        );
        assert_eq!(decode(&encode_flowed(&text)), text);
    }
}
