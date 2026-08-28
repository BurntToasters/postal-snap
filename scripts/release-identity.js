import { join } from "node:path";
import { json, output, root } from "./_utils.js";
import { githubJson } from "./github-cli.js";
import {
  existingDraft,
  hasPublishedRelease,
  listMatchingReleases,
} from "./ensure-draft-release.js";

export async function verifiedReleaseSession() {
  const [session, pkg, commit] = await Promise.all([
    json(join(root, "release/.session.json")),
    json(join(root, "package.json")),
    output("git", ["rev-parse", "HEAD"]),
  ]);
  const expectedTag = `v${pkg.version}`;
  if (
    session.version !== pkg.version ||
    session.tag !== expectedTag ||
    session.commit !== commit
  ) {
    throw new Error(
      "Release session does not match the current version, tag, and commit.",
    );
  }
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

export async function resolveTargetCommitish(
  repository,
  commitish,
  execute = githubJson,
) {
  if (/^[a-f0-9]{40}$/i.test(commitish ?? "")) {
    return commitish.toLowerCase();
  }
  const commit = await execute([
    "api",
    `repos/${repository}/commits/${encodeURIComponent(commitish)}`,
  ]);
  const sha = commit?.sha;
  if (!/^[a-f0-9]{40}$/i.test(sha ?? "")) {
    throw new Error(`Could not resolve ${commitish} to a commit.`);
  }
  return sha.toLowerCase();
}

function publishedReleaseUploadError(tag) {
  return new Error(
    `Release ${tag} already exists as published. Refusing to upload to the published release.`,
  );
}

export async function verifyDraftReleaseCommit(
  repository,
  session,
  {
    listReleases = listMatchingReleases,
    resolveCommitish = resolveTargetCommitish,
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
  const targetCommitish = draft.target_commitish;
  if (!targetCommitish) {
    throw new Error(`Draft release ${session.tag} has no target commit.`);
  }
  const commit = await resolveCommitish(repository, targetCommitish);
  if (commit !== session.commit.toLowerCase()) {
    throw new Error(
      `Draft ${session.tag} targets ${targetCommitish} (${commit}), not release session commit ${session.commit}.`,
    );
  }
}
