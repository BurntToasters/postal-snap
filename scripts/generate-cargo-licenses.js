import { join } from "node:path";
import { output, root, writeFile } from "./_utils.js";

const metadata = JSON.parse(
  await output("cargo", [
    "metadata",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--format-version",
    "1",
    "--locked",
  ]),
);
const rows = metadata.packages
  .map(
    (item) =>
      `${item.name} ${item.version} — ${item.license ?? "license metadata unavailable"}`,
  )
  .sort();
await writeFile(
  join(root, "THIRD_PARTY_NOTICES.cargo.txt"),
  `Postal Snap Rust dependencies\n\n${rows.join("\n")}\n`,
);
