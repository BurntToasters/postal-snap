Postal Snap checks HTTP(S) mail links and consent-based remote images against bundled official TweetFeed domain and URL snapshots before DNS or `openUrl`. The check is local. Clients do not look up clicked addresses on TweetFeed's API, and v1 does not refresh these files in the background.

TweetFeed is the official publisher of its own CC0 1.0 IOC exports. The feeds are community-sourced and unverified. Postal Snap may say an address was **reported as potentially dangerous**. It must not say an address is confirmed malicious, confirmed phishing, or Safe based on these lists. TweetFeed branding is not shipped and is not an endorsement.

Official handle-free snapshots only:

- `https://api.tweetfeed.live/v1/blocklist/domains.txt` (rolling 30-day hosts)
- `https://api.tweetfeed.live/v1/blocklist/urls.txt` (exact URLs for kits on shared hosts)

Do not bundle TweetFeed `month.csv` / `year.csv` (they include researcher handles) or `adguard.txt` (that would mix threat rules into the advertising/tracking engine). Do not ship OpenPhish-derived EasyList-syntax lists.

Matching is a `HashSet` lookup, not `adblock-rust`:

- Domain: exact host plus subdomains of a listed domain. Public suffixes such as `com` or `co.uk` are never stored or matched on their own.
- URL: exact match after lowercase host, dropped default port, and dropped fragment.
- A threat match overrides an EasyList exception when both checks are on. Image SSRF, DNS pinning, and consent rules still apply after a threat miss, and they stay on if the user turns this list off.
- Settings > Advanced can disable the local TweetFeed check. That control defaults on. Turning it off requires typing `CONFIRM` in an in-app dialog, and `save_settings` rejects the change unless that token is present. The UI may say reported / potentially dangerous, never confirmed malicious or an unqualified Safe.
- HTML and plain-text links share one inspect / confirm / open path. Opening goes through Rust. The frontend opener plugin is not a policy bypass. The Apple app-password help page uses a separate allowlisted command.
- GitHub secret scanning may flag Telegram-bot URLs inside `tweetfeed-urls.txt`. Those lines are published IOCs, not Postal Snap secrets. `.github/secret_scanning.yml` ignores only the two TweetFeed snapshots. Do not scrub listed URLs or the official checksums break.

`src-tauri/filters/sources.json` records each exact download URL, byte count, SHA-256, TweetFeed `Updated` / entry count where present, and download time. TweetFeed also publishes those SHA-256 values, sizes, and row counts in the official `https://api.tweetfeed.live/v1/manifest`. The updater downloads only the reviewed `api.tweetfeed.live` list URLs, then refuses the files if they do not match that published checksum. The CC0 legal text comes from Creative Commons. Refresh TweetFeed without rewriting EasyList:

```sh
npm run tweetfeed:update
npm run filters:check
npm run test:rust -- threat_blocking
npm run test:rust -- security
```

`npm run filters:update` still refreshes every bundled list, including EasyList, and applies the same TweetFeed checksum check.

Coverage is a small rolling window of recently tweeted hosts. Most brand-new kits and most phishing paths on otherwise legitimate sites will miss unless that exact URL is listed. After **Open in browser**, the system browser's Safe Browsing (if any) is the remaining layer. This is not a replacement for attachment scanning or sender verification.

See [CONTENT_BLOCKING.md](CONTENT_BLOCKING.md) for advertising and tracking images, and TweetFeed's [terms](https://tweetfeed.live/tos/) for the community-sourced / no-live-polling constraints.
