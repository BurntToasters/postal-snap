import { output, process, run } from "./_utils.js";

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
await run("git", ["fetch", "--prune", "origin"]);
const current = await output("git", ["branch", "--show-current"]);
const branches = (
  await output("git", [
    "for-each-ref",
    "--format=%(refname:short) %(upstream:track)",
    "refs/heads",
  ])
)
  .split("\n")
  .map((line) => line.replace(/\r$/, ""))
  .filter(Boolean)
  .filter((line) => line.includes("[gone]"))
  .map((line) => line.split(" ")[0])
  .filter((name) => name !== current && !["main", "beta"].includes(name));
for (const branch of branches) {
  if (dryRun) console.log(branch);
  else await run("git", ["branch", force ? "-D" : "-d", branch]);
}
if (dryRun && branches.length) {
  console.log(`gitprune: would delete ${branches.length} gone branch(es).`);
} else if (branches.length) {
  console.log(`gitprune: deleted ${branches.length} gone branch(es).`);
} else {
  console.log("gitprune: no gone branches.");
}
