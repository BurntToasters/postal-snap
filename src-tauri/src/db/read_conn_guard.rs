//! Guard for the `read_conn` invariant (AGENTS.md): pure reads must not take
//! the writer connection, or they wait behind sync writes.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::Path;

/// Functions that read through `conn()` on purpose, keyed by `file::fn`.
/// Each entry needs a reason. Entries that no longer match fail the guard.
const WRITER_READ_ALLOWLIST: &[(&str, &str)] = &[(
    "db.rs::maintain_search_index",
    "recover_fts_index may rebuild the FTS index, which writes",
)];

/// Words that mean a body may write. Matched as whole tokens, any case.
const WRITE_WORDS: &[&str] = &[
    "insert",
    "update",
    "delete",
    "replace",
    "create",
    "drop",
    "vacuum",
    "pragma",
    "execute",
    "savepoint",
];

struct FnBody {
    name: String,
    /// Body with comments and literal contents blanked, for braces and calls.
    code: Vec<char>,
    /// Body with comments blanked and literals kept, for SQL words.
    text: Vec<char>,
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn chars_eq(chars: &[char], at: usize, word: &str) -> bool {
    let word: Vec<char> = word.chars().collect();
    chars.get(at..at + word.len()) == Some(&word[..])
}

fn blank(chars: &mut [char], start: usize, end: usize) {
    for c in &mut chars[start..end] {
        if *c != '\n' {
            *c = ' ';
        }
    }
}

/// Start of a raw string at `i`: returns (content start, closing delimiter).
fn raw_string_open(chars: &[char], i: usize) -> Option<(usize, String)> {
    if chars[i] != 'r' {
        return None;
    }
    let prev = if i == 0 { None } else { Some(chars[i - 1]) };
    if prev.is_some_and(|p| is_ident(p) && p != 'b') {
        return None;
    }
    let hashes = chars[i + 1..].iter().take_while(|&&c| c == '#').count();
    if chars.get(i + 1 + hashes) != Some(&'"') {
        return None;
    }
    Some((i + 2 + hashes, format!("\"{}", "#".repeat(hashes))))
}

fn find_seq(chars: &[char], from: usize, pattern: &str) -> Option<usize> {
    let pattern: Vec<char> = pattern.chars().collect();
    (from..chars.len()).find(|&j| chars.get(j..j + pattern.len()) == Some(&pattern[..]))
}

/// Returns (code, text) with the same length as `source`.
fn mask(source: &str) -> (Vec<char>, Vec<char>) {
    let chars: Vec<char> = source.chars().collect();
    let len = chars.len();
    let mut code = chars.clone();
    let mut text = chars.clone();
    let mut i = 0;
    while i < len {
        let next = chars.get(i + 1).copied();
        if chars[i] == '/' && next == Some('/') {
            let end = (i..len).find(|&j| chars[j] == '\n').unwrap_or(len);
            blank(&mut code, i, end);
            blank(&mut text, i, end);
            i = end;
        } else if chars[i] == '/' && next == Some('*') {
            let end = find_seq(&chars, i + 2, "*/").map_or(len, |j| j + 2);
            blank(&mut code, i, end);
            blank(&mut text, i, end);
            i = end;
        } else if let Some((content, close)) = raw_string_open(&chars, i) {
            let close_at = find_seq(&chars, content, &close).unwrap_or(len);
            blank(&mut code, content, close_at);
            i = (close_at + close.chars().count()).min(len);
        } else if chars[i] == '"' {
            let mut j = i + 1;
            while j < len && chars[j] != '"' {
                j += if chars[j] == '\\' { 2 } else { 1 };
            }
            let j = j.min(len);
            blank(&mut code, i + 1, j);
            i = j + 1;
        } else if chars[i] == '\'' && next == Some('\\') {
            let close = (i + 3..len).find(|&j| chars[j] == '\'').unwrap_or(len);
            blank(&mut code, i + 1, close);
            i = close + 1;
        } else if chars[i] == '\'' && chars.get(i + 2) == Some(&'\'') {
            blank(&mut code, i + 1, i + 2);
            i += 3;
        } else {
            // Lifetimes and plain code.
            i += 1;
        }
    }
    (code, text)
}

/// Body span of a `fn` whose name ends at `from`; `None` for declarations.
fn body_span(code: &[char], from: usize) -> Option<(usize, usize)> {
    let mut depth = 0i32;
    let mut open = None;
    for (j, &c) in code.iter().enumerate().skip(from) {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            ';' if depth == 0 => return None,
            '{' if depth == 0 => {
                open = Some(j);
                break;
            }
            _ => {}
        }
    }
    let open = open?;
    let mut level = 0;
    for (j, &c) in code.iter().enumerate().skip(open) {
        match c {
            '{' => level += 1,
            '}' => {
                level -= 1;
                if level == 0 {
                    return Some((open, j));
                }
            }
            _ => {}
        }
    }
    None
}

/// End (exclusive) of the item starting at `from`: a `;` or a braced body.
fn item_end(code: &[char], from: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (j, &c) in code.iter().enumerate().skip(from) {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            ';' if depth == 0 => return Some(j + 1),
            '{' if depth == 0 => return body_span(code, j).map(|(_, close)| close + 1),
            _ => {}
        }
    }
    None
}

/// Blanks `#[cfg(test)]` items so test helpers are not counted as production reads.
fn blank_test_items(code: &mut [char], text: &mut [char]) {
    let mut i = 0;
    while let Some(at) = find_seq(code, i, "#[cfg(test)]") {
        let end = item_end(code, at).unwrap_or(code.len());
        blank(code, at, end);
        blank(text, at, end);
        i = end;
    }
}

fn fn_bodies(source: &str) -> Vec<FnBody> {
    let (mut code, mut text) = mask(source);
    blank_test_items(&mut code, &mut text);
    let mut bodies = Vec::new();
    for i in 0..code.len() {
        let starts_fn = chars_eq(&code, i, "fn")
            && (i == 0 || !is_ident(code[i - 1]))
            && code.get(i + 2).is_some_and(|c| c.is_whitespace());
        if !starts_fn {
            continue;
        }
        let name_start = (i + 2..code.len())
            .find(|&j| !code[j].is_whitespace())
            .unwrap_or(code.len());
        let name_end = (name_start..code.len())
            .find(|&j| !is_ident(code[j]))
            .unwrap_or(code.len());
        if name_start == name_end {
            continue;
        }
        if let Some((open, close)) = body_span(&code, name_end) {
            bodies.push(FnBody {
                name: code[name_start..name_end].iter().collect(),
                code: code[open..=close].to_vec(),
                text: text[open..=close].to_vec(),
            });
        }
    }
    bodies
}

fn has_write_word(text: &[char]) -> bool {
    let mut i = 0;
    while i < text.len() {
        if !is_ident(text[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < text.len() && is_ident(text[i]) {
            i += 1;
        }
        let token: String = text[start..i]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        if WRITE_WORDS.contains(&token.as_str()) {
            return true;
        }
        let call_follows = text[i..].iter().find(|c| !c.is_whitespace()) == Some(&'(');
        if token.ends_with("transaction") && call_follows {
            return true;
        }
    }
    false
}

/// Keys (`file::fn`) of bodies that call `.conn()` and contain no write word.
fn writer_reads(sources: &[(String, String)]) -> Vec<String> {
    let mut keys = BTreeSet::new();
    for (file, source) in sources {
        for body in fn_bodies(source) {
            let code: String = body.code.iter().collect();
            if code.contains(".conn()") && !has_write_word(&body.text) {
                keys.insert(format!("{file}::{}", body.name));
            }
        }
    }
    keys.into_iter().collect()
}

/// Production db sources: `db.rs` and `db/*.rs`, minus this guard and the test module.
fn db_sources() -> Vec<(String, String)> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![src.join("db.rs")];
    for entry in std::fs::read_dir(src.join("db")).expect("read src/db") {
        let path = entry.expect("read src/db entry").path();
        let name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
        let skipped = matches!(name, "read_conn_guard.rs" | "tests.rs");
        if path.extension() == Some(OsStr::new("rs")) && !skipped {
            files.push(path);
        }
    }
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let label = path
                .strip_prefix(&src)
                .expect("path under src")
                .to_string_lossy()
                .replace('\\', "/");
            let source = std::fs::read_to_string(&path).expect("read db source");
            (label, source)
        })
        .collect()
}

#[test]
fn pure_reads_stay_off_the_writer() {
    let found = writer_reads(&db_sources());
    let offenders: Vec<&String> = found
        .iter()
        .filter(|key| {
            !WRITER_READ_ALLOWLIST
                .iter()
                .any(|(allowed, _)| allowed == key)
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "pure reads must use read_conn(), or go on the allowlist with a reason:\n{}",
        offenders
            .iter()
            .map(|key| key.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn writer_read_allowlist_has_no_stale_entries() {
    let found = writer_reads(&db_sources());
    for (key, reason) in WRITER_READ_ALLOWLIST {
        assert!(!reason.trim().is_empty(), "{key} needs a reason");
        assert!(
            found.iter().any(|f| f == key),
            "{key} no longer reads through the writer; remove its allowlist entry"
        );
    }
}

fn writer_reads_in(source: &str) -> Vec<String> {
    writer_reads(&[("fixture.rs".to_string(), source.to_string())])
}

#[test]
fn scanner_flags_pure_read_on_writer() {
    let source = r#"impl Database { fn lookup(&self) -> u32 { let c = self.conn(); c.query_row("SELECT updated_at FROM t", [], |r| r.get(0)) } }"#;
    assert_eq!(writer_reads_in(source), ["fixture.rs::lookup"]);
}

#[test]
fn scanner_ignores_conn_mentioned_in_comment_or_string() {
    let source = r#"fn a(&self) { // self.conn()
        let s = "x.conn()"; self.read_conn(); }"#;
    assert!(writer_reads_in(source).is_empty());
}

#[test]
fn scanner_accepts_write_words_and_transactions() {
    let source = r#"fn w(&self) { let c = self.conn(); c.execute("DELETE FROM t", []); }
        fn t(&self) { let c = self.conn(); c.unchecked_transaction(); }"#;
    assert!(writer_reads_in(source).is_empty());
}

#[test]
fn scanner_skips_braces_inside_literals() {
    let source =
        r#"fn b(&self) -> u8 { let _ = "}"; let _ = '}'; let _ = '\''; let c = self.conn(); 0 }"#;
    assert_eq!(writer_reads_in(source), ["fixture.rs::b"]);
}

#[test]
fn scanner_treats_lifetimes_as_code() {
    let source = r#"fn l<'a>(&self, x: &'a str) { let c = self.conn(); let _ = (c, x); }"#;
    assert_eq!(writer_reads_in(source), ["fixture.rs::l"]);
}

#[test]
fn scanner_skips_cfg_test_items() {
    let source = r#"#[cfg(test)] mod t { fn h(db: &Database) { db.conn(); } }
        #[cfg(test)] fn k(&self) { self.conn(); }"#;
    assert!(writer_reads_in(source).is_empty());
}

#[test]
fn scanner_skips_declarations_and_try_conn() {
    let source = r#"trait T { fn x(&self) -> u8; }
        fn t(&self) { let _ = self.try_conn(); }"#;
    assert!(writer_reads_in(source).is_empty());
}
