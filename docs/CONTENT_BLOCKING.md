Postal Snap uses Brave's official `adblock` 0.13.3 Rust library to block known advertising and tracking images after the user chooses Load images. Checks run before DNS/network access for the initial URL and every redirect. Existing URL validation, DNS pinning, private-network blocking, HTTPS downgrade rejection, MIME/size/time limits, and the scriptless mail sandbox still apply.

The engine applies only network rules from the bundled official EasyList and EasyPrivacy snapshots. Email has no trusted publisher origin: requests use resource type `image`, method `GET`, an empty source origin, and third-party semantics. Sender addresses and the Tauri origin never grant site-specific exceptions. Generic list exceptions still apply, without bypassing the separate SSRF checks. Cosmetic filtering, scriptlets, replacement resources and URL parameter rewriting are not applied.

Filtering runs on Tokio's blocking pool. One process-wide engine is compiled in the background at startup and on first use if needed. The crate's `single-thread` default feature is disabled so it is safe to share across tasks; the embedded public-suffix resolver and regex support remain enabled. Neither matching nor engine initialization contacts a remote service.

Blocked images return a typed `blocked` result to the frontend, which retains the placeholder and explains why it remains blocked. Fetch failures remain retryable. An allowed image can still reveal the user's IP and any identifier in its URL. This feature does not certify messages or destinations as safe, remove inline newsletter promotions, or protect browsing after a link opens in the system browser. Settings > Advanced can turn advertising and tracking image checks off; remote-image consent and SSRF defenses still apply. Reported phishing and malware hosts use a separate TweetFeed matcher; see [THREAT_BLOCKING.md](THREAT_BLOCKING.md).

The library's origin was verified against the official [Brave repository](https://github.com/brave/adblock-rust), which links to the [`adblock` crate](https://crates.io/crates/adblock). Version 0.13.3 was fetched from `https://static.crates.io/crates/adblock/adblock-0.13.3.crate` and matched the official sparse registry checksum:

```text
SHA-256: f44b96a666a23c12acad7c688bfe8638a7094e7eabe765b09a6864ab991c676d
Git commit: 886d45dcf5283ce8eddc6d961e7dd27966ab23f2
Repository: https://github.com/brave/adblock-rust
License: MPL-2.0
```

All 46 published crate source files, license, and original Cargo manifest checked in that comparison matched the corresponding files in Brave's exact Git commit (the count includes the license and manifest). Cargo.lock records the crate checksum and registry dependencies. Cargo validates downloaded registry packages against their recorded checksums. The direct crate version is pinned; updating it requires repeating upstream provenance review. This verification establishes source correspondence, not a security audit of every dependency.

List snapshots come only from the URLs linked by the [EasyList maintainers](https://easylist.to/):

- `https://easylist.to/easylist/easylist.txt`
- `https://easylist.to/easylist/easyprivacy.txt`

`src-tauri/filters/sources.json` records each exact download URL, byte count, SHA-256, published version/commit where present, and download time. Original list files are retained unchanged. The list headers record EasyList commit `678e80ca1937b3053d43f6ea794de124be620aa6`, which exists on the official [easylist/easylist](https://github.com/easylist/easylist/commit/678e80ca1937b3053d43f6ea794de124be620aa6) repository and is GitHub-verified. The lists are attributed to the EasyList authors and distributed under their offered CC BY-SA 3.0 option, separately from Postal Snap's MPL-2.0 code. The license text comes directly from Creative Commons. See the [upstream licensing policy](https://easylist.to/pages/licence.html).

Maintainers refresh and validate snapshots with:

```sh
npm run filters:update
npm run filters:check
npm run test:rust -- content_blocking
npm run test:release-assets
npm run licenses
```

The updater uses fixed HTTPS endpoints, refuses redirects, bounds download time/size, verifies list headers and provenance fields, downloads all sources successfully before replacing any snapshot, and writes the manifest last. TweetFeed list bytes are also checked against the SHA-256, size, and row count published in TweetFeed's official `/v1/manifest`. Use `npm run tweetfeed:update` to refresh only those snapshots. A hash does not authenticate a publisher by itself: authenticity here relies on the reviewed official HTTPS endpoints; recorded hashes detect later byte changes. Review changes in the snapshot versions, hashes, source metadata and filter behavior before committing. Upstream URLs embedded inside filter text are data; they are never followed or executed.

Cargo's build script verifies bundled files against the manifest without network access and refuses mismatches. Script tests repeat offline verification and exercise corrupt/incorrect downloads. `.gitattributes` preserves exact downloaded bytes across platforms. The lists are compiled into the application binary. Generated Cargo notices include Brave's crate metadata plus EasyList/EasyPrivacy and TweetFeed attribution; the CC BY-SA 3.0 and CC0 1.0 license texts are packaged beside the snapshots.

This initial implementation updates definitions with application releases, not in the background. The source headers record publication dates; release maintainers should refresh snapshots before shipping. Known-tracker coverage ages between releases. The same snapshot pipeline also fetches official TweetFeed domain and URL lists; those stay in a separate matcher so tracker blocks and reported-threat blocks remain distinct. Runtime in-app list refresh remains later work. No detection-accuracy or release-readiness claim follows from mocked UI tests.
