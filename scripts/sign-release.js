import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureReleaseDir,
  json,
  output,
  process,
  root,
  run,
  runWithInput,
  sha256,
  writeFile,
} from "./_utils.js";

const pkg = await json(join(root, "package.json"));
const directory = await ensureReleaseDir();
const stageOnly = process.argv.includes("--stage");
console.log(`\nPostal Snap ${pkg.version} — release pipeline\n`);
console.log("[1/4] Checking GPG...");
try {
  await output("gpg", ["--version"]);
} catch {
  throw new Error("gpg not found.");
}

console.log("[2/4] Collecting artifacts...");
const names = (await readdir(directory)).filter(
  (name) => !/\.(asc|sha256|sig|json)$/.test(name),
);
if (!names.length) throw new Error("No release artifacts found to sign.");
console.log(`  Found ${names.length} artifact(s) in release/`);

console.log("[3/4] Generating checksums...");
console.log("[4/4] Signing...");
for (const name of names) {
  const path = join(directory, name);
  await writeFile(`${path}.sha256`, `${await sha256(path)}  ${name}\n`);
  console.log(`  + ${name}.sha256`);
  if (stageOnly) continue;
  const args = [
    "--batch",
    "--yes",
    ...(process.env.GPG_KEY_ID ? ["--local-user", process.env.GPG_KEY_ID] : []),
    ...(process.env.GPG_PASSPHRASE
      ? ["--pinentry-mode", "loopback", "--passphrase-fd", "0"]
      : []),
    "--armor",
    "--detach-sign",
    "--output",
    `${path}.asc`,
    path,
  ];
  if (process.env.GPG_PASSPHRASE) {
    const gpgEnvironment = { ...process.env };
    delete gpgEnvironment.GPG_PASSPHRASE;
    await runWithInput("gpg", args, `${process.env.GPG_PASSPHRASE}\n`, {
      env: gpgEnvironment,
    });
  } else {
    await run("gpg", args);
  }
  console.log(`  + ${name}.asc`);
}
if (stageOnly) {
  console.log("\nStaging-only mode — skipping GPG signatures.");
  console.log(`Staged checksums for ${names.length} artifact(s).\n`);
} else {
  console.log(`\nSigned ${names.length} artifact(s).\n`);
}
