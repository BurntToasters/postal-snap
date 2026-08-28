import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { json, output, process, root, writeJson } from "./_utils.js";
import { verifiedReleaseSession } from "./release-identity.js";

const action = process.argv[2];
const path = join(root, "release/.session.json");
if (action === "start") {
  const pkg = await json(join(root, "package.json"));
  const commit = await output("git", ["rev-parse", "HEAD"]);
  await mkdir(join(root, "release"), { recursive: true });
  await writeJson(path, {
    version: pkg.version,
    tag: `v${pkg.version}`,
    commit,
    startedAt: new Date().toISOString(),
  });
  console.log(
    `release-session: started (${pkg.version}, ${commit.slice(0, 12)})`,
  );
} else if (action === "verify") {
  const session = await verifiedReleaseSession();
  console.log(
    `release-session: ok (${session.version}, ${session.commit.slice(0, 12)})`,
  );
} else if (action === "clear") {
  await rm(path, { force: true });
} else throw new Error("Use release-session.js start|verify|clear");
