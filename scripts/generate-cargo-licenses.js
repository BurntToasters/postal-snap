import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { root, writeFile } from "./lib/paths.js";
import { output } from "./lib/spawn.js";

const publicDir = join(root, "public");
const jsonOutputPath = join(publicDir, "licenses-cargo.json");
const noticesOutputPath = join(root, "THIRD_PARTY_NOTICES.cargo.txt");

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

export const filterNotices = `Bundled filter lists (not Cargo crates)

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

function computeReachablePackageIds(metadata) {
  const workspaceMembers = new Set(
    Array.isArray(metadata.workspace_members) ? metadata.workspace_members : [],
  );
  const resolveNodes = Array.isArray(metadata.resolve?.nodes)
    ? metadata.resolve.nodes
    : [];
  const nodesById = new Map(resolveNodes.map((node) => [node.id, node]));

  const queue = [...workspaceMembers];
  const reachable = new Set(queue);

  while (queue.length > 0) {
    const id = queue.shift();
    const node = nodesById.get(id);
    if (!node || !Array.isArray(node.deps)) continue;

    for (const dep of node.deps) {
      const depId = typeof dep?.pkg === "string" ? dep.pkg : null;
      if (!depId || reachable.has(depId)) continue;
      reachable.add(depId);
      queue.push(depId);
    }
  }

  return { reachable, workspaceMembers };
}

function hasLicenseTerms(text) {
  return /permission is hereby granted|licensed under|gnu (?:lesser )?general public license|mozilla public license|redistribution and use/i.test(
    text,
  );
}

function isWithin(dir, candidate) {
  const rel = relative(dir, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function isRealPathWithin(dir, candidate) {
  try {
    return isWithin(realpathSync(dir), realpathSync(candidate));
  } catch {
    return false;
  }
}

export function readLicenseTextsFromDirectory(packageDir, licenseFile = null) {
  if (!packageDir || !existsSync(packageDir)) return null;
  const realPackageDir = realpathSync(packageDir);
  const names = new Set(
    readdirSync(packageDir).filter((name) =>
      /^(licen[cs]e|copying|notice|authors|copyright)(?:[._-].*)?$/i.test(name),
    ),
  );
  if (typeof licenseFile === "string" && licenseFile.trim()) {
    const filePath = resolve(packageDir, licenseFile);
    if (
      isWithin(packageDir, filePath) &&
      existsSync(filePath) &&
      isRealPathWithin(realPackageDir, filePath)
    ) {
      names.add(relative(packageDir, filePath));
    }
  }

  const sections = [];
  for (const name of [...names].sort()) {
    const filePath = resolve(packageDir, name);
    if (
      !isWithin(packageDir, filePath) ||
      !existsSync(filePath) ||
      !isRealPathWithin(realPackageDir, filePath)
    ) {
      continue;
    }
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const text = readFileSync(filePath, "utf8").trim();
    const attributionOnly = /^(authors|copyright)(?:[._-].*)?$/i.test(name);
    if (text && (!attributionOnly || hasLicenseTerms(text))) {
      sections.push(`--- ${name} ---\n${text}`);
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function spdxReferences(licenses) {
  const identifiers = licenses.match(/[A-Za-z0-9.-]+(?:\+)?/g) ?? [];
  return [...new Set(identifiers)]
    .filter(
      (identifier) =>
        !["AND", "OR", "WITH", "LicenseRef"].includes(identifier) &&
        !identifier.startsWith("DocumentRef-"),
    )
    .map((identifier) => ({
      identifier,
      url: `https://spdx.org/licenses/${encodeURIComponent(identifier)}.html`,
    }));
}

export function compileCargoLicenseEntry(pkg) {
  const declared =
    typeof pkg.license === "string" && pkg.license.trim()
      ? pkg.license.trim()
      : "";
  const licenseFile =
    typeof pkg.license_file === "string" && pkg.license_file.trim()
      ? pkg.license_file.trim()
      : "";
  if (!declared && !licenseFile) {
    throw new Error(
      `Cargo dependency ${pkg.name}@${pkg.version} does not declare an SPDX license.`,
    );
  }
  const licenses = declared || licenseFile;
  const packagedDir =
    typeof pkg.manifest_path === "string" ? dirname(pkg.manifest_path) : null;
  const licenseText = packagedDir
    ? readLicenseTextsFromDirectory(packagedDir, licenseFile || null)
    : null;
  return {
    licenses,
    repository:
      typeof pkg.repository === "string" && pkg.repository.trim()
        ? pkg.repository.trim()
        : null,
    packageManager: "cargo",
    licenseText,
    licenseTextStatus: licenseText ? "bundled" : "not-packaged",
    licenseReferences: licenseText ? [] : spdxReferences(licenses),
  };
}

export function compileCargoLicenseEntries(
  packages,
  reachable,
  workspaceMembers,
) {
  const entries = {};
  for (const pkg of packages) {
    if (!pkg || typeof pkg.id !== "string") continue;
    if (!reachable.has(pkg.id) || workspaceMembers.has(pkg.id)) continue;
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
      continue;
    entries[`cargo:${pkg.name}@${pkg.version}`] = compileCargoLicenseEntry(pkg);
  }
  return Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

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
  const { reachable, workspaceMembers } = computeReachablePackageIds(metadata);
  const licenses = compileCargoLicenseEntries(
    metadata.packages,
    reachable,
    workspaceMembers,
  );
  mkdirSync(publicDir, { recursive: true });
  await writeFile(jsonOutputPath, `${JSON.stringify(licenses, null, 2)}\n`);
  await writeFile(
    noticesOutputPath,
    `Postal Snap Rust dependencies\n\n${rows.join("\n")}\n\n${filterNotices}`,
  );
  const missingText = Object.values(licenses).filter(
    (entry) => entry.licenseTextStatus === "not-packaged",
  ).length;
  console.log(
    `[licenses:cargo] Wrote ${Object.keys(licenses).length} cargo entries to ${jsonOutputPath}`,
  );
  if (missingText > 0) {
    console.warn(
      `[licenses:cargo] WARNING: ${missingText} crate package(s) did not include license text. SPDX identifiers remain visible in the credits window.`,
    );
  }
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  await main();
}
