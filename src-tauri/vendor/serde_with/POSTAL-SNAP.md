# Postal Snap patch

This directory is the published `serde_with 3.24.0` crate archive from
crates.io, SHA-256 `df9adc193c780ef8f159aee8b61e2d5801aaa555e6eb0947fe45530ec506296f`.
The digest matches the crates.io index and the original registry lock entry.
The upstream `LICENSE-APACHE` and `LICENSE-MIT` files are included unchanged.

The local patch removes only the unused Chrono adapter: its optional dependency,
feature aliases, serde and Schemars implementations, module, test target, and
associated feature documentation. Postal Snap does not enable that adapter.
The default `std` and `macros` features, `alloc`, and all other optional
adapters remain unchanged. This lets Cargo omit the denied, inactive Chrono
package from the lockfile while retaining the crate APIs used by Tauri.

The patch is selected by the root `src-tauri/Cargo.toml` crates.io path override.
Review the vendored source against this note before changing or removing it.
