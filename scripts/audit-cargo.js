import { process, run } from "./_utils.js";

// Current Tauri 2 Linux WebKit/GTK support still traverses the unmaintained
// gtk-rs GTK3 graph. Tauri's urlpattern support also uses the unmaintained
// unic 0.9 graph. Keep these IDs explicit: --deny warnings then makes any new
// RustSec informational advisory fail CI and release preparation.
const acknowledgedTauriAdvisories = [
  "RUSTSEC-2024-0370", // proc-macro-error through glib-macros
  "RUSTSEC-2024-0411", // gdkwayland-sys
  "RUSTSEC-2024-0412", // gdk
  "RUSTSEC-2024-0413", // atk
  "RUSTSEC-2024-0414", // gdkx11-sys
  "RUSTSEC-2024-0415", // gtk
  "RUSTSEC-2024-0416", // atk-sys
  "RUSTSEC-2024-0417", // gdkx11
  "RUSTSEC-2024-0418", // gdk-sys
  "RUSTSEC-2024-0419", // gtk3-macros
  "RUSTSEC-2024-0420", // gtk-sys
  "RUSTSEC-2024-0429", // glib VariantStrIter unsoundness
  "RUSTSEC-2025-0075", // unic-char-range
  "RUSTSEC-2025-0080", // unic-common
  "RUSTSEC-2025-0081", // unic-char-property
  "RUSTSEC-2025-0098", // unic-ucd-version
  "RUSTSEC-2025-0100", // unic-ucd-ident
];

const args = [
  "audit",
  "--file",
  "src-tauri/Cargo.lock",
  "--deny",
  "warnings",
  ...acknowledgedTauriAdvisories.flatMap((id) => ["--ignore", id]),
  ...process.argv.slice(2),
];

await run("cargo", args);
