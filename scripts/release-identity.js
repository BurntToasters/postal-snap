import { join } from "node:path";
import { json, output, process, root, sha256 } from "./_utils.js";
import { githubJson } from "./github-cli.js";
import {
  existingDraft,
  hasPublishedRelease,
  listMatchingReleases,
} from "./ensure-draft-release.js";

export const RELEASE_SESSION_SCHEMA = 2;
export const RELEASE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RELEASE_SESSION_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export async function currentReleaseSessionIdentity() {
  const [pkg, commit, rust, packageLockSha256, cargoLockSha256] =
    await Promise.all([
      json(join(root, "package.json")),
      output("git", ["rev-parse", "HEAD"]),
      output("rustc", ["--version"]),
      sha256(join(root, "package-lock.json")),
      sha256(join(root, "src-tauri/Cargo.lock")),
    ]);
  return {
    schema: RELEASE_SESSION_SCHEMA,
    version: pkg.version,
    tag: `v${pkg.version}`,
    commit,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    rust,
    packageLockSha256,
    cargoLockSha256,
  };
}

function verifyReleaseSessionTime(session, now = Date.now()) {
  const startedAt = Date.parse(session.startedAt);
  if (!Number.isFinite(startedAt)) {
    throw new Error(
      "Release session has an invalid start time; start a new session.",
    );
  }
  const age = now - startedAt;
  if (age < -RELEASE_SESSION_FUTURE_TOLERANCE_MS) {
    throw new Error(
      "Release session start time is in the future; check the host clock.",
    );
  }
  if (age > RELEASE_SESSION_MAX_AGE_MS) {
    throw new Error(
      "Release session is older than 24 hours; start a new session.",
    );
  }
}

export async function verifiedReleaseSession() {
  const [session, current] = await Promise.all([
    json(join(root, "release/.session.json")),
    currentReleaseSessionIdentity(),
  ]);
  for (const [field, value] of Object.entries(current)) {
    if (session[field] !== value) {
      throw new Error(
        `Release session ${field} does not match this host and checkout; start a new session.`,
      );
    }
  }
  verifyReleaseSessionTime(session);
  return session;
}

export async function remoteTagCommit(repository, tag, execute = githubJson) {
  const encodedTag = encodeURIComponent(tag);
  const reference = await execute([
    "api",
    `repos/${repository}/git/ref/tags/${encodedTag}`,
  ]);
  let object = reference.object;
  for (let depth = 0; object?.type === "tag" && depth < 8; depth += 1) {
    const tagObject = await execute([
      "api",
      `repos/${repository}/git/tags/${object.sha}`,
    ]);
    object = tagObject.object;
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}$/i.test(object.sha ?? ""))
    throw new Error(`Could not resolve ${tag} to a commit.`);
  return object.sha;
}

export async function verifyRemoteReleaseCommit(
  repository,
  session,
  execute = githubJson,
) {
  const commit = await remoteTagCommit(repository, session.tag, execute);
  if (commit.toLowerCase() !== session.commit.toLowerCase()) {
    throw new Error(
      `${session.tag} points to ${commit}, not release session commit ${session.commit}.`,
    );
  }
}

function publishedReleaseUploadError(tag) {
  return new Error(
    `Release ${tag} already exists as published. Refusing to upload to the published release.`,
  );
}

export async function verifyDraftReleaseCommit(
  repository,
  session,
  { listReleases = listMatchingReleases } = {},
) {
  const matching = await listReleases({
    repository,
    tag: session.tag,
  });
  if (hasPublishedRelease(matching, session.tag)) {
    throw publishedReleaseUploadError(session.tag);
  }
  const draft = existingDraft(matching, session.tag);
  if (!draft) {
    throw new Error(
      `No draft release found for ${session.tag}. Run "npm run release:draft" on the Windows machine first.`,
    );
  }
}
