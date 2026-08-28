import { join } from "node:path";
import { json, output, process, root, run } from "./_utils.js";
import { resolveUpdaterPublicKey } from "./updater-pubkey.js";

const status = await output("git", ["status", "--porcelain"]);
if (status && process.env.ALLOW_DIRTY_RELEASE !== "1")
  throw new Error(
    "Release requires a clean worktree. Set ALLOW_DIRTY_RELEASE=1 only for recovery.",
  );
await run("npm", ["run", "sync-version"]);

const committed = await json(join(root, "src-tauri/tauri.conf.json"));
resolveUpdaterPublicKey({
  committed: committed.plugins?.updater?.pubkey,
  fromEnv: process.env.TAURI_UPDATER_PUBLIC_KEY,
  requireSigning: true,
});
