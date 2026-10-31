#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
out="$root/test-results/macos-updater"
mkdir -p "$out"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/postal-updater-check.XXXXXX")
trap 'chmod -R u+w "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT
python3 - "$root" "$tmp" <<'PY'
import json, pathlib, sys
root, tmp = map(pathlib.Path, sys.argv[1:])
source = root / 'src-tauri/vendor/tauri-plugin-updater/src/macos_install.rs'
updater = (root / 'src-tauri/vendor/tauri-plugin-updater/src/updater.rs').read_text()
start = updater.index('const SWAP_BUNDLE_JXA: &str')
end = updater.index('"#;', start) + 3
swap_script = updater[start:end]
start = updater.index('fn privileged_install_command(')
end = updater.index('/// Quotes `s` as an AppleScript string literal.', start)
privileged = updater[start:end]
wrapper = '''mod libc {
    pub const ENOATTR: i32 = 93;
    pub const XATTR_NOFOLLOW: i32 = 1;
    pub const O_NOFOLLOW: i32 = 0x100;
    pub const RENAME_SWAP: u32 = 2;
    unsafe extern "C" {
        pub fn removexattr(path: *const i8, name: *const i8, options: i32) -> i32;
        pub fn fremovexattr(fd: i32, name: *const i8, options: i32) -> i32;
        pub fn renamex_np(from: *const i8, to: *const i8, flags: u32) -> i32;
    }
}
mod macos_install { use crate::libc; include!(SOURCE); }
use std::path::Path;
SWAP_SCRIPT
PRIVILEGED
fn main() {
    let a: Vec<_> = std::env::args().collect();
    let stage = std::path::Path::new(&a[2]);
    let app = std::path::Path::new(&a[3]);
    let backup = std::path::Path::new(&a[4]);
    if a[1] == "privileged" || a[1] == "privileged-failure" {
        let live = app.join("Contents");
        let new = stage.join("Contents");
        let mut command = privileged_install_command(&live, &new, backup);
        if a[1] == "privileged-failure" {
            let end = command.find(")\\\" in ").unwrap() + 1;
            command = format!("case \\\"failed{}", &command[end..]);
            let move_new = format!("mv -f {} {}", sh_quote(&new), sh_quote(&live));
            assert!(command.contains(&move_new));
            command = command.replace(&move_new, "/usr/bin/false");
        }
        print!("{command}");
        return;
    }
    let result = if a[1] == "install" {
        macos_install::clear_staged_quarantine(stage).and_then(|()| macos_install::install_contents(stage, app, backup))
    } else { macos_install::replace_contents(&app.join("Contents"), &stage.join("Contents"), backup) };
    if result.is_err() { std::process::exit(1); }
}
'''.replace('SOURCE', json.dumps(str(source))).replace('SWAP_SCRIPT', swap_script).replace('PRIVILEGED', privileged)
(tmp / 'main.rs').write_text(wrapper)
PY
rustc --edition=2021 "$tmp/main.rs" -o "$tmp/install"
xcrun swiftc -module-cache-path "$tmp/swift-cache" scripts/verify-macos-updater.swift -o "$tmp/verify"
"$tmp/verify" "$tmp" "$tmp/install" "$out/result.json"
shasum -a 256 src-tauri/vendor/tauri-plugin-updater/src/macos_install.rs src-tauri/vendor/tauri-plugin-updater/src/updater.rs scripts/verify-macos-updater.swift scripts/verify-macos-updater.sh > "$out/inputs.sha256"
