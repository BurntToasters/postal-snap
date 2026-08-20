import { join } from "node:path";
import { json, root, writeFile } from "./_utils.js";

const lock = await json(join(root, "package-lock.json"));
const rows = Object.entries(lock.packages ?? {})
  .filter(([path]) => path.startsWith("node_modules/"))
  .map(
    ([path, data]) =>
      `${path.slice(13)} ${data.version ?? "unknown"} — ${data.license ?? "license metadata unavailable"}`,
  )
  .sort((a, b) => a.localeCompare(b));
await writeFile(
  join(root, "THIRD_PARTY_NOTICES.npm.txt"),
  `Postal Snap npm dependencies\n\n${rows.join("\n")}\n`,
);
