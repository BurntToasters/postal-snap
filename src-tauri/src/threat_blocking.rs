use std::collections::HashSet;
use std::sync::OnceLock;

use addr::parse_domain_name;
use url::Url;

const DOMAINS: &str = include_str!("../filters/tweetfeed-domains.txt");
const URLS: &str = include_str!("../filters/tweetfeed-urls.txt");

struct ThreatLists {
    domains: HashSet<String>,
    urls: HashSet<String>,
}

static LISTS: OnceLock<ThreatLists> = OnceLock::new();

fn parse_listed_domain(line: &str) -> Option<String> {
    let host = line.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.starts_with('#') {
        return None;
    }
    parse_domain_name(&host).ok()?.root()?;
    Some(host)
}

pub fn normalize_url(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let mut normalized = url.clone();
    normalized.set_host(Some(&host)).ok()?;
    if matches!(
        (normalized.scheme(), normalized.port()),
        ("http", Some(80)) | ("https", Some(443))
    ) {
        let _ = normalized.set_port(None);
    }
    normalized.set_fragment(None);
    Some(normalized.as_str().to_string())
}

fn parse_listed_url(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    normalize_url(&Url::parse(line).ok()?)
}

fn parse_lists(domains_text: &str, urls_text: &str) -> ThreatLists {
    ThreatLists {
        domains: domains_text
            .lines()
            .filter_map(parse_listed_domain)
            .collect(),
        urls: urls_text.lines().filter_map(parse_listed_url).collect(),
    }
}

fn lists() -> &'static ThreatLists {
    LISTS.get_or_init(|| parse_lists(DOMAINS, URLS))
}

fn host_is_listed(host: &str, domains: &HashSet<String>) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if parse_domain_name(&host)
        .ok()
        .and_then(|name| name.root())
        .is_none()
    {
        return false;
    }
    let mut current = host.as_str();
    loop {
        if domains.contains(current) {
            return true;
        }
        match current.split_once('.') {
            Some((_, rest)) => current = rest,
            None => return false,
        }
    }
}

pub fn reports_url(url: &Url) -> bool {
    let lists = lists();
    if let Some(normalized) = normalize_url(url) {
        if lists.urls.contains(&normalized) {
            return true;
        }
    }
    url.host_str()
        .is_some_and(|host| host_is_listed(host, &lists.domains))
}

pub async fn warmup() {
    let _ = tokio::task::spawn_blocking(lists).await;
}

#[cfg(test)]
pub fn test_listed_domain() -> String {
    let mut domains: Vec<_> = lists().domains.iter().cloned().collect();
    domains.sort();
    domains
        .into_iter()
        .next()
        .expect("bundled TweetFeed domain snapshot")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reports_with(domains_text: &str, urls_text: &str, raw: &str) -> bool {
        let lists = parse_lists(domains_text, urls_text);
        let url = Url::parse(raw).unwrap();
        if let Some(normalized) = normalize_url(&url) {
            if lists.urls.contains(&normalized) {
                return true;
            }
        }
        url.host_str()
            .is_some_and(|host| host_is_listed(host, &lists.domains))
    }

    #[test]
    fn matches_listed_hosts_and_subdomains_but_not_lookalikes() {
        let domains = "evil.test\nphish.co.uk\nco.uk\ncom\n";
        assert!(reports_with(domains, "", "https://evil.test/login"));
        assert!(reports_with(domains, "", "https://A.EVIL.TEST/login"));
        assert!(!reports_with(domains, "", "https://notevil.test/login"));
        assert!(reports_with(
            domains,
            "",
            "https://kit.phish.co.uk/index.html"
        ));
        assert!(!reports_with(domains, "", "https://other.co.uk/login"));
        assert!(!reports_with(domains, "", "https://example.com/login"));
    }

    #[test]
    fn matches_normalized_urls_and_ignores_default_ports() {
        let urls = "https://shared.test/kit\nHTTPS://SHARED.TEST:443/kit#frag\n";
        assert!(reports_with("", urls, "https://shared.test/kit"));
        assert!(reports_with("", urls, "https://SHARED.TEST:443/kit#extra"));
        assert!(!reports_with("", urls, "https://shared.test/other"));
        assert!(!reports_with("", urls, "https://safe.test/kit"));
    }

    #[test]
    fn official_lists_parse_and_skip_public_suffixes() {
        let lists = lists();
        assert!(!lists.domains.is_empty());
        assert!(!lists.urls.is_empty());
        assert!(!lists.domains.contains("com"));
        assert!(!lists.domains.contains("co.uk"));
        let domain = test_listed_domain();
        assert!(reports_url(
            &Url::parse(&format!("https://{domain}/pixel.gif")).unwrap()
        ));
        assert!(reports_url(
            &Url::parse(&format!("https://mail.{domain}/pixel.gif")).unwrap()
        ));
    }

    #[tokio::test]
    async fn warmup_loads_the_shared_lists() {
        warmup().await;
        assert!(LISTS.get().is_some());
    }
}
