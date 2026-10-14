import { process } from "./lib/paths.js";
import { run } from "./lib/spawn.js";

// Current Tauri 2 Linux WebKit/GTK support still pulls glib-macros through
// the GTK3 graph. Keep these IDs explicit and current: --deny warnings makes
// any new RustSec informational advisory fail CI and release preparation.
// Remove an entry once `cargo audit` stops reporting it.
const acknowledgedTauriAdvisories = [
  "RUSTSEC-2024-0370", // proc-macro-error through glib-macros
  "RUSTSEC-2024-0429", // glib VariantStrIter unsoundness
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
