import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { json } from "./lib/json.js";
import { root } from "./lib/paths.js";
import {
  cargoTomlPackageName,
  replaceCargoLockPackageVersion,
  replaceChangelogDownloadVersions,
  replaceMetainfoReleaseVersion,
  utcIsoDate,
  replacePackageLockVersion,
  replaceReleasingTagExamples,
  replaceCargoTomlVersion,
} from "./sync-version.js";

test("replaceCargoTomlVersion updates the package version line", () => {
  const cargo = '[package]\nname = "postal-snap"\nversion = "0.1.1"\n';
  assert.equal(
    replaceCargoTomlVersion(cargo, "0.1.2"),
    '[package]\nname = "postal-snap"\nversion = "0.1.2"\n',
  );
});

test("replaceCargoLockPackageVersion updates only the named package", () => {
  const lock = `[[package]]
name = "other"
version = "0.1.1"

[[package]]
name = "postal-snap"
version = "0.1.1"
dependencies = [
 "tokio",
]
`;
  assert.equal(
    replaceCargoLockPackageVersion(lock, "postal-snap", "0.1.2"),
    `[[package]]
name = "other"
version = "0.1.1"

[[package]]
name = "postal-snap"
version = "0.1.2"
dependencies = [
 "tokio",
]
`,
  );
});

test("replaceCargoLockPackageVersion fails closed when the package is missing", () => {
  assert.throws(
    () =>
      replaceCargoLockPackageVersion(
        'version = "0.1.1"\n',
        "postal-snap",
        "0.1.2",
      ),
    /missing a \[\[package\]\] entry/,
  );
});

test("replacePackageLockVersion updates both npm root version fields", () => {
  const lock = {
    name: "postal-snap",
    version: "0.1.8",
    packages: { "": { name: "postal-snap", version: "0.1.8" } },
  };
  const updated = replacePackageLockVersion(lock, "0.1.9");
  assert.equal(updated.version, "0.1.9");
  assert.equal(updated.packages[""].version, "0.1.9");
  assert.equal(lock.version, "0.1.8");
});

test("replaceMetainfoReleaseVersion updates only the newest AppStream release", () => {
  const xml = `<releases>
    <release version="0.1.8" date="2026-08-01" />
    <release version="0.1.7" />
  </releases>`;
  assert.equal(
    replaceMetainfoReleaseVersion(xml, "0.1.9", "2026-09-13"),
    `<releases>
    <release version="0.1.9" date="2026-09-13" />
    <release version="0.1.7" />
  </releases>`,
  );
  assert.match(
    replaceMetainfoReleaseVersion(xml, "0.1.8", "2026-09-13"),
    /version="0\.1\.8" date="2026-08-01"/,
  );
  assert.equal(
    replaceMetainfoReleaseVersion(
      `<releases>\n    <release version="0.1.9" />\n  </releases>`,
      "0.1.9",
      "2026-09-13",
    ),
    `<releases>\n    <release version="0.1.9" date="2026-09-13" />\n  </releases>`,
  );
  assert.equal(utcIsoDate(new Date("2026-09-13T23:59:59.000Z")), "2026-09-13");
  assert.throws(
    () => replaceMetainfoReleaseVersion("<component />", "0.1.9", "2026-09-13"),
    /missing a <releases> block/,
  );
  assert.throws(
    () =>
      replaceMetainfoReleaseVersion(
        "<releases></releases>",
        "0.1.9",
        "2026-09-13",
      ),
    /missing a <release version=/,
  );
  assert.throws(
    () => replaceMetainfoReleaseVersion(xml, "0.1.9"),
    /YYYY-MM-DD/,
  );
});

test("replaceChangelogDownloadVersions rewrites only the download table", () => {
  const changelog = `# Downloads
[exe](https://github.com/BurntToasters/postal-snap/releases/download/v0.1.8/Postal-Snap-Windows-x64.exe)

## Changes in \`v0.1.8:\`
- draft download links target \`v0.1.8\`.
`;
  const updated = replaceChangelogDownloadVersions(changelog, "0.1.9");
  assert.match(updated, /\/download\/v0\.1\.9\/Postal-Snap-Windows-x64\.exe/);
  assert.match(updated, /## Changes in `v0\.1\.8:`/);
  assert.match(updated, /draft download links target `v0\.1\.8`/);
  assert.throws(
    () => replaceChangelogDownloadVersions("# Downloads\n", "0.1.9"),
    /missing a Changes in section/,
  );
});

test("replaceReleasingTagExamples rewrites the current signed-tag command", () => {
  const docs =
    'Tag it: `git tag -s v0.1.8 -m "Postal Snap v0.1.8"`, `git push origin v0.1.8`, then `git tag -v v0.1.8` done.';
  assert.equal(
    replaceReleasingTagExamples(docs, "0.1.9"),
    'Tag it: `git tag -s v0.1.9 -m "Postal Snap v0.1.9"`, `git push origin v0.1.9`, then `git tag -v v0.1.9` done.',
  );
});

test("committed package versions stay aligned for locked cargo commands", async () => {
  const pkg = await json(join(root, "package.json"));
  const packageLock = await json(join(root, "package-lock.json"));
  const tauri = await json(join(root, "src-tauri/tauri.conf.json"));
  const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
  const lock = await readFile(join(root, "src-tauri/Cargo.lock"), "utf8");
  const metainfo = await readFile(
    join(root, "packaging/flatpak/run.rosie.snap.metainfo.xml"),
    "utf8",
  );
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  const releasing = await readFile(join(root, "docs/RELEASING.md"), "utf8");
  const packageName = cargoTomlPackageName(cargo);
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lockVersion = lock.match(
    new RegExp(
      `^\\[\\[package\\]\\]\\r?\\nname = "${packageName}"\\r?\\nversion = "([^"]+)"`,
      "m",
    ),
  )?.[1];
  const changelogHeader = changelog.slice(
    0,
    changelog.search(/^## Changes in /m),
  );

  assert.equal(tauri.version, pkg.version);
  assert.equal(packageLock.version, pkg.version);
  assert.equal(packageLock.packages[""].version, pkg.version);
  assert.equal(cargoVersion, pkg.version);
  assert.equal(lockVersion, pkg.version);
  assert.match(
    metainfo,
    new RegExp(`<release version="${pkg.version}" date="\\d{4}-\\d{2}-\\d{2}"`),
  );
  assert.match(metainfo, /<developer id="run\.rosie">/);
  assert.match(metainfo, /<name>BurntToasters<\/name>/);
  assert.match(
    changelogHeader,
    new RegExp(`/releases/download/v${pkg.version}/`),
  );
  assert.match(releasing, new RegExp(`git tag -s v${pkg.version} `));
  assert.equal(
    replaceMetainfoReleaseVersion(metainfo, pkg.version, "2099-01-01"),
    metainfo,
  );
  assert.equal(
    replaceChangelogDownloadVersions(changelog, pkg.version),
    changelog,
  );
  assert.equal(replaceReleasingTagExamples(releasing, pkg.version), releasing);
});
