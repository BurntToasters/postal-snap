use std::borrow::Cow;

use imap_proto::types::{
    AttributeValue, BodyStructure, Envelope, MessageSection, Response, SectionPath,
};
use time::OffsetDateTime;

const INTERNAL_DATE_SPACE_PADDED: time::format_description::StaticFormatDescription =
    time::macros::format_description!("[day padding:space]-[month repr:short]-[year] [hour]:[minute]:[second] [offset_hour sign:mandatory][offset_minute]");
const INTERNAL_DATE_ZERO_PADDED: time::format_description::StaticFormatDescription =
    time::macros::format_description!("[day padding:zero]-[month repr:short]-[year] [hour]:[minute]:[second] [offset_hour sign:mandatory][offset_minute]");

use super::{Flag, Seq, Uid};
use crate::types::ResponseData;

fn parse_internal_date(value: &str) -> Option<OffsetDateTime> {
    let normalized = normalize_internal_date(value)?;
    if let Ok(parsed) = OffsetDateTime::parse(&normalized, &INTERNAL_DATE_SPACE_PADDED) {
        return Some(parsed);
    }
    OffsetDateTime::parse(&normalized, &INTERNAL_DATE_ZERO_PADDED).ok()
}

fn normalize_internal_date(value: &str) -> Option<String> {
    let value = value.trim_start_matches(' ');
    let date_end = value.find(' ')?;
    let (date, rest) = value.split_at(date_end);
    let mut parts = date.split('-');
    let day = parts.next()?.parse::<u8>().ok()?;
    let month = parts.next()?;
    let year = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let month = match month.to_ascii_lowercase().as_str() {
        "jan" => "Jan",
        "feb" => "Feb",
        "mar" => "Mar",
        "apr" => "Apr",
        "may" => "May",
        "jun" => "Jun",
        "jul" => "Jul",
        "aug" => "Aug",
        "sep" => "Sep",
        "oct" => "Oct",
        "nov" => "Nov",
        "dec" => "Dec",
        _ => return None,
    };
    Some(format!("{day:>2}-{month}-{year}{rest}"))
}

/// An IMAP [`FETCH` response](https://tools.ietf.org/html/rfc3501#section-7.4.2) that contains
/// data about a particular message.
///
/// This response occurs as the result of a `FETCH` or `STORE`
/// command, as well as by unilateral server decision (e.g., flag updates).
#[derive(Debug)]
pub struct Fetch {
    response: ResponseData,
    /// The ordinal number of this message in its containing mailbox.
    pub message: Seq,

    /// A number expressing the unique identifier of the message.
    /// Only present if `UID` was specified in the query argument to `FETCH` and the server
    /// supports UIDs.
    pub uid: Option<Uid>,

    /// A number expressing the [RFC-2822](https://tools.ietf.org/html/rfc2822) size of the message.
    /// Only present if `RFC822.SIZE` was specified in the query argument to `FETCH`.
    pub size: Option<u32>,

    /// A number expressing the [RFC-7162](https://tools.ietf.org/html/rfc7162) mod-sequence
    /// of the message.
    pub modseq: Option<u64>,
}

impl Fetch {
    pub(crate) fn new(response: ResponseData) -> Self {
        let (message, uid, size, modseq) =
            if let Response::Fetch(message, attrs) = response.parsed() {
                let mut uid = None;
                let mut size = None;
                let mut modseq = None;

                for attr in attrs {
                    match attr {
                        AttributeValue::Uid(id) => uid = Some(*id),
                        AttributeValue::Rfc822Size(sz) => size = Some(*sz),
                        AttributeValue::ModSeq(ms) => modseq = Some(*ms),
                        _ => {}
                    }
                }
                (*message, uid, size, modseq)
            } else {
                unreachable!()
            };

        Fetch {
            response,
            message,
            uid,
            size,
            modseq,
        }
    }

    /// A list of flags that are set for this message.
    pub fn flags(&self) -> impl Iterator<Item = Flag<'_>> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|attr| match attr {
                    AttributeValue::Flags(raw_flags) => {
                        Some(raw_flags.iter().map(|s| Flag::from(s.as_ref())))
                    }
                    _ => None,
                })
                .flatten()
        } else {
            unreachable!()
        }
    }

    /// The bytes that make up the header of this message, if `BODY[HEADER]`, `BODY.PEEK[HEADER]`,
    /// or `RFC822.HEADER` was included in the `query` argument to `FETCH`.
    pub fn header(&self) -> Option<&[u8]> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::BodySection {
                        section: Some(SectionPath::Full(MessageSection::Header)),
                        data: Some(hdr),
                        ..
                    }
                    | AttributeValue::Rfc822Header(Some(hdr)) => Some(hdr.as_ref()),
                    _ => None,
                })
                .next()
        } else {
            unreachable!()
        }
    }

    /// The bytes that make up this message, included if `BODY[]` or `RFC822` was included in the
    /// `query` argument to `FETCH`. The bytes SHOULD be interpreted by the client according to the
    /// content transfer encoding, body type, and subtype.
    pub fn body(&self) -> Option<&[u8]> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::BodySection {
                        section: None,
                        data: Some(body),
                        ..
                    }
                    | AttributeValue::Rfc822(Some(body)) => Some(body.as_ref()),
                    _ => None,
                })
                .next()
        } else {
            unreachable!()
        }
    }

    /// The bytes that make up the text of this message, included if `BODY[TEXT]`, `RFC822.TEXT`,
    /// or `BODY.PEEK[TEXT]` was included in the `query` argument to `FETCH`. The bytes SHOULD be
    /// interpreted by the client according to the content transfer encoding, body type, and
    /// subtype.
    pub fn text(&self) -> Option<&[u8]> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::BodySection {
                        section: Some(SectionPath::Full(MessageSection::Text)),
                        data: Some(body),
                        ..
                    }
                    | AttributeValue::Rfc822Text(Some(body)) => Some(body.as_ref()),
                    _ => None,
                })
                .next()
        } else {
            unreachable!()
        }
    }

    /// The envelope of this message, if `ENVELOPE` was included in the `query` argument to
    /// `FETCH`. This is computed by the server by parsing the
    /// [RFC-2822](https://tools.ietf.org/html/rfc2822) header into the component parts, defaulting
    /// various fields as necessary.
    ///
    /// The full description of the format of the envelope is given in [RFC 3501 section
    /// 7.4.2](https://tools.ietf.org/html/rfc3501#section-7.4.2).
    pub fn envelope(&self) -> Option<&Envelope<'_>> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::Envelope(env) => Some(&**env),
                    _ => None,
                })
                .next()
        } else {
            unreachable!()
        }
    }

    /// Extract the bytes that makes up the given `BOD[<section>]` of a `FETCH` response.
    ///
    /// See [section 7.4.2 of RFC 3501](https://tools.ietf.org/html/rfc3501#section-7.4.2) for
    /// details.
    pub fn section(&self, path: &SectionPath) -> Option<&[u8]> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::BodySection {
                        section: Some(sp),
                        data: Some(data),
                        ..
                    } if sp == path => Some(data.as_ref()),
                    _ => None,
                })
                .next()
        } else {
            unreachable!()
        }
    }

    /// Extract the `INTERNALDATE` of a `FETCH` response
    ///
    /// See [section 2.3.3 of RFC 3501](https://tools.ietf.org/html/rfc3501#section-2.3.3) for
    /// details.
    pub fn internal_date(&self) -> Option<OffsetDateTime> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::InternalDate(date_time) => Some(date_time.as_ref()),
                    _ => None,
                })
                .next()
                .and_then(|date_time| parse_internal_date(date_time))
        } else {
            unreachable!()
        }
    }

    /// Extract the `BODYSTRUCTURE` of a `FETCH` response
    ///
    /// See [section 2.3.6 of RFC 3501](https://tools.ietf.org/html/rfc3501#section-2.3.6) for
    /// details.
    pub fn bodystructure(&self) -> Option<&BodyStructure<'_>> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::BodyStructure(bs) => Some(bs),
                    _ => None,
                })
                .next()
        } else {
            unreachable!()
        }
    }

    /// Extract the `X-GM-LABELS` of a `FETCH` response
    ///
    /// See [Access to Gmail labels: X-GM-LABELS](https://developers.google.com/gmail/imap/imap-extensions#access_to_labels_x-gm-labels)
    /// for details.
    pub fn gmail_labels(&self) -> Option<&Vec<Cow<'_, str>>> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::GmailLabels(gl) => Some(gl),
                    _ => None,
                })
                .next()
        } else {
            unreachable!()
        }
    }

    /// Extract the `X-GM-MSGID` of a `FETCH` response
    ///
    /// See [Access to the Gmail unique message ID: X-GM-MSGID](https://developers.google.com/workspace/gmail/imap/imap-extensions#access_to_the_unique_message_id_x-gm-msgid)
    /// for details.
    pub fn gmail_msg_id(&self) -> Option<&u64> {
        if let Response::Fetch(_, attrs) = self.response.parsed() {
            attrs
                .iter()
                .filter_map(|av| match av {
                    AttributeValue::GmailMsgId(id) => Some(id),
                    _ => None,
                })
                .next()
        } else {
            unreachable!()
        }
    }
}

#[cfg(test)]
mod date_tests {
    use super::{Fetch, ResponseData};
    use bytes::BytesMut;
    use time::format_description::well_known::Rfc3339;

    fn fetch_with_internal_date(value: &str) -> Fetch {
        let block = BytesMut::from(format!("* 1 FETCH (INTERNALDATE \"{value}\")\r\n").as_bytes());
        let response = ResponseData::try_new(block, |bytes| -> std::io::Result<_> {
            let (remaining, response) = imap_proto::parser::parse_response(bytes).unwrap();
            assert!(remaining.is_empty());
            Ok(response)
        })
        .unwrap();
        Fetch::new(response)
    }

    #[test]
    fn internal_date_accepts_space_and_zero_padded_days_with_offsets() {
        for value in [" 7-Mar-2026 01:02:03 +0545", "07-Mar-2026 01:02:03 +0545"] {
            assert_eq!(
                fetch_with_internal_date(value)
                    .internal_date()
                    .unwrap()
                    .format(&Rfc3339)
                    .unwrap(),
                "2026-03-07T01:02:03+05:45"
            );
        }
    }

    #[test]
    fn internal_date_rejects_impossible_or_malformed_dates() {
        for value in [
            "31-Feb-2026 01:02:03 +0000",
            "7-Xyz-2026 01:02:03 +0000",
            "7-Mar-2026 25:02:03 +0000",
        ] {
            assert!(fetch_with_internal_date(value).internal_date().is_none());
        }
    }
}
