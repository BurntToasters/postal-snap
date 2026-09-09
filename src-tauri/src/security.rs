use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header::LOCATION, redirect::Policy};
use tokio::net::lookup_host;
use url::Url;

use crate::{content_blocking, threat_blocking};

const MAX_REMOTE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_REMOTE_IMAGE_TIME: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtectionPolicy {
    pub block_advertising_and_tracking: bool,
    pub block_reported_threats: bool,
}

impl ProtectionPolicy {
    #[cfg(test)]
    pub const STRICT: Self = Self {
        block_advertising_and_tracking: true,
        block_reported_threats: true,
    };
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RemoteImageResult {
    Loaded {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
    Blocked,
    ReportedThreat,
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLinkCheck {
    pub url: String,
    pub hostname: String,
    pub reported_threat: bool,
}

enum PublicImageTarget {
    Fetch(Url, String, Vec<SocketAddr>),
    Blocked,
    ReportedThreat,
}

pub async fn fetch_public_image(
    raw_url: &str,
    policy: ProtectionPolicy,
) -> Result<RemoteImageResult, String> {
    tokio::time::timeout(
        MAX_REMOTE_IMAGE_TIME,
        fetch_public_image_inner(raw_url, policy),
    )
    .await
    .map_err(|_| "The remote image took too long to load.".to_string())?
}

pub fn inspect_external_link(
    raw_url: &str,
    policy: ProtectionPolicy,
) -> Result<ExternalLinkCheck, String> {
    if raw_url.len() > 16 * 1024 {
        return Err("That link is too long.".into());
    }
    let url =
        Url::parse(raw_url).map_err(|_| "That link is not a valid web address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Postal Snap can only open ordinary web links.".into());
    }
    let hostname = url
        .host_str()
        .ok_or_else(|| "That link is not a valid web address.".to_string())?
        .to_string();
    Ok(ExternalLinkCheck {
        url: url.as_str().to_string(),
        hostname,
        reported_threat: policy.block_reported_threats && threat_blocking::reports_url(&url),
    })
}

pub fn authorize_external_open(check: &ExternalLinkCheck, open_anyway: bool) -> Result<(), String> {
    if check.reported_threat && !open_anyway {
        return Err(
            "That address was reported as potentially dangerous. Confirm again if you still want to open it."
                .into(),
        );
    }
    Ok(())
}

pub fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

async fn fetch_public_image_inner(
    raw_url: &str,
    policy: ProtectionPolicy,
) -> Result<RemoteImageResult, String> {
    let mut target = validate_public_url(raw_url, None, policy).await?;
    for _ in 0..5 {
        let (url, host, addresses) = match target {
            PublicImageTarget::Blocked => return Ok(RemoteImageResult::Blocked),
            PublicImageTarget::ReportedThreat => return Ok(RemoteImageResult::ReportedThreat),
            PublicImageTarget::Fetch(url, host, addresses) => (url, host, addresses),
        };
        // Pin this request to the public addresses we validated. Otherwise a
        // second DNS lookup could be rebound to a private network address.
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent(concat!(
                "Postal Snap/",
                env!("CARGO_PKG_VERSION"),
                " remote-image-proxy"
            ))
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
            target = validate_public_url(redirected.as_str(), Some(url.scheme()), policy).await?;
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
        let sniffed = detect_image_mime(&bytes)
            .ok_or_else(|| "The remote resource is not a supported image.".to_string())?;
        if sniffed != content_type {
            return Err("The remote resource is not a supported image.".into());
        }
        return Ok(RemoteImageResult::Loaded {
            data_url: format!("data:{sniffed};base64,{}", STANDARD.encode(bytes)),
        });
    }
    Err("The image server redirected too many times.".into())
}

async fn validate_public_url(
    raw_url: &str,
    previous_scheme: Option<&str>,
    policy: ProtectionPolicy,
) -> Result<PublicImageTarget, String> {
    validate_public_url_with_resolver(raw_url, previous_scheme, policy, |host, port| async move {
        lookup_host((host.as_str(), port))
            .await
            .map(|addresses| addresses.collect())
            .map_err(|_| "Could not resolve the image server.".to_string())
    })
    .await
}

async fn validate_public_url_with_resolver<F, Fut>(
    raw_url: &str,
    previous_scheme: Option<&str>,
    policy: ProtectionPolicy,
    resolve: F,
) -> Result<PublicImageTarget, String>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<SocketAddr>, String>>,
{
    if raw_url.len() > 16 * 1024 {
        return Err("The image address is too long.".into());
    }
    let url = Url::parse(raw_url).map_err(|_| "Invalid image address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only public HTTP(S) images can be loaded.".into());
    }
    if previous_scheme == Some("https") && url.scheme() != "https" {
        return Err("The image server returned an unsafe redirect.".into());
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
    if !matches!(port, 80 | 443) {
        return Err("Images may only be loaded from standard web ports.".into());
    }
    if policy.block_reported_threats && threat_blocking::reports_url(&url) {
        return Ok(PublicImageTarget::ReportedThreat);
    }
    if policy.block_advertising_and_tracking && content_blocking::blocks_image(&url).await? {
        return Ok(PublicImageTarget::Blocked);
    }
    let resolved = resolve(host.clone(), port).await?;
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
    Ok(PublicImageTarget::Fetch(url, host, addresses))
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
    // IPv4-Translated address ::ffff:0:a.b.c.d (RFC 6052 / RFC 6144)
    if segments[0] == 0
        && segments[1] == 0
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0xffff
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
    // NAT64 Well-Known Prefix 64:ff9b::/96 (RFC 6052) and Local-Use 64:ff9b:1::/48 (RFC 8215)
    if segments[0] == 0x0064 && segments[1] == 0xff9b {
        if segments[2] == 0 && segments[3] == 0 && segments[4] == 0 && segments[5] == 0 {
            let v4 = Ipv4Addr::new(
                (segments[6] >> 8) as u8,
                (segments[6] & 0xff) as u8,
                (segments[7] >> 8) as u8,
                (segments[7] & 0xff) as u8,
            );
            return is_public_v4(v4);
        }
        if segments[2] == 1 {
            return false;
        }
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
    let stem = upper.split('.').next().unwrap_or(&upper);
    let is_dos_reserved = matches!(
        stem,
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
    );
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
    format!("{action} failed. Check the mail server, password, and internet connection.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn blocks_tracking_images_before_dns_including_redirect_targets() {
        for previous_scheme in [None, Some("https")] {
            let target = validate_public_url_with_resolver(
                "https://images.example.test/email/track/pixel.gif",
                previous_scheme,
                ProtectionPolicy::STRICT,
                |_, _| async { panic!("Blocked images must never resolve DNS") },
            )
            .await
            .unwrap();
            assert!(matches!(target, PublicImageTarget::Blocked));
        }
        assert_eq!(
            fetch_public_image(
                "https://images.example.test/email/track/pixel.gif",
                ProtectionPolicy::STRICT,
            )
            .await
            .unwrap(),
            RemoteImageResult::Blocked,
        );
    }

    #[tokio::test]
    async fn blocks_reported_threat_images_before_dns_including_redirect_targets() {
        let domain = crate::threat_blocking::test_listed_domain();
        let url = format!("https://{domain}/family/photo.jpg");
        for previous_scheme in [None, Some("https")] {
            let target = validate_public_url_with_resolver(
                &url,
                previous_scheme,
                ProtectionPolicy::STRICT,
                |_, _| async { panic!("Reported-threat images must never resolve DNS") },
            )
            .await
            .unwrap();
            assert!(matches!(target, PublicImageTarget::ReportedThreat));
        }
        assert_eq!(
            fetch_public_image(&url, ProtectionPolicy::STRICT)
                .await
                .unwrap(),
            RemoteImageResult::ReportedThreat,
        );
    }

    #[tokio::test]
    async fn filtering_preserves_url_and_dns_safety_checks() {
        for url in [
            "file:///photo.png",
            "https://name:password@images.example.test/photo.jpg",
            "https://localhost/photo.jpg",
            "https://images.example.test:8080/photo.jpg",
            "http://images.example.test/photo.jpg",
        ] {
            assert!(validate_public_url_with_resolver(
                url,
                Some("https"),
                ProtectionPolicy::STRICT,
                |_, _| async { panic!("Unsafe image URL must never resolve DNS") },
            )
            .await
            .is_err());
        }
        for addresses in [
            vec!["127.0.0.1:443"],
            vec!["8.8.8.8:443", "10.0.0.1:443"],
            vec![],
        ] {
            assert!(validate_public_url_with_resolver(
                "https://images.example.test/photo.jpg",
                None,
                ProtectionPolicy::STRICT,
                |_, _| async {
                    Ok(addresses
                        .iter()
                        .map(|value| value.parse().unwrap())
                        .collect())
                },
            )
            .await
            .is_err());
        }
        let target = validate_public_url_with_resolver(
            "https://images.example.test/photo.jpg?signature=synthetic",
            None,
            ProtectionPolicy::STRICT,
            |host, port| async move {
                assert_eq!(host, "images.example.test");
                assert_eq!(port, 443);
                Ok(vec!["8.8.8.8:443".parse().unwrap()])
            },
        )
        .await
        .unwrap();
        let PublicImageTarget::Fetch(parsed, _, addresses) = target else {
            panic!("safe image URL should be fetchable");
        };
        assert_eq!(parsed.query(), Some("signature=synthetic"));
        assert_eq!(
            addresses,
            vec!["8.8.8.8:443".parse::<SocketAddr>().unwrap()]
        );
    }

    #[test]
    fn inspects_external_links_without_claiming_they_are_safe() {
        let clean = inspect_external_link(
            "https://Library.example.test/hours",
            ProtectionPolicy::STRICT,
        )
        .unwrap();
        assert_eq!(clean.hostname, "library.example.test");
        assert!(!clean.reported_threat);
        assert!(clean.url.starts_with("https://"));

        let domain = crate::threat_blocking::test_listed_domain();
        let reported = inspect_external_link(
            &format!("https://mail.{domain}/login"),
            ProtectionPolicy::STRICT,
        )
        .unwrap();
        assert_eq!(reported.hostname, format!("mail.{domain}"));
        assert!(reported.reported_threat);
        let allowed = inspect_external_link(
            &format!("https://mail.{domain}/login"),
            ProtectionPolicy {
                block_advertising_and_tracking: true,
                block_reported_threats: false,
            },
        )
        .unwrap();
        assert!(!allowed.reported_threat);

        assert!(inspect_external_link(
            "https://name:password@library.example.test/hours",
            ProtectionPolicy::STRICT
        )
        .is_err());
        assert!(inspect_external_link("javascript:alert(1)", ProtectionPolicy::STRICT).is_err());
        let idn =
            inspect_external_link("https://xn--pple-43d.com/", ProtectionPolicy::STRICT).unwrap();
        assert_eq!(idn.hostname, "xn--pple-43d.com");
        authorize_external_open(&reported, false).unwrap_err();
        authorize_external_open(&reported, true).unwrap();
        authorize_external_open(&clean, false).unwrap();
    }

    #[test]
    fn image_magic_bytes_are_required() {
        assert_eq!(
            detect_image_mime(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(detect_image_mime(b"<html>not an image"), None);
        assert_eq!(detect_image_mime(b"GIF89a...."), Some("image/gif"));
    }

    #[tokio::test]
    async fn protection_toggles_skip_list_checks_but_keep_ssrf_rules() {
        let tracker = validate_public_url_with_resolver(
            "https://images.example.test/email/track/pixel.gif",
            None,
            ProtectionPolicy {
                block_advertising_and_tracking: false,
                block_reported_threats: true,
            },
            |host, port| async move {
                assert_eq!(host, "images.example.test");
                assert_eq!(port, 443);
                Ok(vec!["8.8.8.8:443".parse().unwrap()])
            },
        )
        .await
        .unwrap();
        assert!(matches!(tracker, PublicImageTarget::Fetch(_, _, _)));

        let domain = crate::threat_blocking::test_listed_domain();
        let url = format!("https://{domain}/family/photo.jpg");
        let reported = validate_public_url_with_resolver(
            &url,
            None,
            ProtectionPolicy {
                block_advertising_and_tracking: true,
                block_reported_threats: false,
            },
            |host, port| async move {
                assert_eq!(host, domain);
                assert_eq!(port, 443);
                Ok(vec!["8.8.8.8:443".parse().unwrap()])
            },
        )
        .await
        .unwrap();
        assert!(matches!(reported, PublicImageTarget::Fetch(_, _, _)));

        assert!(validate_public_url_with_resolver(
            "https://localhost/photo.jpg",
            None,
            ProtectionPolicy {
                block_advertising_and_tracking: false,
                block_reported_threats: false,
            },
            |_, _| async { panic!("Private-network images must never resolve DNS") },
        )
        .await
        .is_err());
    }

    #[test]
    fn remote_image_results_are_typed_and_redacted() {
        assert_eq!(
            serde_json::to_value(RemoteImageResult::Blocked).unwrap(),
            serde_json::json!({"status": "blocked"})
        );
        assert_eq!(
            serde_json::to_value(RemoteImageResult::Loaded {
                data_url: "data:image/png;base64,".into()
            })
            .unwrap(),
            serde_json::json!({"status": "loaded", "dataUrl": "data:image/png;base64,"})
        );
        assert_eq!(
            serde_json::to_value(RemoteImageResult::ReportedThreat).unwrap(),
            serde_json::json!({"status": "reportedThreat"})
        );
        assert_eq!(
            serde_json::to_value(ExternalLinkCheck {
                url: "https://library.example.test/hours".into(),
                hostname: "library.example.test".into(),
                reported_threat: false,
            })
            .unwrap(),
            serde_json::json!({
                "url": "https://library.example.test/hours",
                "hostname": "library.example.test",
                "reportedThreat": false
            })
        );
    }

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
        assert_eq!(safe_filename("com1.txt"), "attachment_com1.txt");
        assert_eq!(safe_filename("lpt1.pdf"), "attachment_lpt1.pdf");
    }

    #[test]
    fn errors_are_redacted() {
        let secret = "person@example.com password=hunter2";
        let message = redact_error(&secret, "Connection");
        assert!(!message.contains("person"));
        assert!(!message.contains("hunter2"));
    }
}
