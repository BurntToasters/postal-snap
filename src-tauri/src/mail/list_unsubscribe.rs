// Failure modes, written before the parser:
// - a header over 2 KiB is truncated, not dropped (a cut URL may differ)
// - more than 4 URIs are kept
// - http:, javascript:, data:, ftp:, tel: URIs survive
// - https URLs with credentials survive
// - mailto with no address or with CR/LF survives
// - text outside angle brackets is read as a URI; folds are not undone
// - a loose Post header (case, trailing text) enables one-click
// - one-click is offered without an https target
// - a Post header without List-Unsubscribe yields options
// - the one-click URL comes from anywhere but the stored header

use serde::{Deserialize, Serialize};
use url::Url;

const MAX_HEADER_BYTES: usize = 2048;
const MAX_POST_BYTES: usize = 64;
const MAX_URI_BYTES: usize = 1024;
const MAX_MAILTO_BYTES: usize = 512;
pub(crate) const MAX_URIS: usize = 4;
/// The only RFC 8058 value that enables one-click.
pub(crate) const ONE_CLICK_BODY: &str = "List-Unsubscribe=One-Click";

/// What the reader may offer for a message. Built only from stored headers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeOptions {
    pub one_click: bool,
    pub https_url: Option<String>,
    pub https_host: Option<String>,
    pub mailto: Option<String>,
}

fn unfold(raw: &str) -> String {
    raw.replace(['\r', '\n'], "").trim().to_string()
}

enum Uri {
    Https(Url),
    Mailto(String),
}

fn accept(candidate: &str) -> Option<Uri> {
    let candidate = candidate.trim();
    if candidate.is_empty()
        || candidate.len() > MAX_URI_BYTES
        || candidate
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    let scheme = candidate.split(':').next()?.to_ascii_lowercase();
    match scheme.as_str() {
        "https" => {
            let url = Url::parse(candidate).ok()?;
            let clean = url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.host_str().is_some_and(|host| !host.is_empty());
            clean.then_some(Uri::Https(url))
        }
        "mailto" => {
            let rest = &candidate["mailto:".len()..];
            let address = rest.split('?').next().unwrap_or_default();
            let valid = candidate.len() <= MAX_MAILTO_BYTES
                && address.contains('@')
                && !address.starts_with('@')
                && !address.ends_with('@');
            valid.then(|| Uri::Mailto(format!("mailto:{rest}")))
        }
        _ => None,
    }
}

fn accepted_uris(raw: &str) -> Vec<Uri> {
    let value = unfold(raw);
    if value.is_empty() || value.len() > MAX_HEADER_BYTES {
        return Vec::new();
    }
    let mut uris = Vec::new();
    let mut rest = value.as_str();
    while let Some(start) = rest.find('<') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('>') else { break };
        if let Some(uri) = accept(&after[..end]) {
            uris.push(uri);
            if uris.len() == MAX_URIS {
                break;
            }
        }
        rest = &after[end + 1..];
    }
    uris
}

/// Bounded, re-serialized header: only accepted URIs, in original order.
pub(crate) fn normalize_list_unsubscribe(raw: &str) -> Option<String> {
    let uris = accepted_uris(raw);
    if uris.is_empty() {
        return None;
    }
    let parts = uris
        .iter()
        .map(|uri| match uri {
            Uri::Https(url) => format!("<{}>", url.as_str()),
            Uri::Mailto(value) => format!("<{value}>"),
        })
        .collect::<Vec<_>>();
    Some(parts.join(", "))
}

pub(crate) fn normalize_post(raw: &str) -> Option<String> {
    let value = unfold(raw);
    (!value.is_empty() && value.len() <= MAX_POST_BYTES).then_some(value)
}

/// One-click target: first https URI, and only with the exact Post value.
pub(crate) fn one_click_url(list: &str, post: Option<&str>) -> Option<Url> {
    if post.map(str::trim) != Some(ONE_CLICK_BODY) {
        return None;
    }
    accepted_uris(list).into_iter().find_map(|uri| match uri {
        Uri::Https(url) => Some(url),
        Uri::Mailto(_) => None,
    })
}

pub fn options(list: Option<&str>, post: Option<&str>) -> Option<UnsubscribeOptions> {
    let list = list?;
    let uris = accepted_uris(list);
    let https = uris.iter().find_map(|uri| match uri {
        Uri::Https(url) => Some(url.clone()),
        Uri::Mailto(_) => None,
    });
    let mailto = uris.iter().find_map(|uri| match uri {
        Uri::Mailto(value) => Some(value.clone()),
        Uri::Https(_) => None,
    });
    if https.is_none() && mailto.is_none() {
        return None;
    }
    Some(UnsubscribeOptions {
        one_click: one_click_url(list, post).is_some(),
        https_host: https
            .as_ref()
            .and_then(|url| url.host_str().map(str::to_string)),
        https_url: https.map(|url| url.to_string()),
        mailto,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const POST: &str = "List-Unsubscribe=One-Click";

    #[test]
    fn keeps_only_https_and_mailto() {
        let raw = "<https://a.example/u?id=1>, <mailto:unsub@a.example?subject=x>, \
                   <http://a.example/plain>, <javascript:alert(1)>, <data:text/html,x>, \
                   <ftp://a.example/x>, <tel:123>";
        let value = normalize_list_unsubscribe(raw).unwrap();
        assert_eq!(
            value,
            "<https://a.example/u?id=1>, <mailto:unsub@a.example?subject=x>"
        );
    }

    #[test]
    fn drops_credentials_and_bad_mailto() {
        assert_eq!(
            normalize_list_unsubscribe("<https://user:pw@a.example/u>"),
            None
        );
        assert_eq!(
            normalize_list_unsubscribe("<https://user@a.example/u>"),
            None
        );
        assert_eq!(normalize_list_unsubscribe("<mailto:>"), None);
        assert_eq!(normalize_list_unsubscribe("<mailto:no-at-sign>"), None);
        assert_eq!(
            normalize_list_unsubscribe("<mailto:a@b.example?subject=x\r\nBcc: z@z.example>"),
            None
        );
    }

    #[test]
    fn oversize_header_is_dropped_not_truncated() {
        let long = format!("<https://a.example/{}>", "x".repeat(2100));
        assert_eq!(normalize_list_unsubscribe(&long), None);
        let ok = format!("<https://a.example/{}>", "x".repeat(1000));
        assert!(normalize_list_unsubscribe(&ok).is_some());
    }

    #[test]
    fn caps_uri_count_and_ignores_unbracketed_text() {
        let raw = (0..9)
            .map(|i| format!("<https://a{i}.example/u>"))
            .collect::<Vec<_>>()
            .join(", ");
        let value = normalize_list_unsubscribe(&raw).unwrap();
        assert_eq!(value.matches("https://").count(), MAX_URIS);
        assert_eq!(normalize_list_unsubscribe("https://a.example/u"), None);
        assert_eq!(normalize_list_unsubscribe(""), None);
    }

    #[test]
    fn unfolds_header_lines() {
        let raw = "<https://a.example/u>,\r\n <mailto:u@a.example>";
        let value = normalize_list_unsubscribe(raw).unwrap();
        assert!(value.contains("mailto:u@a.example"));
    }

    #[test]
    fn post_header_must_match_exactly() {
        assert_eq!(normalize_post(POST).as_deref(), Some(POST));
        assert_eq!(
            normalize_post(" List-Unsubscribe=One-Click \r\n").as_deref(),
            Some(POST)
        );
        assert_eq!(normalize_post(&"x".repeat(200)), None);
        assert_eq!(normalize_post(""), None);
        let list = "<https://a.example/u>";
        assert!(one_click_url(list, Some(POST)).is_some());
        assert!(one_click_url(list, Some("list-unsubscribe=one-click")).is_none());
        assert!(one_click_url(list, Some("List-Unsubscribe=One-Click; x=1")).is_none());
        assert!(one_click_url(list, Some("List-Unsubscribe=Other")).is_none());
        assert!(one_click_url(list, None).is_none());
    }

    #[test]
    fn one_click_needs_an_https_target() {
        assert!(one_click_url("<mailto:u@a.example>", Some(POST)).is_none());
        assert!(one_click_url("<http://a.example/u>", Some(POST)).is_none());
        let url = one_click_url(
            "<mailto:u@a.example>, <HTTPS://A.example/u?x=1>",
            Some(POST),
        )
        .unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("a.example"));
    }

    #[test]
    fn options_reflect_stored_header_only() {
        assert_eq!(options(None, Some(POST)), None);
        assert_eq!(options(Some("<http://a.example/u>"), Some(POST)), None);
        let both = options(
            Some("<mailto:u@a.example?subject=off>, <https://a.example/u>"),
            Some(POST),
        )
        .unwrap();
        assert!(both.one_click);
        assert_eq!(both.https_host.as_deref(), Some("a.example"));
        assert_eq!(
            both.mailto.as_deref(),
            Some("mailto:u@a.example?subject=off")
        );
        let plain = options(Some("<https://a.example/u>"), None).unwrap();
        assert!(!plain.one_click);
        assert!(plain.https_url.is_some());
    }
}
