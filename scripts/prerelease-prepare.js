import { join } from "node:path";
import { json, output, process, root, run } from "./_utils.js";
import { resolveUpdaterPublicKey } from "./updater-pubkey.js";
import { validateRepositoryMacosEntitlements } from "./validate-macos-entitlements.js";

function expectedReleaseBranch(version) {
  const numeric = "(?:0|[1-9]\\d*)";
  if (
    new RegExp(`^${numeric}\\.${numeric}\\.${numeric}-beta\\.${numeric}$`).test(
      version,
    )
  ) {
    return "beta";
  }
  if (new RegExp(`^${numeric}\\.${numeric}\\.${numeric}$`).test(version)) {
    return "main";
  }
  throw new Error(
    `Unsupported release version '${version}'; Postal Snap releases use beta or stable versions only.`,
  );
}

function assertClean(status) {
  if (status && process.env.ALLOW_DIRTY_RELEASE !== "1") {
    throw new Error(
      "Release requires a clean worktree. Set ALLOW_DIRTY_RELEASE=1 only for recovery.",
    );
  }
}

const pkg = await json(join(root, "package.json"));
const expectedBranch = expectedReleaseBranch(String(pkg.version ?? ""));
assertClean(
  await output("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
);
await validateRepositoryMacosEntitlements();

const branch = await output("git", ["branch", "--show-current"]);
if (branch !== expectedBranch) {
  throw new Error(
    `${pkg.version} must be released from ${expectedBranch}, not ${branch || "detached HEAD"}.`,
  );
}

await run("git", ["fetch", "--quiet", "origin"]);
const upstream = await output("git", [
  "rev-parse",
  "--abbrev-ref",
  "@{upstream}",
]);
const expectedUpstream = `origin/${expectedBranch}`;
if (upstream !== expectedUpstream) {
  throw new Error(
    `${expectedBranch} must track ${expectedUpstream}; current upstream is ${upstream}.`,
  );
}

const [head, upstreamHead] = await Promise.all([
  output("git", ["rev-parse", "HEAD"]),
  output("git", ["rev-parse", "@{upstream}"]),
]);
if (head !== upstreamHead) {
  throw new Error(
    `HEAD ${head.slice(0, 12)} does not match pushed ${expectedUpstream} ${upstreamHead.slice(0, 12)}.`,
  );
}

await run("npm", ["run", "sync-version"]);
assertClean(
  await output("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
);

const committed = await json(join(root, "src-tauri/tauri.conf.json"));
resolveUpdaterPublicKey({
  committed: committed.plugins?.updater?.pubkey,
  fromEnv: process.env.TAURI_UPDATER_PUBLIC_KEY,
  requireSigning: true,
});
console.log(
  `prerelease-prepare: ok (${pkg.version}, ${expectedBranch}@${head.slice(0, 12)})`,
);
