// Failure modes for the one-click POST, written before the code:
// - the URL is not https, carries credentials, or uses another port
// - localhost is reached, or DNS answers with private, loopback,
//   link-local, or reserved addresses (even one mixed into a public set)
// - a reported-threat host is contacted, or DNS resolves first, while the
//   preference is on; turning it off must not skip the SSRF checks
// - a redirect is followed (a 3xx would reach unvalidated hosts)
// - cookies, credentials, or a body other than the RFC 8058 value are sent
// - a 3xx/4xx/5xx status is reported as success
// - the sender's response or URL leaks into errors
// - the request has no timeout; the response body is read unbounded

use std::{net::SocketAddr, time::Duration};

use reqwest::{redirect::Policy, StatusCode};
use tokio::net::lookup_host;
use url::Url;

use crate::{mail::list_unsubscribe::ONE_CLICK_BODY, security::is_public_ip, threat_blocking};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) struct Target {
    pub url: Url,
    pub host: String,
    pub addresses: Vec<SocketAddr>,
}

/// Same boundary as remote images: public HTTPS only, reported-threat check
/// before any DNS, then every resolved address must be public.
pub(crate) async fn validate_target_with_resolver<F, Fut>(
    raw_url: &str,
    block_reported_threats: bool,
    resolve: F,
) -> Result<Target, String>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<SocketAddr>, String>>,
{
    const REFUSED: &str = "Postal Snap will not send a request to that address.";
    if raw_url.len() > 2048 {
        return Err(REFUSED.into());
    }
    let url = Url::parse(raw_url).map_err(|_| REFUSED.to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(REFUSED.into());
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| REFUSED.to_string())?
        .to_string();
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err(REFUSED.into());
    }
    if url.port_or_known_default() != Some(443) {
        return Err(REFUSED.into());
    }
    if block_reported_threats && threat_blocking::reports_url(&url) {
        return Err(
            "That address was reported as potentially dangerous, so no request was sent.".into(),
        );
    }
    let resolved = resolve(host.clone(), 443).await?;
    if resolved.is_empty() || resolved.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(REFUSED.into());
    }
    Ok(Target {
        url,
        host,
        addresses: resolved,
    })
}

/// Only a 2xx counts. A redirect is refused, never followed.
pub(crate) fn classify_status(status: StatusCode) -> Result<(), String> {
    if status.is_success() {
        Ok(())
    } else if status.is_redirection() {
        Err("The sender's server redirected the request, so it was not followed.".into())
    } else {
        Err("The sender's server did not accept the request.".into())
    }
}

/// POST to already validated, pinned addresses. No redirects, cookies,
/// credentials, or proxy. The response body is never read.
pub(crate) async fn post_pinned(
    url: &Url,
    host: &str,
    addresses: &[SocketAddr],
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("Postal Snap/", env!("CARGO_PKG_VERSION")))
        .resolve_to_addrs(host, addresses)
        .build()
        .map_err(|_| "Could not create a secure request.".to_string())?;
    let response = client
        .post(url.clone())
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(ONE_CLICK_BODY)
        .send()
        .await
        .map_err(|_| "Could not reach the sender's server.".to_string())?;
    classify_status(response.status())
}

/// RFC 8058 one-click request for a URL Rust read from the stored header.
pub async fn send_one_click(url: &Url, block_reported_threats: bool) -> Result<(), String> {
    tokio::time::timeout(TOTAL_TIMEOUT, async {
        let target = validate_target_with_resolver(
            url.as_str(),
            block_reported_threats,
            |host, port| async move {
                lookup_host((host.as_str(), port))
                    .await
                    .map(|addresses| addresses.collect())
                    .map_err(|_| "Could not find the sender's server.".to_string())
            },
        )
        .await?;
        post_pinned(&target.url, &target.host, &target.addresses).await
    })
    .await
    .map_err(|_| "The sender's server took too long to answer.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn addr(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse::<IpAddr>().unwrap(), 443)
    }

    async fn check(url: &str, threats: bool, resolved: Vec<SocketAddr>) -> Result<(), String> {
        validate_target_with_resolver(url, threats, |_, _| async move { Ok(resolved) })
            .await
            .map(|_| ())
    }

    #[tokio::test]
    async fn accepts_public_https_only() {
        assert!(check(
            "https://mail.example.test/u?id=1",
            true,
            vec![addr("93.184.216.34")]
        )
        .await
        .is_ok());
        for bad in [
            "http://mail.example.test/u",
            "mailto:u@example.test",
            "file:///etc/passwd",
            "https://user:pw@mail.example.test/u",
            "https://user@mail.example.test/u",
            "https://localhost/u",
            "https://app.localhost/u",
            "https://mail.example.test:8443/u",
            "not a url",
        ] {
            assert!(
                check(bad, false, vec![addr("93.184.216.34")])
                    .await
                    .is_err(),
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn rejects_non_public_dns_answers() {
        for ip in [
            "10.0.0.5",
            "127.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "172.16.0.1",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fc00::1",
        ] {
            assert!(
                check("https://mail.example.test/u", false, vec![addr(ip)])
                    .await
                    .is_err(),
                "{ip}"
            );
        }
        assert!(check(
            "https://mail.example.test/u",
            false,
            vec![addr("93.184.216.34"), addr("10.0.0.5")]
        )
        .await
        .is_err());
        assert!(check("https://mail.example.test/u", false, vec![])
            .await
            .is_err());
    }

    #[tokio::test]
    async fn reported_threat_blocks_before_dns_only_when_preference_is_on() {
        let domain = crate::threat_blocking::test_listed_domain();
        let url = format!("https://{domain}/unsubscribe");
        let resolved = AtomicBool::new(false);
        let result = validate_target_with_resolver(&url, true, |_, _| {
            resolved.store(true, Ordering::SeqCst);
            async { Ok(vec![addr("93.184.216.34")]) }
        })
        .await;
        assert!(result.is_err());
        assert!(!resolved.load(Ordering::SeqCst));
        assert!(check(&url, false, vec![addr("93.184.216.34")])
            .await
            .is_ok());
        assert!(check(&url, false, vec![addr("10.0.0.5")]).await.is_err());
    }

    #[test]
    fn only_2xx_counts_as_sent() {
        use reqwest::StatusCode;
        for ok in [200, 202, 204] {
            assert!(classify_status(StatusCode::from_u16(ok).unwrap()).is_ok());
        }
        for bad in [301, 302, 307, 308, 400, 401, 404, 405, 429, 500, 503] {
            assert!(
                classify_status(StatusCode::from_u16(bad).unwrap()).is_err(),
                "{bad}"
            );
        }
        let message = classify_status(StatusCode::from_u16(302).unwrap()).unwrap_err();
        assert!(!message.contains("http"));
    }

    async fn serve_once(
        status_line: &'static str,
    ) -> (SocketAddr, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 2048];
            loop {
                let count = socket.read(&mut buffer).await.unwrap();
                received.extend_from_slice(&buffer[..count]);
                let text = String::from_utf8_lossy(&received).to_string();
                if let Some(split) = text.find("\r\n\r\n") {
                    let length = text[..split]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if received.len() >= split + 4 + length {
                        break;
                    }
                }
            }
            let response = format!("{status_line}\r\nLocation: http://127.0.0.1:1/next\r\nSet-Cookie: a=b\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            socket.write_all(response.as_bytes()).await.unwrap();
            received
        });
        (local, handle)
    }

    #[tokio::test]
    async fn request_is_a_bare_form_post_without_cookies_or_credentials() {
        let (local, server) = serve_once("HTTP/1.1 200 OK").await;
        let url =
            url::Url::parse(&format!("http://unsub.example:{}/u?id=7", local.port())).unwrap();
        post_pinned(&url, "unsub.example", &[local]).await.unwrap();
        let request = String::from_utf8(server.await.unwrap()).unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(request.starts_with("POST /u?id=7 HTTP/1.1"));
        assert!(lower.contains("content-type: application/x-www-form-urlencoded"));
        assert!(request.ends_with("List-Unsubscribe=One-Click"));
        assert!(!lower.contains("cookie:"));
        assert!(!lower.contains("authorization:"));
        assert!(!lower.contains("referer:"));
    }

    #[tokio::test]
    async fn redirects_are_not_followed_and_do_not_count_as_sent() {
        let (local, server) = serve_once("HTTP/1.1 302 Found").await;
        let url = url::Url::parse(&format!("http://unsub.example:{}/u", local.port())).unwrap();
        let error = post_pinned(&url, "unsub.example", &[local])
            .await
            .unwrap_err();
        server.await.unwrap();
        assert!(!error.contains("127.0.0.1") && !error.contains("unsub.example"));
        let _ = Ipv4Addr::LOCALHOST;
    }
}
