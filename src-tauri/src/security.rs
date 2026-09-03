use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header::LOCATION, redirect::Policy};
use tokio::net::lookup_host;
use url::Url;

const MAX_REMOTE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_REMOTE_IMAGE_TIME: std::time::Duration = std::time::Duration::from_secs(20);

pub async fn fetch_public_image(raw_url: &str) -> Result<String, String> {
    tokio::time::timeout(MAX_REMOTE_IMAGE_TIME, fetch_public_image_inner(raw_url))
        .await
        .map_err(|_| "The remote image took too long to load.".to_string())?
}

async fn fetch_public_image_inner(raw_url: &str) -> Result<String, String> {
    let mut target = validate_public_url(raw_url).await?;
    for _ in 0..5 {
        let (url, host, addresses) = target;
        // Pin this request to the public addresses we validated. Otherwise a
        // second DNS lookup could be rebound to a private network address.
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("Postal Snap/0.1 remote-image-proxy")
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| "Could not create a secure image request.".to_string())?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| "Could not load this remote image.".to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "The image server returned an unsafe redirect.".to_string())?;
            let redirected = url
                .join(location)
                .map_err(|_| "The image server returned an unsafe redirect.".to_string())?;
            target = validate_public_url(redirected.as_str()).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err("The image server did not return an image.".into());
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("application/octet-stream")
            .trim()
            .to_ascii_lowercase();
        if !matches!(
            content_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err("The remote resource is not a supported image.".into());
        }
        if response
            .content_length()
            .is_some_and(|size| size as usize > MAX_REMOTE_IMAGE_BYTES)
        {
            return Err("The remote image is too large.".into());
        }
        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .unwrap_or_default()
                .min(MAX_REMOTE_IMAGE_BYTES as u64) as usize,
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read this remote image.".to_string())?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_REMOTE_IMAGE_BYTES {
                return Err("The remote image is too large.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(format!(
            "data:{content_type};base64,{}",
            STANDARD.encode(bytes)
        ));
    }
    Err("The image server redirected too many times.".into())
}

async fn validate_public_url(raw_url: &str) -> Result<(Url, String, Vec<SocketAddr>), String> {
    let url = Url::parse(raw_url).map_err(|_| "Invalid image address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only public HTTP(S) images can be loaded.".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Invalid image address.".to_string())?
        .to_string();
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err("Private-network images are blocked.".into());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Invalid image address.".to_string())?;
    if !matches!(port, 80 | 443 | 8080 | 8443) {
        return Err("Images may only be loaded from standard web ports.".into());
    }
    let resolved = lookup_host((host.as_str(), port))
        .await
        .map_err(|_| "Could not resolve the image server.".to_string())?;
    let mut addresses = Vec::new();
    for address in resolved {
        if !is_public_ip(address.ip()) {
            return Err("Private-network images are blocked.".into());
        }
        addresses.push(address);
    }
    if addresses.is_empty() {
        return Err("Could not resolve the image server.".into());
    }
    Ok((url, host, addresses))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [first, second, third, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_unspecified()
        || first == 0
        || first >= 224
        || first == 100 && (64..=127).contains(&second)
        || first == 192 && second == 0 && third == 0
        || first == 192 && second == 0 && third == 2
        || first == 192 && second == 88 && third == 99
        || first == 198 && matches!(second, 18 | 19)
        || first == 198 && second == 51 && third == 100
        || first == 203 && second == 0 && third == 113)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4() {
        return is_public_v4(mapped);
    }
    let segments = ip.segments();
    // NAT64 Well-Known Prefix 64:ff9b::/96
    if segments[0] == 0x0064
        && segments[1] == 0xff9b
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0
    {
        let v4 = Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
            (segments[7] >> 8) as u8,
            (segments[7] & 0xff) as u8,
        );
        return is_public_v4(v4);
    }
    // 6to4 prefix 2002::/16
    if segments[0] == 0x2002 {
        let v4 = Ipv4Addr::new(
            (segments[1] >> 8) as u8,
            (segments[1] & 0xff) as u8,
            (segments[2] >> 8) as u8,
            (segments[2] & 0xff) as u8,
        );
        return is_public_v4(v4);
    }
    // Teredo 2001:0000::/32
    if segments[0] == 0x2001 && segments[1] == 0x0000 {
        return false;
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || segments[0] == 0x0100
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x2001 && segments[1] == 0x0002)
        || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0010)
        || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020))
}

pub fn safe_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '/' | '\\' | ':' | '\0' | '<' | '>' | '"' | '|' | '?' | '*'
                )
        })
        .take(180)
        .collect();
    let cleaned = cleaned.trim().trim_matches('.');
    let upper = cleaned.to_ascii_uppercase();
    let is_dos_reserved = matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) || upper.starts_with("CON.")
        || upper.starts_with("PRN.")
        || upper.starts_with("AUX.")
        || upper.starts_with("NUL.");
    if cleaned.is_empty() || is_dos_reserved {
        if is_dos_reserved {
            format!("attachment_{cleaned}")
        } else {
            "attachment".into()
        }
    } else {
        cleaned.into()
    }
}

pub fn redact_error(_error: &dyn std::fmt::Display, action: &str) -> String {
    format!("{action} failed. Check the server settings, password, and internet connection.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_non_public_addresses() {
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("169.254.1.2".parse().unwrap()));
        assert!(!is_public_ip("10.2.3.4".parse().unwrap()));
        assert!(!is_public_ip("::1".parse().unwrap()));
        assert!(!is_public_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("::ffff:10.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("::ffff:169.254.169.254".parse().unwrap()));
        assert!(!is_public_ip("2001:db8::1".parse().unwrap()));
        assert!(!is_public_ip("192.0.2.1".parse().unwrap()));
        assert!(!is_public_ip("198.51.100.1".parse().unwrap()));
        assert!(!is_public_ip("203.0.113.1".parse().unwrap()));
        assert!(!is_public_ip("64:ff9b::192.0.2.1".parse().unwrap()));
        assert!(!is_public_ip("2002:c000:201::1".parse().unwrap()));
        assert!(!is_public_ip(
            "2001:0:4136:e378:8000:63bf:3fff:fdd2".parse().unwrap()
        ));
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn removes_path_components_from_names() {
        assert_eq!(safe_filename("../../secret.txt"), "secret.txt");
        assert_eq!(safe_filename("a/b\\c.txt"), "abc.txt");
        assert_eq!(
            safe_filename("bad<file>name:\"test\"|?.pdf"),
            "badfilenametest.pdf"
        );
        assert_eq!(safe_filename("CON"), "attachment_CON");
        assert_eq!(safe_filename("nul.txt"), "attachment_nul.txt");
        assert_eq!(safe_filename("AUX.tar.gz"), "attachment_AUX.tar.gz");
    }

    #[test]
    fn errors_are_redacted() {
        let secret = "person@example.com password=hunter2";
        let message = redact_error(&secret, "Connection");
        assert!(!message.contains("person"));
        assert!(!message.contains("hunter2"));
    }
}
