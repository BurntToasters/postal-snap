import { init } from "license-checker-rseidelsohn";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "./lib/json.js";
import { root, writeFile } from "./lib/paths.js";

const NODE_MODULES_PREFIX = "node_modules/";
const publicDir = join(root, "public");
const jsonOutputPath = join(publicDir, "licenses.json");
const noticesOutputPath = join(root, "THIRD_PARTY_NOTICES.npm.txt");

export function collectNpmLicenseRows(lock) {
  const entries = Object.entries(lock?.packages ?? {}).filter(([path]) =>
    path.startsWith(NODE_MODULES_PREFIX),
  );
  const missing = entries
    .filter(([, data]) => !String(data?.license ?? "").trim())
    .map(
      ([path, data]) =>
        `${path.slice(NODE_MODULES_PREFIX.length)}@${data?.version ?? "unknown"}`,
    );
  if (missing.length) {
    throw new Error(
      `npm dependencies are missing license metadata: ${missing.join(", ")}`,
    );
  }
  return entries
    .map(
      ([path, data]) =>
        `${path.slice(NODE_MODULES_PREFIX.length)} ${data.version ?? "unknown"} — ${data.license}`,
    )
    .sort((a, b) => a.localeCompare(b));
}

export function compileNpmLicenseEntries(modules) {
  const licenses = {};
  for (const key of Object.keys(modules).sort()) {
    if (key.startsWith("postal-snap@")) continue;
    const entry = modules[key];
    const spdx = Array.isArray(entry?.licenses)
      ? entry.licenses.join(" OR ")
      : entry?.licenses || "UNKNOWN";
    licenses[key] = {
      licenses: spdx,
      repository: entry?.repository || null,
      licenseText: entry?.licenseText || null,
      packageManager: "npm",
    };
  }
  const incomplete = Object.entries(licenses).filter(
    ([, entry]) => entry.licenses === "UNKNOWN" || !entry.licenseText,
  );
  if (incomplete.length > 0) {
    throw new Error(
      `Missing license metadata for: ${incomplete
        .slice(0, 10)
        .map(([name]) => name)
        .join(", ")}${incomplete.length > 10 ? "…" : ""}`,
    );
  }
  return licenses;
}

function loadProductionLicenses() {
  return new Promise((resolveLicenses, reject) => {
    init(
      {
        start: root,
        production: true,
        customFormat: {
          licenses: true,
          repository: true,
          licenseText: true,
        },
      },
      (error, result) => (error ? reject(error) : resolveLicenses(result)),
    );
  });
}

export async function main() {
  const lock = await json(join(root, "package-lock.json"));
  const rows = collectNpmLicenseRows(lock);
  const licenses = compileNpmLicenseEntries(await loadProductionLicenses());
  mkdirSync(dirname(jsonOutputPath), { recursive: true });
  await writeFile(jsonOutputPath, `${JSON.stringify(licenses, null, 2)}\n`);
  await writeFile(
    noticesOutputPath,
    `Postal Snap npm dependencies\n\n${rows.join("\n")}\n`,
  );
  console.log(
    `[licenses:npm] Wrote ${Object.keys(licenses).length} entries with license texts to ${jsonOutputPath}`,
  );
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  await main();
}
