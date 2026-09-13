import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json, writeJson } from "./lib/json.js";
import { root } from "./lib/paths.js";

export function cargoTomlPackageName(cargo) {
  const match = cargo.match(/^name\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("Cargo.toml is missing a package name.");
  return match[1];
}

export function replaceCargoTomlVersion(cargo, version) {
  const pattern = /^(version\s*=\s*")[^"]+("\s*)$/m;
  if (!pattern.test(cargo)) {
    throw new Error("Cargo.toml is missing a package version.");
  }
  return cargo.replace(pattern, `$1${version}$2`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceCargoLockPackageVersion(lock, packageName, version) {
  const pattern = new RegExp(
    `(^\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(packageName)}"\\r?\\nversion = ")[^"]+(")`,
    "m",
  );
  if (!pattern.test(lock)) {
    throw new Error(
      `Cargo.lock is missing a [[package]] entry for ${packageName}.`,
    );
  }
  return lock.replace(pattern, `$1${version}$2`);
}

export function replacePackageLockVersion(lock, version) {
  if (!lock || typeof lock !== "object" || !lock.packages?.[""]) {
    throw new Error("package-lock.json is missing its root package entry.");
  }
  return {
    ...lock,
    version,
    packages: {
      ...lock.packages,
      "": { ...lock.packages[""], version },
    },
  };
}

export function utcIsoDate(now = new Date()) {
  if (Number.isNaN(now.getTime())) {
    throw new Error("Invalid date for Flatpak metainfo.");
  }
  return now.toISOString().slice(0, 10);
}

function requireIsoDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `Flatpak metainfo release date must be YYYY-MM-DD, got ${date}`,
    );
  }
  return date;
}

export function replaceMetainfoReleaseVersion(xml, version, date) {
  requireIsoDate(date);
  const releases = String(xml ?? "").match(/<releases>[\s\S]*?<\/releases>/);
  if (!releases) {
    throw new Error("Flatpak metainfo is missing a <releases> block.");
  }
  let replaced = false;
  const updatedBlock = releases[0].replace(/<release\b[^>]*\/?>/, (tag) => {
    if (replaced) return tag;
    replaced = true;
    const currentVersion = tag.match(/\bversion="([^"]+)"/)?.[1];
    if (!currentVersion) {
      throw new Error(
        "Flatpak metainfo is missing a <release version=...> entry.",
      );
    }
    const currentDate = tag.match(/\bdate="([^"]+)"/)?.[1];
    const nextDate =
      currentVersion === version && currentDate ? currentDate : date;
    let next = tag.replace(/\bversion="[^"]+"/, `version="${version}"`);
    if (/\bdate="/.test(next)) {
      return next.replace(/\bdate="[^"]+"/, `date="${nextDate}"`);
    }
    if (/\/>/.test(next)) {
      return next.replace(/\s*\/>/, ` date="${nextDate}" />`);
    }
    return next.replace(/>$/, ` date="${nextDate}">`);
  });
  if (!replaced) {
    throw new Error(
      "Flatpak metainfo is missing a <release version=...> entry.",
    );
  }
  return xml.replace(releases[0], updatedBlock);
}

export function replaceChangelogDownloadVersions(changelog, version) {
  const split = String(changelog ?? "").search(/^## Changes in /m);
  if (split === -1) {
    throw new Error("CHANGELOG.md is missing a Changes in section.");
  }
  const header = changelog.slice(0, split);
  const rest = changelog.slice(split);
  const updatedHeader = header.replace(
    /\/releases\/download\/v[^/\s)]+/g,
    `/releases/download/v${version}`,
  );
  if (!updatedHeader.includes(`/releases/download/v${version}/`)) {
    throw new Error(
      "CHANGELOG.md download table is missing GitHub release links.",
    );
  }
  return `${updatedHeader}${rest}`;
}

export function replaceReleasingTagExamples(markdown, version) {
  const pattern =
    /`git tag -s v[^`]+ -m "Postal Snap v[^"]+"`, `git push origin v[^`]+`, then `git tag -v v[^`]+`/;
  if (!pattern.test(markdown)) {
    throw new Error("docs/RELEASING.md is missing the signed git tag example.");
  }
  return markdown.replace(
    pattern,
    `\`git tag -s v${version} -m "Postal Snap v${version}"\`, \`git push origin v${version}\`, then \`git tag -v v${version}\``,
  );
}

async function writeReplacedText(path, replace, version) {
  const current = await readFile(path, "utf8");
  await writeFile(path, replace(current, version));
}

export async function syncWorkspaceVersions(workspaceRoot, version) {
  const packageLockPath = join(workspaceRoot, "package-lock.json");
  const packageLock = await json(packageLockPath);
  await writeJson(
    packageLockPath,
    replacePackageLockVersion(packageLock, version),
  );

  const tauriPath = join(workspaceRoot, "src-tauri/tauri.conf.json");
  const tauri = await json(tauriPath);
  tauri.version = version;
  await writeJson(tauriPath, tauri);

  const cargoPath = join(workspaceRoot, "src-tauri/Cargo.toml");
  const cargo = await readFile(cargoPath, "utf8");
  await writeFile(cargoPath, replaceCargoTomlVersion(cargo, version));

  const cargoLockPath = join(workspaceRoot, "src-tauri/Cargo.lock");
  const cargoLock = await readFile(cargoLockPath, "utf8");
  await writeFile(
    cargoLockPath,
    replaceCargoLockPackageVersion(
      cargoLock,
      cargoTomlPackageName(cargo),
      version,
    ),
  );

  const metainfoPath = join(
    workspaceRoot,
    "packaging/flatpak/run.rosie.snap.metainfo.xml",
  );
  await writeFile(
    metainfoPath,
    replaceMetainfoReleaseVersion(
      await readFile(metainfoPath, "utf8"),
      version,
      utcIsoDate(),
    ),
  );
  await writeReplacedText(
    join(workspaceRoot, "CHANGELOG.md"),
    replaceChangelogDownloadVersions,
    version,
  );
  await writeReplacedText(
    join(workspaceRoot, "docs/RELEASING.md"),
    replaceReleasingTagExamples,
    version,
  );
}

async function main() {
  const pkg = await json(join(root, "package.json"));
  await syncWorkspaceVersions(root, pkg.version);
  console.log(`Versions synchronized to ${pkg.version}`);
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  await main();
}
