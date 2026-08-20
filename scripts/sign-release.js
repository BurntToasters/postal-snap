import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureReleaseDir,
  process,
  run,
  runWithInput,
  sha256,
  writeFile,
} from "./_utils.js";

const directory = await ensureReleaseDir();
const stageOnly = process.argv.includes("--stage");
const names = (await readdir(directory)).filter(
  (name) => !/\.(asc|sha256|sig|json)$/.test(name),
);
if (!names.length) throw new Error("No release artifacts found to sign.");
for (const name of names) {
  const path = join(directory, name);
  await writeFile(`${path}.sha256`, `${await sha256(path)}  ${name}\n`);
  if (!stageOnly) {
    const args = [
      "--batch",
      "--yes",
      ...(process.env.GPG_KEY_ID
        ? ["--local-user", process.env.GPG_KEY_ID]
        : []),
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
  }
}
console.log(
  `${stageOnly ? "Staged checksums for" : "Signed"} ${names.length} artifact(s).`,
);
