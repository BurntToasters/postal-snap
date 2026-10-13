import { createHash } from "node:crypto";
import { join } from "node:path";
import { sha256 } from "./lib/artifacts.js";
import { json } from "./lib/json.js";
import { process, root } from "./lib/paths.js";
import { output } from "./lib/spawn.js";
import { githubApi, githubJson } from "./github-cli.js";
import {
  existingDraft,
  hasPublishedRelease,
  listMatchingReleases,
} from "./ensure-draft-release.js";

export const RELEASE_SESSION_SCHEMA = 3;
export const RELEASE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RELEASE_SESSION_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const RELEASE_SESSION_BUNDLE_INPUTS = Object.freeze([
  "public/licenses.json",
  "public/licenses-cargo.json",
  "THIRD_PARTY_NOTICES.npm.txt",
  "THIRD_PARTY_NOTICES.cargo.txt",
]);

export async function assertReleaseWorktreeClean(
  status = () =>
    output("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
) {
  if (await status()) {
    throw new Error(
      "Release requires a clean worktree; commit and push changes before preparing a session.",
    );
  }
}

export async function releaseBundleResourcesSha256(directory = root) {
  const resources = [];
  for (const path of RELEASE_SESSION_BUNDLE_INPUTS) {
    let digest;
    try {
      digest = await sha256(join(directory, path));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(
          `Required release bundle input '${path}' is missing. Run "npm run licenses", then start a new release session.`,
          { cause: error },
        );
      }
      throw error;
    }
    resources.push([path, digest]);
  }
  return createHash("sha256").update(JSON.stringify(resources)).digest("hex");
}

export async function currentReleaseSessionIdentity() {
  await assertReleaseWorktreeClean();
  const [
    pkg,
    commit,
    rust,
    packageLockSha256,
    cargoLockSha256,
    bundleResourcesSha256,
  ] = await Promise.all([
    json(join(root, "package.json")),
    output("git", ["rev-parse", "HEAD"]),
    output("rustc", ["--version"]),
    sha256(join(root, "package-lock.json")),
    sha256(join(root, "src-tauri/Cargo.lock")),
    releaseBundleResourcesSha256(),
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
    bundleResourcesSha256,
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

function assertDraftTargetCommit(session, draft) {
  if (!/^[a-f0-9]{40}$/i.test(session.commit ?? "")) {
    throw new Error("Release session has an invalid commit identity.");
  }
  if (
    typeof draft.target_commitish !== "string" ||
    draft.target_commitish.toLowerCase() !== session.commit.toLowerCase()
  ) {
    throw new Error(
      `${session.tag} draft target_commitish ${draft.target_commitish ?? "is missing"}, not release session commit ${session.commit}.`,
    );
  }
}

async function verifyExistingDraftTag(repository, session, resolveTag) {
  let commit;
  try {
    commit = await resolveTag(repository, session.tag);
  } catch (error) {
    if (error?.statusCode === 404) return false;
    throw error;
  }
  if (commit.toLowerCase() !== session.commit.toLowerCase()) {
    throw new Error(
      `${session.tag} points to ${commit}, not release session commit ${session.commit}.`,
    );
  }
  return true;
}

export async function verifyDraftReleaseCommit(
  repository,
  session,
  {
    listReleases = listMatchingReleases,
    request = githubApi,
    resolveTag = remoteTagCommit,
  } = {},
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
  const existingTag = await verifyExistingDraftTag(
    repository,
    session,
    resolveTag,
  );
  if (!existingTag) assertDraftTargetCommit(session, draft);
  if (draft.tag_name === session.tag) return;
  console.log(
    `Restoring GitHub tag ${session.tag} on untagged draft ${draft.id}.`,
  );
  const updated = await request(
    "PATCH",
    `repos/${repository}/releases/${draft.id}`,
    {
      tag_name: session.tag,
      draft: true,
    },
  );
  const updatedTag = await verifyExistingDraftTag(
    repository,
    session,
    resolveTag,
  );
  if (!updatedTag) {
    assertDraftTargetCommit(session, {
      ...draft,
      ...updated,
    });
  }
}
