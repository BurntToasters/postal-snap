//! mboxrd reader and writer for mailbox import and export.
//!
//! Each record starts with a `From ` line and ends with one blank line. Body
//! lines matching `^>*From ` gain one `>` on write and lose one on read.

use std::io::{self, BufRead, Read, Write};

use chrono::{DateTime, Utc};

use crate::mail::MAX_MESSAGE_BYTES;

/// One message, the same ceiling the mail cache already enforces.
pub(crate) const MAX_RECORD_BYTES: usize = MAX_MESSAGE_BYTES;
pub(crate) const MAX_RECORDS: usize = 10_000;
pub(crate) const MAX_IMPORT_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_EXPORT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MboxError {
    NotMbox,
    TooManyRecords,
    OutputTooLarge,
    Io,
}

impl std::fmt::Display for MboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotMbox => write!(f, "That file is not an mbox mailbox."),
            Self::TooManyRecords => write!(
                f,
                "That mailbox has too many messages for one file. The limit is 10,000."
            ),
            Self::OutputTooLarge => write!(
                f,
                "The mailbox is too large for one export file. The limit is 4 GiB."
            ),
            Self::Io => write!(f, "Postal Snap could not read or write that file."),
        }
    }
}

impl From<io::Error> for MboxError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

/// One record from a reader. Oversize and truncated records are reported
/// instead of being returned, so callers count them as skipped.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Record {
    Message(Vec<u8>),
    Oversize,
    Truncated,
}

/// The mbox `From ` line time, in UTC. Bad dates fall back to now.
pub(crate) fn asctime_for(received_at: &str) -> String {
    let when = DateTime::parse_from_rfc3339(received_at)
        .map(|time| time.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    when.format("%a %b %e %H:%M:%S %Y").to_string()
}

/// Bytes after the `>` run of a line.
fn unquoted(line: &[u8]) -> &[u8] {
    let quotes = line.iter().take_while(|&&byte| byte == b'>').count();
    &line[quotes..]
}

/// Write one record and return the bytes written. The raw message keeps its
/// own line endings; a missing final newline is added, then one blank line.
pub(crate) fn write_record<W: Write>(out: &mut W, raw: &[u8], asctime: &str) -> io::Result<u64> {
    let head = format!("From MAILER-DAEMON {asctime}\n");
    out.write_all(head.as_bytes())?;
    let mut written = head.len() as u64;
    for line in raw.split_inclusive(|&byte| byte == b'\n') {
        if unquoted(line).starts_with(b"From ") {
            out.write_all(b">")?;
            written += 1;
        }
        out.write_all(line)?;
        written += line.len() as u64;
    }
    if !raw.ends_with(b"\n") {
        out.write_all(b"\n")?;
        written += 1;
    }
    out.write_all(b"\n")?;
    Ok(written + 1)
}

/// Drop one `>` from a body line that the writer quoted.
fn unescape(line: &[u8]) -> &[u8] {
    let quotes = line.iter().take_while(|&&byte| byte == b'>').count();
    if quotes > 0 && line[quotes..].starts_with(b"From ") {
        &line[1..]
    } else {
        line
    }
}

enum LineRead {
    Eof,
    Line { complete: bool },
    Overflow { complete: bool },
}

/// Read one line of at most `cap` bytes. A longer line is discarded through
/// its newline, so one huge line cannot grow memory without bound.
fn read_line<R: BufRead>(input: &mut R, line: &mut Vec<u8>, cap: usize) -> io::Result<LineRead> {
    line.clear();
    let read = input
        .by_ref()
        .take(cap as u64 + 1)
        .read_until(b'\n', line)?;
    if read == 0 {
        return Ok(LineRead::Eof);
    }
    if line.last() == Some(&b'\n') {
        return Ok(LineRead::Line { complete: true });
    }
    if line.len() <= cap {
        return Ok(LineRead::Line { complete: false });
    }
    line.clear();
    loop {
        let buffer = input.fill_buf()?;
        if buffer.is_empty() {
            return Ok(LineRead::Overflow { complete: false });
        }
        match buffer.iter().position(|&byte| byte == b'\n') {
            Some(index) => {
                input.consume(index + 1);
                return Ok(LineRead::Overflow { complete: true });
            }
            None => {
                let len = buffer.len();
                input.consume(len);
            }
        }
    }
}

/// Streaming mboxrd reader. Records are yielded one at a time.
pub(crate) struct MboxReader<R: BufRead> {
    input: R,
    max_record_bytes: usize,
    max_records: usize,
    started: bool,
    /// A `From ` line was consumed and starts the next record.
    pending: bool,
    pending_partial: bool,
    records: usize,
    done: bool,
}

impl<R: BufRead> MboxReader<R> {
    pub(crate) fn new(input: R) -> Self {
        Self::with_limits(input, MAX_RECORD_BYTES, MAX_RECORDS)
    }

    pub(crate) fn with_limits(input: R, max_record_bytes: usize, max_records: usize) -> Self {
        Self {
            input,
            max_record_bytes,
            max_records,
            started: false,
            pending: false,
            pending_partial: false,
            records: 0,
            done: false,
        }
    }

    pub(crate) fn into_inner(self) -> R {
        self.input
    }

    pub(crate) fn next_record(&mut self) -> Result<Option<Record>, MboxError> {
        if self.done {
            return Ok(None);
        }
        let mut line = Vec::new();
        if !self.started {
            self.started = true;
            match read_line(&mut self.input, &mut line, self.max_record_bytes)? {
                LineRead::Eof => {
                    self.done = true;
                    return Ok(None);
                }
                LineRead::Overflow { .. } => return Err(MboxError::NotMbox),
                LineRead::Line { complete } => {
                    if !line.starts_with(b"From ") {
                        return Err(MboxError::NotMbox);
                    }
                    self.pending = true;
                    self.pending_partial = !complete;
                }
            }
        }
        if !self.pending {
            self.done = true;
            return Ok(None);
        }
        self.pending = false;
        let mut truncated = self.pending_partial;
        let mut oversize = false;
        let mut body = Vec::new();
        let mut last_blank = false;
        let mut last_len = 0usize;
        loop {
            match read_line(&mut self.input, &mut line, self.max_record_bytes)? {
                LineRead::Eof => {
                    self.done = true;
                    break;
                }
                LineRead::Overflow { complete } => {
                    oversize = true;
                    truncated |= !complete;
                    body.clear();
                    last_blank = false;
                }
                LineRead::Line { complete } => {
                    if line.starts_with(b"From ") {
                        self.pending = true;
                        self.pending_partial = !complete;
                        break;
                    }
                    if !complete {
                        truncated = true;
                    }
                    if oversize {
                        continue;
                    }
                    if body.len() + line.len() > self.max_record_bytes {
                        oversize = true;
                        body.clear();
                        last_blank = false;
                        continue;
                    }
                    let kept = unescape(&line);
                    last_blank = line == b"\n" || line == b"\r\n";
                    last_len = kept.len();
                    body.extend_from_slice(kept);
                }
            }
        }
        self.records += 1;
        if self.records > self.max_records {
            self.done = true;
            return Err(MboxError::TooManyRecords);
        }
        if truncated {
            return Ok(Some(Record::Truncated));
        }
        if oversize {
            return Ok(Some(Record::Oversize));
        }
        if last_blank {
            body.truncate(body.len() - last_len);
        }
        Ok(Some(Record::Message(body)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn read_all(bytes: &[u8]) -> Result<Vec<Record>, MboxError> {
        read_all_with(bytes, MAX_RECORD_BYTES, MAX_RECORDS)
    }

    fn read_all_with(
        bytes: &[u8],
        max_record: usize,
        max_records: usize,
    ) -> Result<Vec<Record>, MboxError> {
        let mut reader = MboxReader::with_limits(Cursor::new(bytes), max_record, max_records);
        let mut out = Vec::new();
        while let Some(record) = reader.next_record()? {
            out.push(record);
        }
        Ok(out)
    }

    fn message(bytes: &[u8]) -> Record {
        Record::Message(bytes.to_vec())
    }

    fn write_one(raw: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        write_record(&mut out, raw, "Sat Nov  7 10:00:00 2026").unwrap();
        out
    }

    #[test]
    fn from_line_inside_body_is_quoted_on_write() {
        let out = write_one(b"Hi\nFrom bob\n");
        assert!(out
            .windows(b"\n>From bob\n".len())
            .any(|w| w == b"\n>From bob\n"));
    }

    #[test]
    fn quoted_from_lines_gain_one_gt_and_read_back() {
        let out = write_one(b">From x\n");
        assert!(out
            .windows(b"\n>>From x\n".len())
            .any(|w| w == b"\n>>From x\n"));
        let records = read_all(&out).unwrap();
        assert_eq!(records, vec![message(b">From x\n")]);
    }

    #[test]
    fn reader_unescapes_only_one_gt() {
        let records = read_all(b"From M\n>>From y\n\n").unwrap();
        assert_eq!(records, vec![message(b">From y\n")]);
    }

    #[test]
    fn from_colon_and_indented_from_are_not_separators_or_quoted() {
        let records = read_all(b"From M\nFrom: x\n  From y\n\n").unwrap();
        assert_eq!(records, vec![message(b"From: x\n  From y\n")]);
        let out = write_one(b"From: x\n  From y\n");
        assert!(!out.windows(2).any(|w| w == b">F"));
    }

    #[test]
    fn crlf_separator_and_body_are_tolerated() {
        let records = read_all(b"From M\r\nSubject: a\r\n\r\nbody\r\n\r\n").unwrap();
        assert_eq!(records, vec![message(b"Subject: a\r\n\r\nbody\r\n")]);
    }

    #[test]
    fn truncated_last_record_is_reported_not_returned_as_message() {
        let records = read_all(b"From M\nSubject: a\n\nFrom N\nSubject: b\n\nbod").unwrap();
        assert_eq!(records, vec![message(b"Subject: a\n"), Record::Truncated]);
    }

    #[test]
    fn partial_separator_line_at_eof_marks_record_truncated() {
        let records = read_all(b"From M\nSubject: a\n\nFrom N").unwrap();
        assert_eq!(records, vec![message(b"Subject: a\n"), Record::Truncated]);
    }

    #[test]
    fn oversize_record_is_skipped_and_stream_continues() {
        let records = read_all_with(
            b"From a\nAAAAAAAAAAAAAAAAAAAAAAAA\n\nFrom b\nok\n\n",
            8,
            MAX_RECORDS,
        )
        .unwrap();
        assert_eq!(records, vec![Record::Oversize, message(b"ok\n")]);
    }

    #[test]
    fn overlong_line_inside_small_record_does_not_stop_reader() {
        let records =
            read_all_with(b"From a\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\nmore\n\n", 8, 10).unwrap();
        assert_eq!(records, vec![Record::Oversize]);
    }

    #[test]
    fn record_count_cap_fails_closed_before_extra_records() {
        let result = read_all_with(b"From a\n\nFrom b\n\nFrom c\n\n", MAX_RECORD_BYTES, 2);
        assert_eq!(result, Err(MboxError::TooManyRecords));
    }

    #[test]
    fn non_mbox_file_is_rejected() {
        assert_eq!(read_all(b"Subject: x\n\nbody\n"), Err(MboxError::NotMbox));
    }

    #[test]
    fn empty_file_has_no_records() {
        assert_eq!(read_all(b""), Ok(Vec::new()));
    }

    #[test]
    fn round_trip_is_byte_equal_for_tricky_bodies() {
        let messages: Vec<&[u8]> = vec![
            b"Subject: one\r\n\r\nCRLF body\r\n",
            b"Subject: two\n\nFrom here\n>From there\n>>From deeper\nend\n",
            b"Subject: three\n\nFrom \nFrom: no\n",
        ];
        let mut file = Vec::new();
        let mut written = 0u64;
        for raw in &messages {
            written += write_record(&mut file, raw, "Sat Nov  7 10:00:00 2026").unwrap();
        }
        assert_eq!(written, file.len() as u64);
        let records = read_all(&file).unwrap();
        let expected: Vec<Record> = messages.iter().map(|raw| message(raw)).collect();
        assert_eq!(records, expected);
    }

    #[test]
    fn asctime_has_mbox_shape_and_survives_bad_dates() {
        assert_eq!(
            asctime_for("2026-11-07T10:00:00Z"),
            "Sat Nov  7 10:00:00 2026"
        );
        assert_eq!(asctime_for("nonsense").len(), 24);
    }
}
