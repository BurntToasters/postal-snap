import { basename, join } from "node:path";
import process from "node:process";
import { json, readFile, root } from "./_utils.js";
import { assertGitHubCliAuthenticated, githubApi } from "./github-cli.js";
import { verifiedReleaseSession } from "./release-identity.js";

// Windows is the single draft creator. Mac/Linux use --wait so GitHub cannot
// split one release into two drafts.
export const REPOSITORY = "BurntToasters/postal-snap";
export const DEFAULT_WAIT_TIMEOUT_MS = 1_800_000;
export const DEFAULT_WAIT_POLL_MS = 15_000;

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function waitTiming(env = process.env) {
  return {
    timeoutMs: Number.parseInt(
      env.RELEASE_DRAFT_WAIT_TIMEOUT_MS || String(DEFAULT_WAIT_TIMEOUT_MS),
      10,
    ),
    pollMs: Number.parseInt(
      env.RELEASE_DRAFT_WAIT_POLL_MS || String(DEFAULT_WAIT_POLL_MS),
      10,
    ),
  };
}

export function releasesListPath(repository, page, perPage) {
  return `repos/${repository}/releases?per_page=${perPage}&page=${page}`;
}

export async function listAllGithubPages(fetchPage, { perPage = 100 } = {}) {
  const pageSize = Math.max(1, Number(perPage) || 100);
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch)) {
      throw new Error("Unexpected releases payload type");
    }
    if (batch.length === 0) break;
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  return items;
}

export function matchingReleases(releases, tag) {
  return (Array.isArray(releases) ? releases : []).filter(
    (release) => release?.tag_name === tag,
  );
}

export function existingDraft(releases, tag) {
  return (
    matchingReleases(releases, tag).find((release) => release.draft) || null
  );
}

export function hasPublishedRelease(releases, tag) {
  return matchingReleases(releases, tag).some((release) => !release.draft);
}

export async function listMatchingReleases({
  repository = REPOSITORY,
  tag,
  request = githubApi,
} = {}) {
  // Drafts are not returned by the get-release-by-tag endpoint, so list and
  // match on tag_name.
  const releases = await listAllGithubPages((page, perPage) =>
    request("GET", releasesListPath(repository, page, perPage)),
  );
  return matchingReleases(releases, tag);
}

function publishedReleaseError(tag, action) {
  return new Error(
    `Release ${tag} already exists as published. Refusing to ${action} a draft for the same tag.`,
  );
}

export function releaseTitle(version) {
  return String(version ?? "")
    .trim()
    .replace(/^v/i, "");
}

export async function readChangelogReleaseBody(
  changelogPath = join(root, "CHANGELOG.md"),
) {
  let body;
  try {
    body = await readFile(changelogPath, "utf8");
  } catch (error) {
    throw new Error(
      `CHANGELOG.md is required for GitHub release notes: ${error.message}`,
      { cause: error },
    );
  }
  if (!body.trim()) {
    throw new Error(
      "CHANGELOG.md is empty; refusing to set blank release notes.",
    );
  }
  return body;
}

async function refreshDraft({
  repository,
  draft,
  target,
  name,
  body,
  request,
}) {
  const payload = { name, body };
  if (target) payload.target_commitish = target;
  const updated = await request(
    "PATCH",
    `repos/${repository}/releases/${draft.id}`,
    payload,
  );
  console.log(
    `   Synced CHANGELOG.md into release notes (${body.length} chars) for ${
      updated?.name || name
    }.`,
  );
  return updated;
}

export function describeDraft(release, tag) {
  const name = release?.name || tag;
  const assets = Array.isArray(release?.assets) ? release.assets.length : 0;
  return `${name} (id ${release?.id}, ${assets} assets)`;
}

export async function ensureDraftRelease({
  repository = REPOSITORY,
  tag,
  version,
  prerelease,
  target,
  body,
  changelogPath,
  request = githubApi,
  sleepFn = sleep,
} = {}) {
  const notes = body ?? (await readChangelogReleaseBody(changelogPath));
  const name = releaseTitle(version || tag);
  const matching = await listMatchingReleases({ repository, tag, request });
  const draft = existingDraft(matching, tag);
  if (draft) {
    console.log(
      `   Draft already exists: ${describeDraft(draft, tag)} - refreshing release notes.`,
    );
    return refreshDraft({
      repository,
      draft,
      target,
      name,
      body: notes,
      request,
    });
  }
  if (hasPublishedRelease(matching, tag)) {
    throw publishedReleaseError(tag, "create");
  }

  try {
    console.log("   No release found. Creating draft...");
    const created = await request("POST", `repos/${repository}/releases`, {
      tag_name: tag,
      name,
      body: notes,
      draft: true,
      prerelease,
      target_commitish: target,
    });
    console.log(
      `   Created draft release: ${describeDraft(created, tag)} with CHANGELOG.md release notes.`,
    );
    return created;
  } catch (error) {
    if (error.statusCode === 422) {
      console.log("   Create returned 422; re-checking for existing draft...");
      await sleepFn(2000);
      const afterRetry = await listMatchingReleases({
        repository,
        tag,
        request,
      });
      const reused = existingDraft(afterRetry, tag);
      if (reused) {
        console.log(
          `   Found existing draft after retry: ${describeDraft(reused, tag)}.`,
        );
        return refreshDraft({
          repository,
          draft: reused,
          target,
          name,
          body: notes,
          request,
        });
      }
      if (hasPublishedRelease(afterRetry, tag)) {
        throw publishedReleaseError(tag, "create");
      }
    }
    throw error;
  }
}

export async function waitForDraftRelease({
  repository = REPOSITORY,
  tag,
  request = githubApi,
  sleepFn = sleep,
  now = Date.now,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollMs = DEFAULT_WAIT_POLL_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const matching = await listMatchingReleases({ repository, tag, request });
    const draft = existingDraft(matching, tag);
    if (draft) {
      console.log(`   Found draft: ${describeDraft(draft, tag)}. Proceeding.`);
      return draft;
    }
    if (hasPublishedRelease(matching, tag)) {
      throw publishedReleaseError(tag, "wait for");
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for draft ${tag}. Run "npm run release:draft" on the Windows machine first, then retry.`,
      );
    }
    console.log(
      `Draft ${tag} not found yet (attempt ${attempt}); re-checking in ${Math.round(pollMs / 1000)}s...`,
    );
    await sleepFn(pollMs);
  }
}

export async function main({
  argv = process.argv,
  authenticate = assertGitHubCliAuthenticated,
  session = verifiedReleaseSession,
  request = githubApi,
  sleepFn = sleep,
  env = process.env,
} = {}) {
  authenticate();
  const pkg = await json(join(root, "package.json"));
  const tag = `v${pkg.version}`;
  const releaseSession = await session();
  const options = {
    repository: REPOSITORY,
    tag,
    version: pkg.version,
    prerelease: pkg.version.includes("-"),
    target: releaseSession.commit,
    request,
    sleepFn,
    ...waitTiming(env),
  };
  if (argv.includes("--wait")) {
    console.log(
      `Waiting for draft release ${tag} (created by the Windows machine); will NOT create it here...`,
    );
    return waitForDraftRelease(options);
  }
  console.log(`Ensuring draft release exists for ${tag}...`);
  return ensureDraftRelease(options);
}

export function isDirectExecution(argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return basename(entry).toLowerCase() === "ensure-draft-release.js";
}

if (isDirectExecution()) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Failed to ensure draft release: ${message}`);
    process.exit(1);
  });
}
