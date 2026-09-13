use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SanitizedHtml {
    pub html: String,
    pub blocked_images: u32,
}

/// Termination guard for the post-ammonia rewrite scanners. Every iteration
/// advances past at least four bytes, so this exceeds the maximum possible
/// iteration count for any input bounded by `mail::MAX_MESSAGE_BYTES`.
const MAX_REWRITE_ITERATIONS: usize = 64 * 1024 * 1024;

pub fn sanitize_received_html(input: &str) -> SanitizedHtml {
    sanitize_html(input, false, false)
}

pub fn sanitize_compose_html(input: &str) -> String {
    compose_html(input, false)
}

pub fn sanitize_compose_html_for_send(input: &str) -> String {
    compose_html(input, true)
}

fn compose_html(input: &str, restore_href: bool) -> String {
    let sanitized = sanitize_html(input, true, restore_href);
    if sanitized.html.is_empty() {
        "<p></p>".into()
    } else {
        sanitized.html
    }
}

fn sanitize_html(input: &str, keep_cid_src: bool, restore_href: bool) -> SanitizedHtml {
    if input.is_empty() {
        return SanitizedHtml {
            html: String::new(),
            blocked_images: 0,
        };
    }
    let normalized = normalize_src_and_href(input);
    let cleaned = mail_builder().clean(&normalized).to_string();
    let (html, blocked_images) = rewrite_images(&cleaned, keep_cid_src);
    let html = rewrite_links(&html, restore_href);
    SanitizedHtml {
        html,
        blocked_images,
    }
}

fn mail_builder() -> ammonia::Builder<'static> {
    let mut builder = ammonia::Builder::new();
    builder.tags(HashSet::from([
        "a",
        "abbr",
        "address",
        "b",
        "blockquote",
        "br",
        "caption",
        "center",
        "cite",
        "code",
        "col",
        "colgroup",
        "dd",
        "div",
        "dl",
        "dt",
        "em",
        "figcaption",
        "figure",
        "font",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "i",
        "img",
        "li",
        "mark",
        "ol",
        "p",
        "pre",
        "q",
        "s",
        "small",
        "span",
        "strike",
        "strong",
        "sub",
        "sup",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "u",
        "ul",
    ]));
    builder.clean_content_tags(HashSet::from([
        "script", "style", "iframe", "frame", "object", "embed", "form", "svg", "math", "audio",
        "video", "picture", "noscript",
    ]));
    builder.generic_attributes(HashSet::from(["class", "dir", "lang", "title", "style"]));
    builder.tag_attributes(HashMap::from([
        ("a", HashSet::from(["href", "data-external-href"])),
        (
            "img",
            HashSet::from([
                "src",
                "alt",
                "width",
                "height",
                "class",
                "data-remote-src",
                "data-inline-cid",
            ]),
        ),
        ("td", HashSet::from(["colspan", "rowspan"])),
        ("th", HashSet::from(["colspan", "rowspan"])),
        ("col", HashSet::from(["span"])),
        ("font", HashSet::from(["color", "face", "size"])),
    ]));
    builder.url_schemes(HashSet::from(["http", "https", "mailto", "cid", "data"]));
    builder.url_relative(ammonia::UrlRelative::Deny);
    builder.link_rel(Some("noopener noreferrer"));
    builder.strip_comments(true);
    builder.attribute_filter(|element, attribute, value| match (element, attribute) {
        ("a", "href") => {
            if is_safe_href(value) {
                Some(Cow::Borrowed(value))
            } else {
                None
            }
        }
        ("a", "data-external-href") => {
            if is_http_url(value) && value.len() <= 16 * 1024 {
                Some(Cow::Borrowed(value))
            } else {
                None
            }
        }
        ("img", "src") => {
            if is_kept_image_src(value) {
                Some(Cow::Borrowed(value))
            } else {
                None
            }
        }
        (_, "style") => {
            if is_safe_style(value) {
                Some(Cow::Borrowed(value))
            } else {
                None
            }
        }
        _ => Some(Cow::Borrowed(value)),
    });
    builder
}

fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}

fn normalize_src_and_href(input: &str) -> String {
    let mut output = String::with_capacity(input.len() + 16);
    let mut rest = input;
    let mut iterations = 0usize;
    loop {
        if iterations >= MAX_REWRITE_ITERATIONS {
            output.push_str(rest);
            break;
        }
        iterations += 1;
        let bytes = rest.as_bytes();
        let src = find_ascii_case_insensitive(bytes, b"src=");
        let href = find_ascii_case_insensitive(bytes, b"href=");
        let (rel, token_len) = match (src, href) {
            (Some(src), Some(href)) if src <= href => (src, 4),
            (Some(src), None) => (src, 4),
            (None, Some(href)) => (href, 5),
            (Some(_), Some(href)) => (href, 5),
            (None, None) => {
                output.push_str(rest);
                break;
            }
        };
        output.push_str(&rest[..rel + token_len]);
        rest = &rest[rel + token_len..];
        let Some(quote) = rest
            .chars()
            .next()
            .filter(|marker| matches!(marker, '"' | '\''))
        else {
            continue;
        };
        let after = &rest[1..];
        let Some(end) = after.find(quote) else {
            continue;
        };
        let rewritten = rewrite_quoted_url(&after[..end], token_len == 4);
        output.push(quote);
        output.push_str(&rewritten);
        output.push(quote);
        rest = &after[end + 1..];
    }
    output
}

fn rewrite_quoted_url(value: &str, is_src: bool) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with("//") {
        return format!("https:{trimmed}");
    }
    if is_src {
        if let Some(cid) = cid_value(trimmed) {
            return format!("cid:{cid}");
        }
    }
    value.to_string()
}

fn is_http_url(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("https://") || value.starts_with("http://")
}

fn is_safe_href(value: &str) -> bool {
    let value = value.trim();
    value.len() <= 16 * 1024 && (is_http_url(value) || value.starts_with("mailto:") || value == "#")
}

fn is_kept_image_src(value: &str) -> bool {
    let value = value.trim();
    is_http_url(value)
        || value
            .as_bytes()
            .get(..4)
            .is_some_and(|head| head.eq_ignore_ascii_case(b"cid:"))
        || is_safe_data_image(value)
}

const SAFE_DATA_IMAGE_PREFIXES: [&str; 4] = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/gif;base64,",
    "data:image/webp;base64,",
];

fn is_safe_data_image(value: &str) -> bool {
    let value = value.trim();
    SAFE_DATA_IMAGE_PREFIXES.iter().any(|prefix| {
        value
            .as_bytes()
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix.as_bytes()))
    })
}

fn is_safe_style(value: &str) -> bool {
    !regex_like_dangerous_css(value)
}

fn regex_like_dangerous_css(value: &str) -> bool {
    let bytes = value.as_bytes();
    find_ascii_case_insensitive(bytes, b"url(").is_some()
        || find_ascii_case_insensitive(bytes, b"expression(").is_some()
        || find_ascii_case_insensitive(bytes, b"@import").is_some()
        || find_ascii_case_insensitive(bytes, b"-moz-binding").is_some()
        || value.contains('\\')
        || find_ascii_case_insensitive(bytes, b"https:").is_some()
        || find_ascii_case_insensitive(bytes, b"http:").is_some()
        || value.contains("//")
        || find_ascii_case_insensitive(bytes, b"data:").is_some()
}

fn rewrite_links(html: &str, restore_href: bool) -> String {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;
    let mut iterations = 0usize;
    while let Some(start) = find_named_tag_start(rest, "a") {
        if iterations >= MAX_REWRITE_ITERATIONS {
            break;
        }
        iterations += 1;
        output.push_str(&rest[..start]);
        let Some(end) = find_tag_end(&rest[start..]) else {
            output.push_str(&rest[start..]);
            return output;
        };
        let tag = &rest[start..start + end];
        if tag.as_bytes().get(1) == Some(&b'/') {
            output.push_str(tag);
        } else {
            output.push_str(&rewrite_a_tag(tag, restore_href));
        }
        rest = &rest[start + end..];
    }
    output.push_str(rest);
    output
}

fn rewrite_a_tag(tag: &str, restore_href: bool) -> String {
    let self_closing = tag.trim_end().ends_with("/>") || tag.trim_end().ends_with("/ >");
    let inside = tag
        .trim()
        .trim_start_matches('<')
        .trim_start_matches("a")
        .trim_start_matches("A")
        .trim_end_matches('>')
        .trim_end_matches('/')
        .trim();
    let mut attrs = parse_attrs(inside);
    let href = take_attr(&mut attrs, "href");
    let marked = take_attr(&mut attrs, "data-external-href");
    attrs.retain(|(name, _)| name.as_str() != "href" && name.as_str() != "data-external-href");
    let http = href
        .as_deref()
        .map(str::trim)
        .filter(|value| is_http_url(value))
        .map(ToOwned::to_owned)
        .or_else(|| {
            marked
                .as_deref()
                .map(str::trim)
                .filter(|value| is_http_url(value))
                .map(ToOwned::to_owned)
        });
    let mailto = href
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("mailto:"))
        .map(ToOwned::to_owned);
    let mut extras = Vec::new();
    if let Some(http) = http {
        if restore_href {
            extras.push(("href", http));
        } else {
            extras.push(("href", "#".into()));
            extras.push(("data-external-href", http));
        }
    } else if let Some(mailto) = mailto {
        extras.push(("href", mailto));
    }

    let mut out = String::from("<a");
    for (name, value) in extras {
        push_attr(&mut out, name, &value);
    }
    for (name, value) in attrs {
        if let Some(value) = value {
            push_attr(&mut out, &name, &value);
        }
    }
    if self_closing {
        out.push_str(" />");
    } else {
        out.push('>');
    }
    out
}

fn find_named_tag_start(html: &str, name: &str) -> Option<usize> {
    let open = format!("<{name}");
    let open = open.as_bytes();
    let bytes = html.as_bytes();
    let mut search = 0;
    while search + open.len() <= bytes.len() {
        let rel = find_ascii_case_insensitive(&bytes[search..], open)?;
        let idx = search + rel;
        let next = bytes.get(idx + open.len())?;
        if next.is_ascii_whitespace() || *next == b'>' || *next == b'/' {
            return Some(idx);
        }
        search = idx + open.len();
    }
    None
}

fn rewrite_images(html: &str, keep_cid_src: bool) -> (String, u32) {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;
    let mut blocked = 0;
    let mut iterations = 0usize;
    while let Some(start) = find_img_start(rest) {
        if iterations >= MAX_REWRITE_ITERATIONS {
            break;
        }
        iterations += 1;
        output.push_str(&rest[..start]);
        let Some(end) = find_tag_end(&rest[start..]) else {
            output.push_str(&rest[start..]);
            return (output, blocked);
        };
        let tag = &rest[start..start + end];
        output.push_str(&rewrite_img_tag(tag, keep_cid_src, &mut blocked));
        rest = &rest[start + end..];
    }
    output.push_str(rest);
    (output, blocked)
}

fn find_img_start(html: &str) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut search = 0;
    while search + 4 <= bytes.len() {
        let rel = find_ascii_case_insensitive(&bytes[search..], b"<img")?;
        let idx = search + rel;
        let next = bytes.get(idx + 4)?;
        if next.is_ascii_whitespace() || *next == b'>' || *next == b'/' {
            return Some(idx);
        }
        search = idx + 4;
    }
    None
}

fn find_tag_end(from_tag: &str) -> Option<usize> {
    let mut quote = None;
    for (index, character) in from_tag.char_indices() {
        match (quote, character) {
            (None, '"' | '\'') => quote = Some(character),
            (Some(marker), character) if character == marker => quote = None,
            (None, '>') => return Some(index + 1),
            _ => {}
        }
    }
    None
}

fn rewrite_img_tag(tag: &str, keep_cid_src: bool, blocked: &mut u32) -> String {
    let self_closing = tag.trim_end().ends_with("/>") || tag.trim_end().ends_with("/ >");
    let inside = tag
        .trim()
        .trim_start_matches('<')
        .trim_start_matches("img")
        .trim_start_matches("IMG")
        .trim_end_matches('>')
        .trim_end_matches('/')
        .trim();
    let mut attrs = parse_attrs(inside);
    let src = take_attr(&mut attrs, "src");
    let existing_remote = take_attr(&mut attrs, "data-remote-src");
    let existing_cid = take_attr(&mut attrs, "data-inline-cid");
    let mut alt = take_attr(&mut attrs, "alt").unwrap_or_default();
    let class = take_attr(&mut attrs, "class").unwrap_or_default();
    attrs.retain(|(name, _)| {
        !matches!(
            name.as_str(),
            "src"
                | "srcset"
                | "data-remote-src"
                | "data-inline-cid"
                | "data-content-blocked"
                | "data-threat-blocked"
        )
    });

    let remote = src
        .as_deref()
        .map(str::trim)
        .filter(|value| is_http_url(value))
        .map(ToOwned::to_owned)
        .or_else(|| {
            existing_remote
                .as_deref()
                .map(str::trim)
                .filter(|value| is_http_url(value))
                .map(ToOwned::to_owned)
        });
    let cid = src
        .as_deref()
        .and_then(cid_value)
        .or_else(|| existing_cid.as_deref().and_then(cid_reference));
    let data_image = src
        .as_deref()
        .map(str::trim)
        .filter(|value| is_safe_data_image(value))
        .map(ToOwned::to_owned);

    let mut extras = Vec::new();
    if let Some(remote) = remote {
        extras.push(("data-remote-src", remote));
        if alt.is_empty() {
            alt = "Remote image blocked".into();
        }
        extras.push(("class", merge_class(&class, "remote-image-blocked")));
        *blocked += 1;
    } else if let Some(cid) = cid {
        if keep_cid_src {
            extras.push(("src", format!("cid:{cid}")));
        } else {
            extras.push(("data-inline-cid", cid));
        }
        if alt.is_empty() {
            alt = "Inline image".into();
        }
        if !class.is_empty() {
            extras.push(("class", class));
        }
    } else if let Some(data_image) = data_image {
        extras.push(("src", data_image));
        if !class.is_empty() {
            extras.push(("class", class));
        }
    } else if !class.is_empty() {
        extras.push(("class", class));
    }

    let mut out = String::from("<img");
    for (name, value) in extras {
        push_attr(&mut out, name, &value);
    }
    if !alt.is_empty() {
        push_attr(&mut out, "alt", &alt);
    }
    for (name, value) in attrs {
        if let Some(value) = value {
            push_attr(&mut out, &name, &value);
        }
    }
    if self_closing {
        out.push_str(" />");
    } else {
        out.push('>');
    }
    out
}

fn take_attr(attrs: &mut Vec<(String, Option<String>)>, name: &str) -> Option<String> {
    let index = attrs
        .iter()
        .position(|(key, _)| key.eq_ignore_ascii_case(name))?;
    attrs.remove(index).1
}

fn cid_value(src: &str) -> Option<String> {
    let value = src.trim();
    value
        .strip_prefix("cid:")
        .or_else(|| value.strip_prefix("CID:"))
        .and_then(cid_reference)
}

fn cid_reference(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_start_matches('<').trim_end_matches('>');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(512).collect())
    }
}

fn merge_class(existing: &str, extra: &str) -> String {
    if existing.split_whitespace().any(|item| item == extra) {
        existing.to_string()
    } else if existing.is_empty() {
        extra.to_string()
    } else {
        format!("{existing} {extra}")
    }
}

fn push_attr(out: &mut String, name: &str, value: &str) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    out.push_str(
        &value
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;"),
    );
    out.push('"');
}

/// Invert the entity escaping ammonia applies when it serializes attribute
/// values, so a value survives exactly one encode/decode round trip instead of
/// being double-encoded by [`push_attr`].
fn decode_html_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        output.push_str(&rest[..index]);
        let after = &rest[index + 1..];
        let Some(semicolon) = after.find(';') else {
            output.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..semicolon];
        if entity.len() > 10 {
            output.push('&');
            rest = after;
            continue;
        }
        match decode_entity(entity) {
            Some(decoded) => output.push(decoded),
            None => {
                output.push('&');
                output.push_str(entity);
                output.push(';');
            }
        }
        rest = &after[semicolon + 1..];
    }
    output.push_str(rest);
    output
}

fn decode_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some('\u{a0}'),
        _ => {
            let number = entity.strip_prefix('#')?;
            let parsed = if let Some(hex) = number
                .strip_prefix('x')
                .or_else(|| number.strip_prefix('X'))
            {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                number.parse::<u32>().ok()?
            };
            char::from_u32(parsed)
        }
    }
}

fn parse_attrs(inside: &str) -> Vec<(String, Option<String>)> {
    let mut attrs = Vec::new();
    let bytes = inside.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let start = index;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'=' {
            index += 1;
        }
        let name = inside[start..index].to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'=' {
            attrs.push((name, None));
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            attrs.push((name, Some(String::new())));
            break;
        }
        let value = if bytes[index] == b'"' || bytes[index] == b'\'' {
            let quote = bytes[index];
            index += 1;
            let value_start = index;
            while index < bytes.len() && bytes[index] != quote {
                index += 1;
            }
            let value = decode_html_entities(&inside[value_start..index]);
            if index < bytes.len() {
                index += 1;
            }
            value
        } else {
            let value_start = index;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            decode_html_entities(&inside[value_start..index])
        };
        attrs.push((name, Some(value)));
    }
    attrs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_active_content_and_rewrites_images() {
        let result = sanitize_received_html(
            r#"<p>Hello</p><script>alert(1)</script><form action="https://bad.test"><input></form>
            <a href="javascript:alert(2)" onclick="steal()">bad</a>
            <img src="https://tracker.test/pixel.gif" onerror="steal()">
            <img src="cid:<photo-1@example.test>">
            <img src="//tracker.test/protocol-relative.gif" data-evil="1">
            <img src="file:///etc/passwd">
            <p style="background:url(https://tracker.test/css)">styled</p>"#,
        );
        assert!(result.html.contains("Hello"));
        assert!(!result.html.to_ascii_lowercase().contains("script"));
        assert!(!result.html.to_ascii_lowercase().contains("form"));
        assert!(!result.html.contains("javascript:"));
        assert!(!result.html.contains("onerror"));
        assert!(!result.html.contains("data-evil"));
        assert!(!result.html.contains("file:"));
        assert!(!result.html.contains("url("));
        assert!(result
            .html
            .contains("data-remote-src=\"https://tracker.test/pixel.gif\""));
        assert!(result
            .html
            .contains("data-remote-src=\"https://tracker.test/protocol-relative.gif\""));
        assert!(result
            .html
            .contains("data-inline-cid=\"photo-1@example.test\""));
        assert!(!result.html.contains("<img src=\"https://"));
        assert!(!result.html.contains("<img src=\"http://"));
        assert!(!result.html.contains("<img src=\"cid:"));
        assert_eq!(result.blocked_images, 2);
    }

    #[test]
    fn compose_keeps_cid_and_drops_scripts() {
        let html = sanitize_compose_html(
            r#"<p>Draft</p><img src="cid:<photo-1@example.test>"><script>alert(1)</script>"#,
        );
        assert!(html.contains("src=\"cid:photo-1@example.test\""));
        assert!(!html.contains("data-inline-cid"));
        assert!(!html.to_ascii_lowercase().contains("script"));
    }

    #[test]
    fn received_sanitize_is_idempotent() {
        let once = sanitize_received_html(
            r#"<img src="https://images.example.test/pic.png"><a href="https://library.example.test">Go</a>"#,
        );
        let twice = sanitize_received_html(&once.html);
        assert_eq!(once.html, twice.html);
        assert_eq!(once.blocked_images, 1);
        assert_eq!(twice.blocked_images, 1);
        assert!(once.html.contains("rel=\"noopener noreferrer\""));
        assert!(once
            .html
            .contains("data-external-href=\"https://library.example.test\""));
        assert!(!once.html.contains("<a href=\"https://"));
        assert!(!once.html.contains("<a href=\"http://"));
    }

    #[test]
    fn compose_keeps_http_links_inert_until_send() {
        let received = sanitize_received_html(
            r#"<p><a href="https://library.example.test/hours">Hours</a></p>"#,
        );
        assert!(received
            .html
            .contains("data-external-href=\"https://library.example.test/hours\""));
        let compose = sanitize_compose_html(&received.html);
        assert!(compose.contains("data-external-href=\"https://library.example.test/hours\""));
        assert!(!compose.contains("<a href=\"https://"));
        let outgoing = sanitize_compose_html_for_send(&compose);
        assert!(outgoing.contains("href=\"https://library.example.test/hours\""));
        assert!(!outgoing.contains("data-external-href"));
    }

    #[test]
    fn compose_restores_inline_cid_markers() {
        let html = sanitize_compose_html(
            r#"<p>Draft</p><img data-inline-cid="photo-1@example.test" alt="Inline image">"#,
        );
        assert!(html.contains("src=\"cid:photo-1@example.test\""));
        assert!(!html.contains("data-inline-cid"));
    }

    #[test]
    fn keeps_safe_data_images() {
        let html =
            sanitize_received_html(r#"<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">"#);
        assert!(html.html.contains("data:image/png;base64,iVBORw0KGgo="));
        assert_eq!(html.blocked_images, 0);
    }

    #[test]
    fn url_attributes_are_encoded_exactly_once() {
        let result = sanitize_received_html(
            r#"<p><a href="https://library.example.test/hours?a=1&b=2">Hours</a></p>
               <img src="https://images.example.test/pic.png?a=1&b=2" alt="A &amp; B">"#,
        );
        assert!(result
            .html
            .contains("data-external-href=\"https://library.example.test/hours?a=1&amp;b=2\""));
        assert!(result
            .html
            .contains("data-remote-src=\"https://images.example.test/pic.png?a=1&amp;b=2\""));
        assert!(result.html.contains("alt=\"A &amp; B\""));
        assert!(!result.html.contains("&amp;amp;"));

        for raw in [
            r#"<a href="https://library.example.test/x?a=1&amp;b=2">Hours</a>"#,
            r#"<a href="https://library.example.test/x?a=1&#38;b=2">Hours</a>"#,
            r#"<a href="https://library.example.test/x?a=1&#x26;b=2">Hours</a>"#,
        ] {
            let encoded = sanitize_received_html(raw);
            assert!(
                encoded
                    .html
                    .contains("data-external-href=\"https://library.example.test/x?a=1&amp;b=2\""),
                "unexpected output for {raw}: {}",
                encoded.html
            );
            assert!(!encoded.html.contains("&amp;amp;"));
        }

        let script = sanitize_received_html(r#"<a href="&#106;avascript:alert(1)">x</a>"#);
        assert!(!script.html.contains("javascript"));
        assert!(!script.html.contains("data-external-href"));
    }

    #[test]
    fn rewrite_cap_exceeds_any_bounded_message_tag_count() {
        const {
            assert!(MAX_REWRITE_ITERATIONS > crate::mail::MAX_MESSAGE_BYTES / 4);
        }
    }

    #[test]
    fn sanitizer_processes_many_url_attributes_in_one_pass() {
        let mut input = String::new();
        for index in 0..10_000 {
            input.push_str(&format!(
                "<img src=\"https://tracker.example.test/{index}?a=1&b=2\">\
                 <a href=\"https://library.example.test/{index}?a=1&b=2\">link</a>"
            ));
        }
        let result = sanitize_received_html(&input);
        assert_eq!(result.blocked_images, 10_000);
        assert_eq!(result.html.matches("data-remote-src=").count(), 10_000);
        assert_eq!(result.html.matches("data-external-href=").count(), 10_000);
        assert!(!result.html.contains("&amp;amp;"));
    }
}
