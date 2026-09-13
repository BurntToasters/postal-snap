import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "./lib/json.js";
import { root, writeFile } from "./lib/paths.js";

const NODE_MODULES_PREFIX = "node_modules/";

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

export async function main() {
  const lock = await json(join(root, "package-lock.json"));
  const rows = collectNpmLicenseRows(lock);
  await writeFile(
    join(root, "THIRD_PARTY_NOTICES.npm.txt"),
    `Postal Snap npm dependencies\n\n${rows.join("\n")}\n`,
  );
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  await main();
}
