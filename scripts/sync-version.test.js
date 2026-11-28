import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { json } from "./lib/json.js";
import { root } from "./lib/paths.js";
import {
  cargoTomlPackageName,
  replaceCargoLockPackageVersion,
  ensureChangelogReleaseHeading,
  replaceChangelogDownloadVersions,
  replaceMetainfoReleaseVersion,
  syncChangelog,
  syncChangelogBetaBanner,
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

test("version sync keeps authored release details attached to their version", () => {
  const xml = `<releases>
    <release version="0.5.0" date="2026-10-21">
      <description><p>Postal Snap 0.5.0 release notes.</p></description>
    </release>
    <release version="0.4.1" date="2026-10-14" />
  </releases>`;
  const updated = replaceMetainfoReleaseVersion(
    xml,
    "0.5.4-beta.1",
    "2026-11-25",
  );
  assert.equal(
    updated,
    `<releases>
    <release version="0.5.4-beta.1" date="2026-11-25" />
    <release version="0.5.0" date="2026-10-21">
      <description><p>Postal Snap 0.5.0 release notes.</p></description>
    </release>
    <release version="0.4.1" date="2026-10-14" />
  </releases>`,
  );
  assert.equal(
    replaceMetainfoReleaseVersion(updated, "0.5.4-beta.1", "2099-01-01"),
    updated,
    "rerunning version sync must preserve the placeholder and authored notes",
  );

  const compact = `<releases><release version="0.5.0" date="2026-10-16"><description><p>Postal Snap 0.5.0 release notes.</p></description></release></releases>`;
  assert.equal(
    replaceMetainfoReleaseVersion(compact, "0.5.4-beta.2", "2026-11-25"),
    `<releases><release version="0.5.4-beta.2" date="2026-11-25" /><release version="0.5.0" date="2026-10-16"><description><p>Postal Snap 0.5.0 release notes.</p></description></release></releases>`,
    "compact release markup must still receive a sibling placeholder",
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

// Failure modes: stable keeps the banner shown, prerelease keeps it hidden,
// CRLF is lost, a missing or edited banner is silently skipped, or the later
// signature [!IMPORTANT] block gets commented out.
const BANNER_ACTIVE =
  "> [!IMPORTANT]\n> Unstable releases (like this one) are released rapidly one after another to test new features. You should never install the unstable releases unless you know what you're doing.";
const BANNER_HIDDEN = BANNER_ACTIVE.replace(/^/, "<!-- ") + "\n-->";
const bannerDoc = (banner) =>
  `${banner}\n\n# ⬇️ Downloads\n\n> [!IMPORTANT]\n> The \`.sig\` files...\n`;

test("syncChangelogBetaBanner shows the banner only for prereleases", () => {
  assert.equal(
    syncChangelogBetaBanner(bannerDoc(BANNER_HIDDEN), "0.6.0-beta.1"),
    bannerDoc(BANNER_ACTIVE),
  );
  assert.equal(
    syncChangelogBetaBanner(bannerDoc(BANNER_ACTIVE), "0.6.0-beta.1"),
    bannerDoc(BANNER_ACTIVE),
  );
  assert.equal(
    syncChangelogBetaBanner(bannerDoc(BANNER_ACTIVE), "0.6.0"),
    bannerDoc(BANNER_HIDDEN),
  );
  assert.equal(
    syncChangelogBetaBanner(bannerDoc(BANNER_HIDDEN), "0.6.0"),
    bannerDoc(BANNER_HIDDEN),
  );
});

test("syncChangelogBetaBanner keeps CRLF line endings", () => {
  const crlf = (text) => text.replace(/\n/g, "\r\n");
  assert.equal(
    syncChangelogBetaBanner(crlf(bannerDoc(BANNER_ACTIVE)), "0.6.0"),
    crlf(bannerDoc(BANNER_HIDDEN)),
  );
  assert.equal(
    syncChangelogBetaBanner(crlf(bannerDoc(BANNER_HIDDEN)), "0.6.0-beta.2"),
    crlf(bannerDoc(BANNER_ACTIVE)),
  );
});

test("syncChangelogBetaBanner fails closed when the banner is missing or edited", () => {
  assert.throws(
    () => syncChangelogBetaBanner("# ⬇️ Downloads\n", "0.6.0"),
    /beta banner not found/,
  );
  assert.throws(
    () =>
      syncChangelogBetaBanner(
        "> [!IMPORTANT]\n> Something else.\n\n# ⬇️ Downloads\n",
        "0.6.0",
      ),
    /beta banner not found/,
  );
  assert.throws(
    () => syncChangelogBetaBanner(`# Title\n\n${BANNER_ACTIVE}\n`, "0.6.0"),
    /beta banner not found/,
  );
});

// Failure modes: the heading is duplicated, lands below older notes, drops
// the prerelease suffix, or breaks CRLF files.
test("ensureChangelogReleaseHeading adds an empty newest-first section once", () => {
  const changelog =
    "# Downloads\n\n### ℹ️ Enjoying Postal Snap?\n\n## Changes in `v0.5.2:`\n\n- old\n";
  const expected =
    "# Downloads\n\n### ℹ️ Enjoying Postal Snap?\n\n## Changes in `v0.6.0-beta.1:`\n\n## Changes in `v0.5.2:`\n\n- old\n";
  assert.equal(
    ensureChangelogReleaseHeading(changelog, "0.6.0-beta.1"),
    expected,
  );
  assert.equal(
    ensureChangelogReleaseHeading(expected, "0.6.0-beta.1"),
    expected,
  );
  assert.equal(ensureChangelogReleaseHeading(changelog, "0.5.2"), changelog);
  const crlf = (text) => text.replace(/\n/g, "\r\n");
  assert.equal(
    ensureChangelogReleaseHeading(crlf(changelog), "0.6.0-beta.1"),
    crlf(expected),
  );
  assert.throws(
    () => ensureChangelogReleaseHeading("# Downloads\n", "0.6.0"),
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
  assert.equal(syncChangelog(changelog, pkg.version), changelog);
  assert.equal(replaceReleasingTagExamples(releasing, pkg.version), releasing);
});
