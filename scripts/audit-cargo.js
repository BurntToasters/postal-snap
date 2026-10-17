import { process } from "./lib/paths.js";
import { run } from "./lib/spawn.js";

// Current Tauri 2 Linux WebKit/GTK support still pulls glib-macros through
// the GTK3 graph. Keep these IDs explicit and current: --deny warnings makes
// any new RustSec informational advisory fail CI and release preparation.
// Remove an entry once `cargo audit` stops reporting it.
const acknowledgedTauriAdvisories = [
  "RUSTSEC-2024-0370", // proc-macro-error through glib-macros
  "RUSTSEC-2024-0429", // glib VariantStrIter unsoundness
  // zbus 5.x split crates are deprecated in favor of zbus 6; the current
  // Tauri notification/keyring/opener plugins still pin ^5, so no patched
  // release exists to take. Revisit when those plugins adopt zbus 6.
  "RUSTSEC-2026-0370", // zvariant unmaintained
  "RUSTSEC-2026-0371", // zbus_names unmaintained
  "RUSTSEC-2026-0372", // zvariant_derive unmaintained
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
