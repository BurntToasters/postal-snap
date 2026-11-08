//! Files the OS hands to the app: macOS open events, first-launch argv,
//! and second-instance argv. Paths stay in Rust and never cross IPC.
//! Opened messages live in a bounded in-memory store behind opaque tokens.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use mail_parser::MessageParser;
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

use crate::{
    bounded_file::{self, BoundedFileError},
    db,
    mail::{self, list_unsubscribe},
    models::{Attachment, MessageDetail, MessageSummary, OpenedMessage},
};

pub(crate) const MAX_EML_BYTES: usize = 50 * 1024 * 1024;
const MAX_OPEN_TOKENS: usize = 8;
const MAX_OPEN_BYTES: usize = 128 * 1024 * 1024;
pub(crate) const EML_OPENED_EVENT: &str = "eml-opened";
const REFUSED: &str = "That file could not be opened as an email message.";
const TOO_LARGE: &str = "That message is too large to open.";
const NOT_OPEN: &str = "This message is no longer open.";
const ATTACHMENT_MISSING: &str = "Attachment not found.";
const UNREADABLE_PART: &str = "The attachment could not be decoded.";

/// One MIME part of an opened message: its opaque id and its position among
/// the parser's attachments. Position is stable for the same raw bytes.
pub(crate) struct PartRef {
    pub id: String,
    pub index: usize,
}

/// Everything needed to save or preview one attachment of an open message.
pub(crate) struct Lookup {
    pub attachment: Attachment,
    pub index: usize,
    pub raw: Arc<Vec<u8>>,
}

struct Entry {
    token: String,
    message: MessageDetail,
    raw: Arc<Vec<u8>>,
    parts: Vec<PartRef>,
}

/// Least recently used first. Bounded by token count and total raw bytes.
pub(crate) struct OpenedStore {
    entries: Vec<Entry>,
    bytes: usize,
}

impl OpenedStore {
    pub(crate) const fn new() -> Self {
        Self {
            entries: Vec::new(),
            bytes: 0,
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub(crate) fn total_bytes(&self) -> usize {
        self.bytes
    }

    pub(crate) fn insert(
        &mut self,
        message: MessageDetail,
        raw: Vec<u8>,
        parts: Vec<PartRef>,
    ) -> Result<String, String> {
        if raw.len() > MAX_OPEN_BYTES {
            return Err(TOO_LARGE.into());
        }
        let token = Uuid::new_v4().to_string();
        self.bytes += raw.len();
        self.entries.push(Entry {
            token: token.clone(),
            message,
            raw: Arc::new(raw),
            parts,
        });
        while self.entries.len() > MAX_OPEN_TOKENS
            || (self.bytes > MAX_OPEN_BYTES && self.entries.len() > 1)
        {
            let evicted = self.entries.remove(0);
            self.bytes -= evicted.raw.len();
        }
        Ok(token)
    }

    /// Move the entry to the most recent slot and return its new index.
    fn touch(&mut self, token: &str) -> Option<usize> {
        let index = self.entries.iter().position(|entry| entry.token == token)?;
        let entry = self.entries.remove(index);
        self.entries.push(entry);
        Some(self.entries.len() - 1)
    }

    pub(crate) fn get(&mut self, token: &str) -> Option<MessageDetail> {
        let index = self.touch(token)?;
        Some(self.entries[index].message.clone())
    }

    pub(crate) fn remove(&mut self, token: &str) {
        if let Some(index) = self.entries.iter().position(|entry| entry.token == token) {
            let entry = self.entries.remove(index);
            self.bytes -= entry.raw.len();
        }
    }

    pub(crate) fn lookup(&mut self, token: &str, attachment_id: &str) -> Result<Lookup, String> {
        let index = self.touch(token).ok_or_else(|| NOT_OPEN.to_string())?;
        let entry = &self.entries[index];
        let attachment = entry
            .message
            .attachments
            .iter()
            .find(|item| item.id == attachment_id)
            .ok_or_else(|| ATTACHMENT_MISSING.to_string())?;
        let part = entry
            .parts
            .iter()
            .find(|part| part.id == attachment_id)
            .ok_or_else(|| ATTACHMENT_MISSING.to_string())?;
        Ok(Lookup {
            attachment: attachment.clone(),
            index: part.index,
            raw: Arc::clone(&entry.raw),
        })
    }
}

static OPENED: Mutex<OpenedStore> = Mutex::new(OpenedStore::new());

fn with_store<T>(action: impl FnOnce(&mut OpenedStore) -> T) -> T {
    let mut guard = OPENED.lock().unwrap_or_else(|poison| poison.into_inner());
    action(&mut guard)
}

pub fn open_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    for path in paths {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(raw) = read_eml_file(&path).await else {
                return;
            };
            let opened = tauri::async_runtime::spawn_blocking(move || open_bytes(raw)).await;
            if let Ok(Ok(opened)) = opened {
                let _ = app.emit(EML_OPENED_EVENT, eml_opened_payload(&opened.token));
            }
        });
    }
}

/// Read a `.eml` file under the path rules. Errors never name the path.
pub(crate) async fn read_eml_file(path: &Path) -> Result<Vec<u8>, String> {
    let is_eml = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("eml"));
    if !is_eml {
        return Err(REFUSED.into());
    }
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| REFUSED.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(REFUSED.into());
    }
    bounded_file::read_regular_file(path, MAX_EML_BYTES)
        .await
        .map_err(|error| match error {
            BoundedFileError::TooLarge => TOO_LARGE.into(),
            BoundedFileError::Unavailable => REFUSED.into(),
        })
}

/// Parse raw RFC 822 bytes into a stored, tokenized message.
pub(crate) fn open_bytes(raw: Vec<u8>) -> Result<OpenedMessage, String> {
    if raw.len() > MAX_EML_BYTES {
        return Err(TOO_LARGE.into());
    }
    let (message, parts) = build_message(&raw)?;
    let stored = message.clone();
    let token = with_store(|store| store.insert(stored, raw, parts))?;
    Ok(OpenedMessage { token, message })
}

pub(crate) fn get_message(token: &str) -> Result<OpenedMessage, String> {
    with_store(|store| store.get(token))
        .map(|message| OpenedMessage {
            token: token.to_string(),
            message,
        })
        .ok_or_else(|| NOT_OPEN.to_string())
}

pub(crate) fn close_message(token: &str) {
    with_store(|store| store.remove(token));
}

pub(crate) fn lookup_attachment(token: &str, attachment_id: &str) -> Result<Lookup, String> {
    with_store(|store| store.lookup(token, attachment_id))
}

/// Bytes of the attachment at `index`, re-parsed from the stored source.
pub(crate) fn part_bytes(raw: &[u8], index: usize) -> Result<Vec<u8>, String> {
    mail::parse::validate_mime_resource_shape(raw)?;
    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| UNREADABLE_PART.to_string())?;
    let part = message
        .attachments()
        .nth(index)
        .ok_or_else(|| ATTACHMENT_MISSING.to_string())?;
    Ok(part.contents().to_vec())
}

/// Parse raw bytes into the detail and part map. Shared by open and tests.
pub(crate) fn build_message(raw: &[u8]) -> Result<(MessageDetail, Vec<PartRef>), String> {
    let cached = mail::parse::parse_message(0, raw, true, false, None)?;
    let mut parts = Vec::with_capacity(cached.attachments.len());
    let attachments: Vec<Attachment> = cached
        .attachments
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let id = Uuid::new_v4().simple().to_string();
            parts.push(PartRef {
                id: id.clone(),
                index,
            });
            Attachment { id, ..item.clone() }
        })
        .collect();
    let regular_files = attachments.iter().filter(|item| !item.inline).count();
    let summary = MessageSummary {
        id: 0,
        account_id: String::new(),
        mailbox_id: 0,
        uid: 0,
        message_id: cached.message_id.clone(),
        subject: cached.subject.clone(),
        sender_name: cached.sender_name.clone(),
        sender_address: cached.sender_address.clone(),
        recipients: cached.recipients.clone(),
        received_at: cached.received_at.clone(),
        preview: cached.preview.clone(),
        is_read: true,
        is_starred: false,
        has_attachments: cached.has_attachments,
        size: cached.size,
        thread_root: None,
        has_calendar: cached.has_calendar,
        is_answered: false,
        is_forwarded: false,
        conversation_muted: false,
        importance: cached.importance.clone(),
        pinned: false,
        to_me: false,
        arrived_at: String::new(),
        attachment_count: regular_files,
        flag_color: 0,
    };
    let remote_images_blocked = cached
        .html_body
        .as_deref()
        .is_some_and(db::has_remote_images);
    let unsubscribe = list_unsubscribe::options(
        cached.list_unsubscribe.as_deref(),
        cached.list_unsubscribe_post.as_deref(),
    );
    let invite = cached
        .calendar_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok());
    let message = MessageDetail {
        summary,
        to: cached.to,
        cc: cached.cc,
        bcc: cached.bcc,
        reply_to: cached.reply_to,
        text_body: cached.text_body,
        html_body: cached.html_body,
        remote_images_blocked,
        attachments,
        references: Vec::new(),
        body_status: "available".into(),
        unsubscribe,
        list_unsubscribe: cached.list_unsubscribe,
        list_unsubscribe_post: cached.list_unsubscribe_post,
        list_post: list_unsubscribe::list_post_address(raw),
        invite,
        disposition_to: cached.disposition_to,
        receipt_choice: String::new(),
        body_partial: false,
    };
    Ok((message, parts))
}

/// True for `message/rfc822` parts and for any part named `.eml`.
pub(crate) fn is_message_attachment(attachment: &Attachment) -> bool {
    attachment
        .content_type
        .eq_ignore_ascii_case("message/rfc822")
        || attachment.filename.to_ascii_lowercase().ends_with(".eml")
}

pub(crate) fn eml_opened_payload(token: &str) -> serde_json::Value {
    serde_json::json!({ "token": token })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE_EML: &[u8] = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\n\
Content-Type: text/plain\r\n\r\nHello there.\r\n";

    fn html_eml(html: &str) -> Vec<u8> {
        format!(
            "From: a@example.com\r\nTo: b@example.com\r\nSubject: Html\r\n\
Content-Type: text/html\r\n\r\n{html}\r\n"
        )
        .into_bytes()
    }

    fn attachment_eml(name: &str, body: &str) -> Vec<u8> {
        format!(
            "From: a@example.com\r\nTo: b@example.com\r\nSubject: Files\r\n\
MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n\
--B\r\nContent-Type: text/plain\r\n\r\nSee file.\r\n\
--B\r\nContent-Type: text/plain; name=\"{name}\"\r\n\
Content-Disposition: attachment; filename=\"{name}\"\r\n\
Content-Transfer-Encoding: 7bit\r\n\r\n{body}\r\n--B--\r\n"
        )
        .into_bytes()
    }

    fn built(raw: &[u8]) -> (MessageDetail, Vec<PartRef>) {
        super::build_message(raw).expect("fixture parses")
    }

    fn put(store: &mut OpenedStore, raw: Vec<u8>) -> String {
        let (message, parts) = built(&raw);
        store.insert(message, raw, parts).expect("insert")
    }

    fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("write fixture");
        path
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    #[test]
    fn symlink_to_eml_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = write_file(dir.path(), "real.eml", SIMPLE_EML);
        let link = dir.path().join("link.eml");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        #[cfg(not(unix))]
        let _ = target;
        assert_eq!(block_on(read_eml_file(&link)).unwrap_err(), REFUSED);
    }

    #[test]
    fn wrong_extension_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["mail.txt", "mail.eml.txt", "mail"] {
            let path = write_file(dir.path(), name, SIMPLE_EML);
            assert_eq!(
                block_on(read_eml_file(&path)).unwrap_err(),
                REFUSED,
                "{name}"
            );
        }
    }

    #[test]
    fn uppercase_eml_extension_is_accepted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_file(dir.path(), "MAIL.EML", SIMPLE_EML);
        assert_eq!(block_on(read_eml_file(&path)).unwrap(), SIMPLE_EML);
    }

    #[test]
    fn oversize_file_is_refused_before_reading() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("huge.eml");
        let file = std::fs::File::create(&path).expect("create");
        file.set_len(MAX_EML_BYTES as u64 + 1).expect("sparse size");
        assert_eq!(block_on(read_eml_file(&path)).unwrap_err(), TOO_LARGE);
    }

    #[test]
    fn errors_never_contain_the_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let folder = dir.path().join("private-folder-xyz");
        std::fs::create_dir(&folder).expect("mkdir");
        let wrong = write_file(&folder, "secret-name.txt", SIMPLE_EML);
        let huge = folder.join("secret-huge.eml");
        std::fs::File::create(&huge)
            .expect("create")
            .set_len(MAX_EML_BYTES as u64 + 1)
            .expect("sparse size");
        let missing = folder.join("secret-missing.eml");
        for path in [wrong, huge, missing] {
            let error = block_on(read_eml_file(&path)).unwrap_err();
            assert!(!error.contains("private-folder-xyz"), "{error}");
            assert!(!error.contains("secret-"), "{error}");
        }
    }

    #[test]
    fn lru_evicts_oldest_by_token_count() {
        let mut store = OpenedStore::new();
        let tokens: Vec<String> = (0..MAX_OPEN_TOKENS + 1)
            .map(|_| put(&mut store, SIMPLE_EML.to_vec()))
            .collect();
        assert_eq!(store.len(), MAX_OPEN_TOKENS);
        assert!(store.get(&tokens[0]).is_none());
        assert!(store.get(&tokens[MAX_OPEN_TOKENS]).is_some());
    }

    #[test]
    fn lru_get_refreshes_recency_before_eviction() {
        let mut store = OpenedStore::new();
        let first = put(&mut store, SIMPLE_EML.to_vec());
        let second = put(&mut store, SIMPLE_EML.to_vec());
        for _ in 2..MAX_OPEN_TOKENS {
            put(&mut store, SIMPLE_EML.to_vec());
        }
        assert!(store.get(&first).is_some());
        put(&mut store, SIMPLE_EML.to_vec());
        assert!(store.get(&first).is_some());
        assert!(store.get(&second).is_none());
    }

    #[test]
    fn lru_evicts_oldest_by_total_bytes() {
        let mut store = OpenedStore::new();
        let (message, parts) = built(SIMPLE_EML);
        let big = 50 * 1024 * 1024;
        let first = store
            .insert(message.clone(), vec![0; big], parts_clone(&parts))
            .expect("first");
        let second = store
            .insert(message.clone(), vec![0; big], parts_clone(&parts))
            .expect("second");
        let third = store
            .insert(message.clone(), vec![0; big], parts_clone(&parts))
            .expect("third");
        assert!(store.total_bytes() <= MAX_OPEN_BYTES);
        assert!(store.get(&first).is_none());
        assert!(store.get(&second).is_some());
        assert!(store.get(&third).is_some());
    }

    fn parts_clone(parts: &[PartRef]) -> Vec<PartRef> {
        parts
            .iter()
            .map(|part| PartRef {
                id: part.id.clone(),
                index: part.index,
            })
            .collect()
    }

    #[test]
    fn closed_or_unknown_token_is_not_open() {
        let mut store = OpenedStore::new();
        let token = put(&mut store, SIMPLE_EML.to_vec());
        store.remove(&token);
        assert!(store.get(&token).is_none());
        assert_eq!(store.lookup(&token, "x").err().as_deref(), Some(NOT_OPEN));
        assert_eq!(
            store.lookup("never-issued", "x").err().as_deref(),
            Some(NOT_OPEN)
        );
    }

    #[test]
    fn attachment_id_from_token_a_is_refused_for_token_b() {
        let mut store = OpenedStore::new();
        let raw_a = attachment_eml("a.txt", "AAAA");
        let raw_b = attachment_eml("b.txt", "BBBB");
        let token_a = put(&mut store, raw_a.clone());
        let token_b = put(&mut store, raw_b.clone());
        let id_a = store.get(&token_a).expect("a").attachments[0].id.clone();
        let id_b = store.get(&token_b).expect("b").attachments[0].id.clone();
        assert_ne!(id_a, id_b);
        assert_eq!(
            store.lookup(&token_b, &id_a).err().as_deref(),
            Some(ATTACHMENT_MISSING)
        );
        let found = store.lookup(&token_a, &id_a).expect("own id resolves");
        assert_eq!(found.raw.as_slice(), raw_a.as_slice());
    }

    #[test]
    fn script_is_stripped_from_received_html() {
        let raw = html_eml("<p>Hi</p><script>alert(1)</script><img src=x onerror=alert(2)>");
        let (message, _) = built(&raw);
        let html = message.html_body.expect("html body");
        assert!(!html.to_ascii_lowercase().contains("<script"), "{html}");
        assert!(!html.contains("alert(1)"), "{html}");
        assert!(!html.contains("onerror"), "{html}");
    }

    #[test]
    fn nested_message_rfc822_is_listed_not_rendered() {
        let raw = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: Outer\r\n\
MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"OUT\"\r\n\r\n\
--OUT\r\nContent-Type: text/plain\r\n\r\nouter body\r\n\
--OUT\r\nContent-Type: message/rfc822\r\n\r\n\
From: c@example.com\r\nSubject: Inner\r\nContent-Type: text/html\r\n\r\n\
<p>INNER-SECRET</p><script>alert(3)</script>\r\n--OUT--\r\n";
        let (message, parts) = built(raw);
        assert!(message.text_body.contains("outer body"));
        assert!(!message.text_body.contains("INNER-SECRET"));
        assert!(!message
            .html_body
            .as_deref()
            .unwrap_or_default()
            .contains("INNER-SECRET"));
        let nested = message
            .attachments
            .iter()
            .find(|item| item.content_type == "message/rfc822")
            .expect("nested part is listed");
        assert!(is_message_attachment(nested));
        let part = parts
            .iter()
            .find(|part| part.id == nested.id)
            .expect("part ref");
        let bytes = part_bytes(raw, part.index).expect("bytes");
        assert!(String::from_utf8_lossy(&bytes).contains("INNER-SECRET"));
    }

    #[test]
    fn only_message_parts_count_as_message_attachments() {
        let by_type = Attachment {
            id: "1".into(),
            filename: "forward".into(),
            content_type: "message/rfc822".into(),
            size: 1,
            content_id: None,
            inline: false,
        };
        let by_name = Attachment {
            filename: "Forwarded.EML".into(),
            content_type: "application/octet-stream".into(),
            ..by_type.clone()
        };
        let plain = Attachment {
            filename: "notes.txt".into(),
            content_type: "text/plain".into(),
            ..by_type.clone()
        };
        assert!(is_message_attachment(&by_type));
        assert!(is_message_attachment(&by_name));
        assert!(!is_message_attachment(&plain));
    }

    #[test]
    fn event_payload_carries_only_the_token() {
        let payload = eml_opened_payload("tok-1");
        let object = payload.as_object().expect("object");
        assert_eq!(object.len(), 1);
        assert_eq!(object["token"], "tok-1");
    }
}
