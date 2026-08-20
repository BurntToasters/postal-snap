import { output, process, run } from "./_utils.js";
const status = await output("git", ["status", "--porcelain"]);
if (status && process.env.ALLOW_DIRTY_RELEASE !== "1")
  throw new Error(
    "Release requires a clean worktree. Set ALLOW_DIRTY_RELEASE=1 only for recovery.",
  );
await run("npm", ["run", "sync-version"]);
