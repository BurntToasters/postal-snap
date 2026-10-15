// Release dry run: no network, no real gh, no real repository.
// main() needs a signed release session, so the exported pieces are driven in
// the same order main uses; the post-publish beta sync calls the function the
// `--sync-beta-manifests` child process would run.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  fetchReleasesFromGitHub,
  manifestsForPayload,
  publishArgs,
  reconcileNewerPrereleaseFor,
  repository,
  runHardFinalize,
  syncLocalBetaManifests,
  syncRemoteBetaManifests,
} from "./finalize-release.js";
import { runGitHub } from "./github-cli.js";

const PUB_DATE = "2026-01-01T00:00:00.000Z";
const SIGNATURE = "dry-run-signature-".repeat(4);
const PAYLOADS = [
  "Postal-Snap-Linux-x64.AppImage",
  "Postal-Snap-macOS-universal.app.tar.gz",
  "Postal-Snap-Windows-x64.exe",
];

const FAKE_GH = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const norm = (a) =>
  !path.isAbsolute(a) ? a
  : /postal-snap-beta-manifests-/.test(a) ? "<staging>"
  : "<dir>/" + path.basename(a);
const entry = { argv: args.map(norm) };
const log = (extra) =>
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ ...entry, ...extra }) + "\\n");
const flag = (n) => args[args.indexOf(n) + 1];
const [a, b] = args;
if (a === "auth") { log({}); process.exit(0); }
if (a === "api" && /releases\\/latest$/.test(b)) { log({}); console.log(state.stable); process.exit(0); }
const page = /releases\\?per_page=100&page=(\\d+)$/.exec(b || "");
if (a === "api" && page) {
  const n = Number(page[1]);
  log({});
  console.log(JSON.stringify(state.releases.slice((n - 1) * 100, n * 100)));
  process.exit(0);
}
if (a === "release" && b === "view") {
  log({});
  console.log(Object.keys(state.assets[args[2]] || {}).join("\\n"));
  process.exit(0);
}
if (a === "release" && b === "download") {
  const body = (state.assets[args[2]] || {})[flag("--pattern")];
  if (!body) { log({ error: "missing" }); process.exit(1); }
  fs.writeFileSync(path.join(flag("--dir"), flag("--pattern")), JSON.stringify(body));
  log({}); process.exit(0);
}
if (a === "release" && b === "upload") {
  const files = args.slice(3).filter((x) => !x.startsWith("--") && x !== "BurntToasters/postal-snap");
  const uploaded = files.map((f) => {
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    return { name: path.basename(f), version: m.version, keys: Object.keys(m.platforms) };
  });
  log({ target: args[2], uploaded }); process.exit(0);
}
if (a === "release" && b === "edit") { log({}); process.exit(0); }
log({ unknown: true });
console.error("fake gh: unsupported call");
process.exit(3);
`;

const filler = (count) =>
  Array.from({ length: count }, (_, i) => ({
    tag_name: `v0.1.${i}`,
    draft: false,
    prerelease: false,
  }));
const published = (tag) => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes("-"),
});

function betaManifestSet(version, tag) {
  const out = {};
  for (const payload of PAYLOADS) {
    for (const { filename, manifest } of manifestsForPayload({
      version,
      tag,
      payload,
      signature: SIGNATURE,
      pubDate: PUB_DATE,
    })) {
      if (filename.includes("-beta-")) out[filename] = manifest;
    }
  }
  return out;
}

// Built by older tooling: no `<platform>-beta` key.
function legacyBetaSet() {
  const set = betaManifestSet("0.5.0-beta.2", "v0.5.0-beta.2");
  for (const m of Object.values(set)) {
    for (const key of Object.keys(m.platforms)) {
      if (key.endsWith("-beta")) delete m.platforms[key];
    }
  }
  return set;
}

const SCENARIOS = [
  {
    id: "stable-with-newer-beta",
    version: "0.4.3",
    // Page 1 is full, so beta.2 is only found by paging.
    releases: [...filler(100), published("v0.5.0-beta.2")],
    remote: {
      "v0.5.0-beta.2": betaManifestSet("0.5.0-beta.2", "v0.5.0-beta.2"),
    },
    expect: {
      stableManifests: true,
      uploads: 1,
      uploadVersion: "0.5.0-beta.2",
    },
  },
  {
    id: "stable-no-newer-beta",
    version: "0.4.3",
    releases: [...filler(3), published("v0.4.3"), published("v0.4.3-beta.1")],
    remote: {},
    expect: { stableManifests: true, uploads: 0 },
  },
  {
    id: "beta-only",
    version: "0.5.0-beta.1",
    releases: [published("v0.4.3")],
    remote: null,
    expect: {
      stableManifests: false,
      uploads: 2,
      uploadVersion: "0.5.0-beta.1",
    },
  },
  {
    id: "stable-with-tampered-beta",
    version: "0.4.3",
    releases: [published("v0.5.0-beta.2")],
    remote: {
      "v0.5.0-beta.2": betaManifestSet("0.5.0-beta.1", "v0.5.0-beta.1"),
    },
    expect: {
      stableManifests: true,
      uploads: 0,
      warnsWith: /--from v0\.5\.0-beta\.2/,
    },
  },
  {
    id: "stable-with-legacy-beta",
    version: "0.4.3",
    releases: [published("v0.5.0-beta.2")],
    remote: { "v0.5.0-beta.2": legacyBetaSet() },
    expect: { stableManifests: true, uploads: 0, skips: true },
  },
];

async function readLog(path) {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function runScenario(scenario, { work, outDir }) {
  const { id, version, releases } = scenario;
  const tag = `v${version}`;
  const prerelease = version.includes("-");
  const dir = join(work, id);
  const stage = join(dir, "release");
  await mkdir(stage, { recursive: true });

  const generated = {};
  for (const payload of PAYLOADS) {
    for (const { filename, manifest } of manifestsForPayload({
      version,
      tag,
      payload,
      signature: SIGNATURE,
      pubDate: PUB_DATE,
    })) {
      generated[filename] = manifest;
      await writeFile(
        join(stage, filename),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
  }
  const remote = scenario.remote ?? { [tag]: betaManifestSet(version, tag) };
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "calls.jsonl");
  await writeFile(
    statePath,
    JSON.stringify({ stable: "v0.4.3", releases, assets: remote }),
  );
  process.env.FAKE_GH_STATE = statePath;
  process.env.FAKE_GH_LOG = logPath;

  const order = [];
  let failure = null;
  const warnings = [];
  try {
    await runHardFinalize({
      prerelease,
      verifyDraft: async () => order.push("verifyDraft"),
      verifyDraftIdentity: async () => order.push("verifyDraftIdentity"),
      syncBetaManifests: async () => {
        order.push("syncBeta");
        await syncLocalBetaManifests(stage);
      },
      publish: async () => {
        order.push("publish");
        runGitHub(publishArgs(tag, prerelease));
      },
      verifyPublished: async () => order.push("verifyPublished"),
      reconcileBetaManifests: () => syncRemoteBetaManifests(tag),
      reconcileNewerPrerelease: () =>
        reconcileNewerPrereleaseFor({
          version,
          warn: (m) => warnings.push(m),
          fetchReleases: fetchReleasesFromGitHub,
          sync: syncRemoteBetaManifests,
        }),
    });
  } catch (error) {
    failure = String(error.message);
  }

  const calls = await readLog(logPath);
  const uploads = calls.filter((c) => c.target);
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  const names = Object.keys(generated);
  const e = scenario.expect;
  check("no unsupported gh call", !calls.some((c) => c.unknown));
  check(
    "stable manifests generated only for stable",
    names.some((n) => !n.includes("-beta-")) === e.stableManifests,
  );
  check(`${e.uploads} manifest upload(s)`, uploads.length === e.uploads);
  check(
    "uploads go to latest stable, beta files only",
    uploads.every(
      (u) =>
        u.target === "v0.4.3" &&
        u.uploaded.every(
          (f) => f.name.includes("-beta-") && f.version === e.uploadVersion,
        ),
    ),
  );
  if (prerelease) {
    check(
      "beta never lists releases",
      !calls.some((c) => /releases\?/.test(c.argv[1] ?? "")),
    );
    const editAt = calls.findIndex((c) => c.argv[1] === "edit");
    check(
      "first sync precedes publish",
      calls.findIndex((c) => c.target) < editAt,
    );
  }
  if (id === "stable-with-newer-beta") {
    const pages = calls.filter((c) => /page=\d+$/.test(c.argv[1] ?? ""));
    check("paged past the first 100 releases", pages.length === 2);
  }
  if (e.failsWith)
    check("recovery hint printed", e.failsWith.test(failure ?? ""));
  else check("no failure", failure === null);

  const art = join(outDir, id);
  await mkdir(join(art, "manifests"), { recursive: true });
  for (const [name, manifest] of Object.entries(generated)) {
    await writeFile(
      join(art, "manifests", name),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  await writeFile(
    join(art, "gh-calls.json"),
    `${JSON.stringify(calls, null, 2)}\n`,
  );
  return {
    id,
    version,
    order,
    failure,
    warnings,
    generated: names,
    uploads,
    checks,
  };
}

export async function runDryRun({ outDir }) {
  const work = await mkdtemp(join(tmpdir(), "postal-snap-dry-run-"));
  const binDir = join(work, "bin");
  await mkdir(binDir, { recursive: true });
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, FAKE_GH);
  await chmod(ghPath, 0o755);

  const saved = {
    PATH: process.env.PATH,
    log: console.log,
    fetch: globalThis.fetch,
  };
  // Fake gh only on PATH; any fetch is a failure.
  process.env.PATH = binDir;
  globalThis.fetch = () => {
    throw new Error("dry run must not use the network");
  };
  console.log = () => {};
  const results = [];
  try {
    for (const scenario of SCENARIOS) {
      results.push(await runScenario(scenario, { work, outDir }));
    }
  } finally {
    process.env.PATH = saved.PATH;
    console.log = saved.log;
    globalThis.fetch = saved.fetch;
    delete process.env.FAKE_GH_STATE;
    delete process.env.FAKE_GH_LOG;
    await rm(work, { recursive: true, force: true });
  }
  const ok = results.every((r) => r.checks.every((c) => c.ok));
  const summary = { repository, ok, scenarios: results };
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const outDir = resolve(
    import.meta.dirname,
    "../artifacts/0.4.3/release-dry-run",
  );
  const summary = await runDryRun({ outDir });
  for (const s of summary.scenarios) {
    for (const c of s.checks)
      console.log(`${c.ok ? "PASS" : "FAIL"} ${s.id}: ${c.name}`);
  }
  console.log(`Artifacts: ${outDir}`);
  process.exitCode = summary.ok ? 0 : 1;
}
