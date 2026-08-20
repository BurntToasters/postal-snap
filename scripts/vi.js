import { join } from "node:path";
import { json, process, root, run, writeJson } from "./_utils.js";

const requested = process.argv[2];
if (!requested) {
  const pkg = await json(join(root, "package.json"));
  console.log(pkg.version);
} else {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested))
    throw new Error("Version must be valid SemVer.");
  const packagePath = join(root, "package.json");
  const pkg = await json(packagePath);
  pkg.version = requested;
  await writeJson(packagePath, pkg);
  await run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
  await run("npm", ["run", "sync-version"]);
}
