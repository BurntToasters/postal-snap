import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./lib/paths.js";
import { output, run } from "./lib/spawn.js";
import { compareVersions } from "./lib/versions.js";

const MANIFEST = "packaging/flatpak/run.rosie.snap.yml";
const MINIMUM_FLATPAK_BUILDER = "1.4.4";
const FLATPAK_BUILDER_REF = "org.flatpak.Builder//stable";
const FLATPAK_BUILDER_COMMAND = "flatpak-builder-wrapper";

const manifest = await readFile(join(root, MANIFEST), "utf8");
const runtimeVersion = manifest.match(
  /^runtime-version:\s*["']?([^\s#"']+)/m,
)?.[1];
if (!runtimeVersion) {
  throw new Error(`${MANIFEST} must set runtime-version.`);
}

await run("flatpak", [
  "remote-add",
  "--user",
  "--if-not-exists",
  "flathub",
  "https://flathub.org/repo/flathub.flatpakrepo",
]);
await run("flatpak", [
  "install",
  "--user",
  "-y",
  "flathub",
  `org.gnome.Platform//${runtimeVersion}`,
  `org.gnome.Sdk//${runtimeVersion}`,
  FLATPAK_BUILDER_REF,
]);

const builderVersion = await output("flatpak", [
  "run",
  "--user",
  `--command=${FLATPAK_BUILDER_COMMAND}`,
  FLATPAK_BUILDER_REF,
  "--version",
]).catch(() => "");
const builderMatch = builderVersion.match(/(\d+)\.(\d+)\.(\d+)/);
if (
  !builderMatch ||
  compareVersions(
    `${builderMatch[1]}.${builderMatch[2]}.${builderMatch[3]}`,
    MINIMUM_FLATPAK_BUILDER,
  ) < 0
) {
  throw new Error(
    `flatpak-builder >= ${MINIMUM_FLATPAK_BUILDER} is required. Install it with your distribution package manager before bundling.`,
  );
}
await output("flatpak", ["info", "--user", FLATPAK_BUILDER_REF]).catch(() => {
  throw new Error(
    "org.flatpak.Builder (flatpak-builder-lint) is required for the release manifest gate. Run `npm run setup:flatpak` again.",
  );
});

console.log(
  `[setup-flatpak] org.gnome.Platform//${runtimeVersion}, flatpak-builder ${MINIMUM_FLATPAK_BUILDER}+, and flatpak-builder-lint are ready.`,
);
