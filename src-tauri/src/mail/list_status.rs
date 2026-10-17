//! LIST-STATUS (RFC 5819): folder discovery and every folder's STATUS in one
//! round trip.
//!
//! async-imap's `list` cannot send RETURN options. Its STATUS replies inside a
//! list land in the unsolicited channel, which holds 100 items and drops the
//! rest. This module reads the raw response stream until the tagged
//! completion instead.
//!
//! Failure modes this module must survive:
//! - NO or BAD ends the command cleanly, so the caller falls back;
//! - a STATUS missing a required item rejects the whole reply;
//! - a reply longer than `MAX_RESPONSES` is never read to its end, so the
//!   session is dropped instead of trusted;
//! - a stream that ends before the tagged completion is never success.

use std::collections::HashMap;

use async_imap::types::{Mailbox, NameAttribute};
use imap_proto::{MailboxDatum, RequestId, Response, Status, StatusAttribute};

use super::{ImapSession, IMAP_COMMAND_TIMEOUT};

/// Most untagged responses read before the reply is treated as hostile.
pub(super) const MAX_RESPONSES: usize = 10_000;

/// Why a LIST-STATUS attempt gave no usable answer.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ListStatusError {
    /// NO or BAD: the command finished cleanly and the session is in sync.
    Refused,
    /// A malformed or incomplete reply, read to its tagged end: session in sync.
    Rejected,
    /// Timeout, socket error, or an unbounded reply: protocol state unknown.
    Broken,
}

/// One LIST entry as the server spelled it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ListedName {
    /// Raw wire spelling, the key STATUS replies use.
    pub wire_name: String,
    pub delimiter: Option<String>,
    pub attributes: Vec<String>,
}

#[derive(Debug, Default, PartialEq)]
pub(super) struct ListReply {
    pub names: Vec<ListedName>,
    /// Keyed by raw wire name.
    pub statuses: HashMap<String, Mailbox>,
}

/// The LIST command with RETURN options. SPECIAL-USE is requested only when
/// the server advertises it.
pub(super) fn command_line(special_use: bool, status_items: &str) -> String {
    let attributes = if special_use { "SPECIAL-USE " } else { "" };
    format!("LIST \"\" \"*\" RETURN ({attributes}STATUS {status_items})")
}

/// Attribute names in the same spelling the legacy LIST path produces.
pub(super) fn attribute_names(attributes: &[NameAttribute<'_>]) -> Vec<String> {
    attributes
        .iter()
        .map(|attribute| match attribute {
            NameAttribute::NoSelect => "NoSelect".to_string(),
            NameAttribute::NoInferiors => "NoInferiors".to_string(),
            NameAttribute::Marked => "Marked".to_string(),
            NameAttribute::Unmarked => "Unmarked".to_string(),
            NameAttribute::Extension(value) => value.to_string(),
            _ => format!("{attribute:?}"),
        })
        .collect()
}

/// A mailbox from STATUS items. None when a required item is missing.
pub(super) fn mailbox_from_status(attributes: &[StatusAttribute]) -> Option<Mailbox> {
    let mut messages = None;
    let mut unseen = None;
    let mut uid_next = None;
    let mut uid_validity = None;
    let mut highest_modseq = None;
    for attribute in attributes {
        match attribute {
            StatusAttribute::Messages(value) => messages = Some(*value),
            StatusAttribute::Unseen(value) => unseen = Some(*value),
            StatusAttribute::UidNext(value) => uid_next = Some(*value),
            StatusAttribute::UidValidity(value) => uid_validity = Some(*value),
            StatusAttribute::HighestModSeq(value) => highest_modseq = Some(*value),
            _ => {}
        }
    }
    Some(Mailbox {
        exists: messages?,
        unseen: Some(unseen?),
        uid_next: Some(uid_next?),
        uid_validity: Some(uid_validity?),
        highest_modseq,
        ..Default::default()
    })
}

/// Collects one LIST-STATUS reply, one parsed response at a time.
pub(super) struct Collector {
    expected: RequestId,
    reply: ListReply,
    responses: usize,
    rejected: bool,
}

impl Collector {
    pub(super) fn new(expected: RequestId) -> Self {
        Self {
            expected,
            reply: ListReply::default(),
            responses: 0,
            rejected: false,
        }
    }

    /// Feed one response. Some(result) once the tagged completion arrives.
    pub(super) fn push(
        &mut self,
        response: &Response<'_>,
    ) -> Option<Result<ListReply, ListStatusError>> {
        self.responses += 1;
        if self.responses > MAX_RESPONSES {
            return Some(Err(ListStatusError::Broken));
        }
        match response {
            Response::Done { tag, status, .. } if tag == &self.expected => Some(match status {
                Status::Ok if self.rejected => Err(ListStatusError::Rejected),
                Status::Ok => Ok(std::mem::take(&mut self.reply)),
                Status::No | Status::Bad => Err(ListStatusError::Refused),
                _ => Err(ListStatusError::Broken),
            }),
            Response::MailboxData(MailboxDatum::List {
                name_attributes,
                delimiter,
                name,
            }) => {
                self.reply.names.push(ListedName {
                    wire_name: name.to_string(),
                    delimiter: delimiter.as_ref().map(|value| value.to_string()),
                    attributes: attribute_names(name_attributes),
                });
                None
            }
            Response::MailboxData(MailboxDatum::Status { mailbox, status }) => {
                match mailbox_from_status(status) {
                    Some(counts) => {
                        self.reply.statuses.insert(mailbox.to_string(), counts);
                    }
                    None => self.rejected = true,
                }
                None
            }
            _ => None,
        }
    }
}

/// Run LIST-STATUS and read the reply to its tagged completion.
pub(super) async fn fetch(
    session: &mut ImapSession,
    status_items: &str,
    special_use: bool,
) -> Result<ListReply, ListStatusError> {
    let command = command_line(special_use, status_items);
    let id = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.run_command(&command))
        .await
        .map_err(|_| ListStatusError::Broken)?
        .map_err(|_| ListStatusError::Broken)?;
    let mut collector = Collector::new(id);
    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, async {
        loop {
            let response = session
                .read_response()
                .await
                .map_err(|_| ListStatusError::Broken)?
                .ok_or(ListStatusError::Broken)?;
            if let Some(done) = collector.push(response.parsed()) {
                return done;
            }
        }
    })
    .await
    .map_err(|_| ListStatusError::Broken)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(lines: &[String]) -> Vec<Response<'_>> {
        lines
            .iter()
            .map(|line| {
                Response::from_bytes(line.as_bytes())
                    .expect("fixture line parses")
                    .1
            })
            .collect()
    }

    fn tagged(status: &str) -> String {
        format!("A0001 {status} LIST completed\r\n")
    }

    fn run(lines: &[String]) -> Result<ListReply, ListStatusError> {
        let mut collector = Collector::new(RequestId("A0001".to_string()));
        for response in parse(lines) {
            if let Some(done) = collector.push(&response) {
                return done;
            }
        }
        Err(ListStatusError::Broken)
    }

    #[test]
    fn keeps_every_status_past_the_unsolicited_limit() {
        // async-imap drops items past 100; the raw reader must keep all 150.
        let mut lines = Vec::new();
        for index in 0..150 {
            lines.push(format!(
                "* LIST (\\HasNoChildren) \"/\" \"Folder {index}\"\r\n"
            ));
            lines.push(format!(
                "* STATUS \"Folder {index}\" (MESSAGES {index} UNSEEN 1 UIDNEXT {} UIDVALIDITY 42)\r\n",
                index + 1
            ));
        }
        lines.push(tagged("OK"));
        let reply = run(&lines).expect("complete reply");
        assert_eq!(reply.names.len(), 150);
        assert_eq!(reply.statuses.len(), 150);
        let last = &reply.statuses["Folder 149"];
        assert_eq!(last.exists, 149);
        assert_eq!(last.unseen, Some(1));
        assert_eq!(last.uid_next, Some(150));
        assert_eq!(last.uid_validity, Some(42));
    }

    #[test]
    fn no_or_bad_completion_refuses_so_the_caller_falls_back() {
        let list = "* LIST () \"/\" \"INBOX\"\r\n".to_string();
        let status =
            "* STATUS \"INBOX\" (MESSAGES 1 UNSEEN 0 UIDNEXT 2 UIDVALIDITY 7)\r\n".to_string();
        assert_eq!(
            run(&[list.clone(), status.clone(), tagged("NO")]),
            Err(ListStatusError::Refused)
        );
        assert_eq!(
            run(&[list, status, tagged("BAD")]),
            Err(ListStatusError::Refused)
        );
    }

    #[test]
    fn status_missing_a_required_item_rejects_the_whole_reply() {
        let lines = vec![
            "* LIST () \"/\" \"INBOX\"\r\n".to_string(),
            "* STATUS \"INBOX\" (MESSAGES 1 UNSEEN 0 UIDNEXT 2)\r\n".to_string(),
            tagged("OK"),
        ];
        assert_eq!(run(&lines), Err(ListStatusError::Rejected));
    }

    #[test]
    fn malformed_status_line_is_a_parse_error_not_a_panic() {
        let line = b"* STATUS \"INBOX\" (MESSAGES nope)\r\n";
        assert!(Response::from_bytes(line).is_err());
    }

    #[test]
    fn stream_without_tagged_completion_is_not_success() {
        let mut collector = Collector::new(RequestId("A0001".to_string()));
        let lines = vec!["* LIST () \"/\" \"INBOX\"\r\n".to_string()];
        for response in parse(&lines) {
            assert!(collector.push(&response).is_none());
        }
    }

    #[test]
    fn responses_past_the_bound_drop_the_session() {
        let mut collector = Collector::new(RequestId("A0001".to_string()));
        let noise = Response::Data {
            status: Status::Ok,
            code: None,
            information: None,
        };
        let mut outcome = None;
        for _ in 0..=MAX_RESPONSES {
            outcome = collector.push(&noise);
            if outcome.is_some() {
                break;
            }
        }
        assert_eq!(outcome, Some(Err(ListStatusError::Broken)));
    }

    #[test]
    fn command_requests_special_use_only_when_advertised() {
        let items = "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ)";
        assert_eq!(
            command_line(true, items),
            "LIST \"\" \"*\" RETURN (SPECIAL-USE STATUS (MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ))"
        );
        assert_eq!(
            command_line(false, "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)"),
            "LIST \"\" \"*\" RETURN (STATUS (MESSAGES UNSEEN UIDNEXT UIDVALIDITY))"
        );
    }

    #[test]
    fn mailbox_from_status_needs_counts_and_uids_but_not_modseq() {
        let (_, response) = Response::from_bytes(
            b"* STATUS \"INBOX\" (MESSAGES 4 UNSEEN 2 UIDNEXT 9 UIDVALIDITY 3)\r\n",
        )
        .expect("fixture parses");
        let Response::MailboxData(MailboxDatum::Status { status, .. }) = response else {
            panic!("expected STATUS");
        };
        let mailbox = mailbox_from_status(&status).expect("complete status");
        assert_eq!(mailbox.exists, 4);
        assert_eq!(mailbox.highest_modseq, None);

        let partial = [StatusAttribute::Messages(4), StatusAttribute::Unseen(2)];
        assert!(mailbox_from_status(&partial).is_none());
    }
}
