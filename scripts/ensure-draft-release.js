import { join } from "node:path";
import { json, process, root } from "./_utils.js";
import {
  assertGitHubCliAuthenticated,
  githubJson,
  runGitHub,
} from "./github-cli.js";
import {
  verifiedReleaseSession,
  verifyRemoteReleaseCommit,
} from "./release-identity.js";

assertGitHubCliAuthenticated();

const pkg = await json(join(root, "package.json"));
const tag = `v${pkg.version}`;
const prerelease = pkg.version.includes("-");
const session = await verifiedReleaseSession();
let release;
try {
  release = githubJson([
    "release",
    "view",
    tag,
    "--repo",
    "BurntToasters/postal-snap",
    "--json",
    "isDraft,tagName",
  ]);
} catch {
  runGitHub([
    "release",
    "create",
    tag,
    "--repo",
    "BurntToasters/postal-snap",
    "--draft",
    "--title",
    `Postal Snap ${pkg.version}`,
    "--target",
    session.commit,
    "--generate-notes",
    ...(prerelease ? ["--prerelease"] : []),
  ]);
}
if (release && !release.isDraft)
  throw new Error(`${tag} already exists and is not a draft release.`);
await verifyRemoteReleaseCommit("BurntToasters/postal-snap", session);
if (process.argv.includes("--wait")) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      runGitHub([
        "release",
        "view",
        tag,
        "--repo",
        "BurntToasters/postal-snap",
      ]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
