import { output, process, run } from "./_utils.js";

async function step(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  await run(command, args);
}

try {
  await step("git", ["fetch", "origin"]);
  await step("git", ["reset", "--hard", "@{u}"]);
  await step("git", ["clean", "-fd"]);
  await step("git", ["pull"]);
  await step("npm", ["ci", "--ignore-scripts"]);
  const branch = await output("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const green = "\x1b[32m";
  const reset = "\x1b[0m";
  console.log(
    `\n${green}VM Setup Complete. You are on Branch ${branch}.${reset}\n`,
  );
} catch (error) {
  console.error("vi script failed:", error);
  process.exit(1);
}
