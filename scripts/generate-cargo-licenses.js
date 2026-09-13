import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root, writeFile } from "./lib/paths.js";
import { output } from "./lib/spawn.js";

export function collectCargoLicenseRows(packages) {
  const items = Array.isArray(packages) ? packages : [];
  const missing = items
    .filter(
      (item) =>
        !String(item?.license ?? "").trim() &&
        !String(item?.license_file ?? "").trim(),
    )
    .map((item) => `${item?.name ?? "unknown"}@${item?.version ?? "unknown"}`);
  if (missing.length) {
    throw new Error(
      `Cargo packages are missing license metadata: ${missing.join(", ")}`,
    );
  }
  return items
    .map(
      (item) =>
        `${item.name} ${item.version} — ${String(item.license ?? "").trim() || item.license_file}`,
    )
    .sort();
}

const filterNotices = `Bundled filter lists (not Cargo crates)

EasyList and EasyPrivacy are authored by the EasyList authors.
Homepage: https://easylist.to/
Official snapshots:
  https://easylist.to/easylist/easylist.txt
  https://easylist.to/easylist/easyprivacy.txt
License: Creative Commons Attribution-ShareAlike 3.0 Unported
  (the CC BY-SA option of EasyList's dual GPL/CC BY-SA license)
License text: LICENSE-CC-BY-SA-3.0.txt in the application package
Provenance: src-tauri/filters/sources.json

TweetFeed community-reported domain and URL snapshots are published by TweetFeed.
Homepage: https://tweetfeed.live/
Official snapshots:
  https://api.tweetfeed.live/v1/blocklist/domains.txt
  https://api.tweetfeed.live/v1/blocklist/urls.txt
License: CC0 1.0 Universal
License text: LICENSE-CC0-1.0.txt in the application package
These feeds are community-sourced and unverified. Presence on a list is not
confirmation that an address is malicious. TweetFeed branding is not used.
Provenance: src-tauri/filters/sources.json
`;

export async function main() {
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
  const rows = collectCargoLicenseRows(metadata.packages);
  await writeFile(
    join(root, "THIRD_PARTY_NOTICES.cargo.txt"),
    `Postal Snap Rust dependencies\n\n${rows.join("\n")}\n\n${filterNotices}`,
  );
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  await main();
}
