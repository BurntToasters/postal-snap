import { join } from "node:path";
import { json, output, root } from "./_utils.js";

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

export async function remoteTagCommit(repository, tag, execute = output) {
  const encodedTag = encodeURIComponent(tag);
  const reference = JSON.parse(
    await execute("gh", [
      "api",
      `repos/${repository}/git/ref/tags/${encodedTag}`,
    ]),
  );
  let object = reference.object;
  for (let depth = 0; object?.type === "tag" && depth < 8; depth += 1) {
    const tagObject = JSON.parse(
      await execute("gh", [
        "api",
        `repos/${repository}/git/tags/${object.sha}`,
      ]),
    );
    object = tagObject.object;
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}$/i.test(object.sha ?? ""))
    throw new Error(`Could not resolve ${tag} to a commit.`);
  return object.sha;
}

export async function verifyRemoteReleaseCommit(repository, session) {
  const commit = await remoteTagCommit(repository, session.tag);
  if (commit.toLowerCase() !== session.commit.toLowerCase()) {
    throw new Error(
      `${session.tag} points to ${commit}, not release session commit ${session.commit}.`,
    );
  }
}
