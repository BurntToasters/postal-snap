import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { process, root, writeJson } from "./_utils.js";
import {
  currentReleaseSessionIdentity,
  verifiedReleaseSession,
} from "./release-identity.js";

const action = process.argv[2];
const path = join(root, "release/.session.json");
if (action === "start") {
  const identity = await currentReleaseSessionIdentity();
  await mkdir(join(root, "release"), { recursive: true });
  await writeJson(path, {
    ...identity,
    startedAt: new Date().toISOString(),
  });
  console.log(
    `release-session: started (${identity.version}, ${identity.platform}/${identity.arch}, ${identity.commit.slice(0, 12)})`,
  );
} else if (action === "verify") {
  const session = await verifiedReleaseSession();
  console.log(
    `release-session: ok (${session.version}, ${session.platform}/${session.arch}, ${session.commit.slice(0, 12)})`,
  );
} else if (action === "clear") {
  await rm(path, { force: true });
} else throw new Error("Use release-session.js start|verify|clear");
