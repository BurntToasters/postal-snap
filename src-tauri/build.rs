fn main() {
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
