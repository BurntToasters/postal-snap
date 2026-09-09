fn main() {
    verify_filter_sources();
    let store_build = std::env::var_os("CARGO_FEATURE_FLATPAK").is_some()
        || std::env::var_os("CARGO_FEATURE_MAS").is_some()
        || std::env::var_os("CARGO_FEATURE_MSSTORE").is_some();

    let capability_pattern = if store_build {
        "./capabilities/store/**/*"
    } else {
        "./capabilities/direct/**/*"
    };

    // Raw Cargo checks do not receive Tauri CLI config merging. Supply the
    // same restrictive capability override used by packaged Store builds so
    // feature-isolation checks exercise the correct ACL set too.
    if store_build && std::env::var_os("TAURI_CONFIG").is_none() {
        let override_config = r#"{"app":{"security":{"capabilities":["store"]}},"bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":null}}"#;
        std::env::set_var("TAURI_CONFIG", override_config);
        println!("cargo:rustc-env=TAURI_CONFIG={override_config}");
    }

    println!("cargo:rerun-if-changed=capabilities/direct");
    println!("cargo:rerun-if-changed=capabilities/store");
    tauri_build::try_build(
        tauri_build::Attributes::new().capabilities_path_pattern(capability_pattern),
    )
    .expect("failed to build Tauri application metadata");
}

fn verify_filter_sources() {
    use sha2::{Digest, Sha256};
    println!("cargo:rerun-if-changed=filters");
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read("filters/sources.json").expect("missing bundled filter provenance"),
    )
    .expect("invalid bundled filter provenance");
    assert_eq!(manifest["schemaVersion"], 1);
    let sources = manifest["sources"]
        .as_array()
        .expect("missing filter sources");
    assert_eq!(sources.len(), 6);
    for (file, url) in [
        ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
        (
            "easyprivacy.txt",
            "https://easylist.to/easylist/easyprivacy.txt",
        ),
        (
            "LICENSE-CC-BY-SA-3.0.txt",
            "https://creativecommons.org/licenses/by-sa/3.0/legalcode.txt",
        ),
        (
            "tweetfeed-domains.txt",
            "https://api.tweetfeed.live/v1/blocklist/domains.txt",
        ),
        (
            "tweetfeed-urls.txt",
            "https://api.tweetfeed.live/v1/blocklist/urls.txt",
        ),
        (
            "LICENSE-CC0-1.0.txt",
            "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt",
        ),
    ] {
        let source = sources
            .iter()
            .find(|entry| entry["file"] == file)
            .expect("missing official filter source");
        assert_eq!(source["url"], url, "unexpected filter source");
        let bytes = std::fs::read(format!("filters/{file}")).expect("missing bundled filter file");
        assert_eq!(source["bytes"], bytes.len(), "filter size mismatch");
        assert_eq!(
            source["sha256"],
            format!("{:x}", Sha256::digest(&bytes)),
            "filter checksum mismatch"
        );
    }
}
