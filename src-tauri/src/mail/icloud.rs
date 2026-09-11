use std::time::Duration;

use zeroize::Zeroizing;

use crate::security::redact_error;

pub async fn discover_icloud_aliases(email: &str, password: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not connect to iCloud alias service.".to_string())?;

    let raw = Zeroizing::new(format!("{email}:{password}"));
    let auth = Zeroizing::new(format!(
        "Basic {}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, raw.as_bytes())
    ));

    let propfind_principal = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal/>
  </D:prop>
</D:propfind>"#;

    let response = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            "https://caldav.icloud.com/",
        )
        .header("Authorization", auth.as_str())
        .header("Depth", "0")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(propfind_principal)
        .send()
        .await
        .map_err(|error| redact_error(&error, "iCloud alias discovery"))?;

    let status = response.status();
    if status.is_redirection() {
        return Ok(Vec::new());
    }
    if !status.is_success() && status.as_u16() != 207 {
        return Ok(Vec::new());
    }

    let text = response
        .text()
        .await
        .map_err(|error| redact_error(&error, "iCloud alias discovery"))?;

    let principal_href = extract_tag_value(&text, "current-user-principal")
        .and_then(|tag| extract_tag_value(&tag, "href"))
        .or_else(|| extract_tag_value(&text, "href"));

    let Some(href) = principal_href else {
        return Ok(Vec::new());
    };
    let Some(principal_url) = icloud_follow_up_url(&href) else {
        return Ok(Vec::new());
    };

    let address_set_prop = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-user-address-set/>
  </D:prop>
</D:propfind>"#;

    let address_res = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            &principal_url,
        )
        .header("Authorization", auth.as_str())
        .header("Depth", "0")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(address_set_prop)
        .send()
        .await
        .map_err(|error| redact_error(&error, "iCloud alias discovery"))?;

    let addr_status = address_res.status();
    if addr_status.is_redirection() {
        return Ok(Vec::new());
    }
    if !addr_status.is_success() && addr_status.as_u16() != 207 {
        return Ok(Vec::new());
    }

    let address_xml = address_res
        .text()
        .await
        .map_err(|error| redact_error(&error, "iCloud alias discovery"))?;

    let mut aliases = Vec::new();
    let primary_lower = email.trim().to_lowercase();

    for part in address_xml.split("mailto:") {
        if let Some(end) = part.find(['<', '"', ' ', '\n', '\r', '\t', '&']) {
            let addr = part[..end].trim().to_lowercase();
            if addr.contains('@')
                && !addr.contains('/')
                && addr != primary_lower
                && addr.len() <= 320
                && !addr.contains(char::is_control)
                && addr.parse::<lettre::message::Mailbox>().is_ok()
                && !aliases.contains(&addr)
            {
                aliases.push(addr);
            }
        }
    }

    Ok(aliases)
}

pub fn icloud_follow_up_url(href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() || href.contains(char::is_control) {
        return None;
    }
    if href.starts_with("http://") || (href.contains("://") && !href.starts_with("https://")) {
        return None;
    }
    let candidate = if href.starts_with("https://") {
        href.to_string()
    } else {
        let path = if href.starts_with('/') {
            href.to_string()
        } else {
            format!("/{href}")
        };
        format!("https://caldav.icloud.com{path}")
    };
    let parsed = reqwest::Url::parse(&candidate).ok()?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?;
    if !is_allowed_icloud_principal_host(host) {
        return None;
    }
    Some(parsed.as_str().to_string())
}

pub fn is_allowed_icloud_principal_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "caldav.icloud.com"
        || host == "caldav.apple.com"
        || host.ends_with("-caldav.icloud.com")
}

pub fn extract_tag_value(xml: &str, tag_name: &str) -> Option<String> {
    let mut search_from = 0;
    while let Some(start_bracket) = xml[search_from..].find('<') {
        let idx = search_from + start_bracket;
        let tag_start = idx + 1;
        if let Some(close_bracket) = xml[tag_start..].find('>') {
            let tag_head = &xml[tag_start..tag_start + close_bracket];
            let tag_ident = tag_head
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_end_matches('/');
            let matches_tag = if let Some(local) = tag_ident.split(':').nth(1) {
                local.eq_ignore_ascii_case(tag_name)
            } else {
                tag_ident.eq_ignore_ascii_case(tag_name)
            };
            if matches_tag && !tag_ident.starts_with('/') {
                let content_start = tag_start + close_bracket + 1;
                let after = &xml[content_start..];
                for (close_idx, _) in after.match_indices("</") {
                    let after_close = &after[close_idx + 2..];
                    if let Some(gt) = after_close.find('>') {
                        let close_ident = after_close[..gt].trim();
                        let close_matches = if let Some(local) = close_ident.split(':').nth(1) {
                            local.eq_ignore_ascii_case(tag_name)
                        } else {
                            close_ident.eq_ignore_ascii_case(tag_name)
                        };
                        if close_matches {
                            return Some(after[..close_idx].trim().to_string());
                        }
                    }
                }
            }
            search_from = tag_start + close_bracket + 1;
        } else {
            break;
        }
    }
    None
}
