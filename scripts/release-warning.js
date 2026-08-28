import { setTimeout as sleep } from "node:timers/promises";
import process from "node:process";

const red = "\x1b[31m";
const yellow = "\x1b[33m";
const reset = "\x1b[0m";
const banner =
  "[!!WARNING!!] The release scripts are DESTRUCTIVE.\n" +
  "              Any local changes to this branch will be lost, including\n" +
  "              uncommitted edits, staged work, and untracked files.";
console.error(`\n${red}${banner}${reset}\n`);

const argvBypass =
  process.argv.includes("--yes") || process.argv.includes("-y");
const envBypass =
  process.env.CI === "1" ||
  process.env.CI === "true" ||
  process.env.POSTAL_SNAP_RELEASE_CONFIRM === "YES";

if (argvBypass || envBypass) process.exit(0);

console.error(`${yellow}Continuing in 3 seconds…${reset}\n`);
await sleep(3000);
