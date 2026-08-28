import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { root } from "./_utils.js";
import {
  ensureDraftRelease,
  existingDraft,
  listAllGithubPages,
  main,
  waitForDraftRelease,
  waitTiming,
} from "./ensure-draft-release.js";

const tag = "v0.1.0";
const draft = { id: 11, tag_name: tag, draft: true, name: "Postal Snap 0.1.0" };
const published = { id: 12, tag_name: tag, draft: false };

function recordingRequest(handler) {
  const calls = [];
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    return handler(method, endpoint, body, calls);
  };
  return { calls, request };
}

test("Windows continue creates the draft and Mac/Linux wait", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.match(
    packageJson.scripts["release:win:continue"],
    /npm run release:draft &&/,
  );
  assert.doesNotMatch(
    packageJson.scripts["release:win:continue"],
    /release:wait-draft/,
  );
  for (const name of [
    "release:mac:continue",
    "release:mas:continue",
    "release:linux:x64:continue",
    "release:linux:arm64:continue",
  ]) {
    assert.match(packageJson.scripts[name], /npm run release:wait-draft &&/);
    assert.doesNotMatch(packageJson.scripts[name], /npm run release:draft &&/);
  }
});

test("lists GitHub releases page by page before matching a draft", async () => {
  const pages = [];
  const items = await listAllGithubPages(async (page, perPage) => {
    pages.push({ page, perPage });
    if (page === 1) {
      return Array.from({ length: perPage }, (_, index) => ({
        id: index,
        tag_name: `other-${index}`,
        draft: true,
      }));
    }
    if (page === 2) return [draft];
    return [];
  });
  assert.deepEqual(pages, [
    { page: 1, perPage: 100 },
    { page: 2, perPage: 100 },
  ]);
  assert.equal(existingDraft(items, tag)?.id, 11);
});

test("create mode reuses a draft and is the only creator", async () => {
  const { calls, request } = recordingRequest(async (method) => {
    if (method === "GET") return [published, draft];
    throw new Error("create mode must not POST when a draft already exists");
  });
  const reused = await ensureDraftRelease({ tag, request });
  assert.equal(reused.id, 11);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(calls[0].endpoint.includes("page=1"));
});

test("create mode creates a draft when none exists", async () => {
  const { calls, request } = recordingRequest(
    async (method, _endpoint, body) => {
      if (method === "GET") return [];
      return { id: 21, tag_name: body.tag_name, draft: true };
    },
  );
  const created = await ensureDraftRelease({
    tag,
    title: "Postal Snap 0.1.0",
    prerelease: false,
    target: "a".repeat(40),
    request,
  });
  assert.equal(created.id, 21);
  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, "repos/BurntToasters/postal-snap/releases");
  assert.deepEqual(posts[0].body, {
    tag_name: tag,
    name: "Postal Snap 0.1.0",
    draft: true,
    prerelease: false,
    target_commitish: "a".repeat(40),
    generate_release_notes: true,
  });
});

test("create mode refetches after a 422 instead of splitting drafts", async () => {
  let lists = 0;
  const { calls, request } = recordingRequest(async (method) => {
    if (method === "GET") {
      lists += 1;
      return lists === 1 ? [] : [draft];
    }
    const error = new Error("HTTP 422: Validation Failed");
    error.statusCode = 422;
    throw error;
  });
  const created = await ensureDraftRelease({
    tag,
    request,
    sleepFn: async () => {},
  });
  assert.equal(created.id, 11);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("create and wait refuse a published release as the draft target", async () => {
  const { request } = recordingRequest(async () => [published]);
  await assert.rejects(
    () => ensureDraftRelease({ tag, request }),
    /already exists as published/,
  );
  await assert.rejects(
    () =>
      waitForDraftRelease({
        tag,
        request,
        timeoutMs: 0,
        pollMs: 1,
        sleepFn: async () => {
          throw new Error("should not poll a published release");
        },
      }),
    /already exists as published/,
  );
});

test("wait mode never calls create", async () => {
  const { calls, request } = recordingRequest(async (method) => {
    if (method !== "GET") throw new Error("wait mode must never create");
    return [];
  });
  await assert.rejects(
    () =>
      waitForDraftRelease({
        tag,
        request,
        timeoutMs: 0,
        pollMs: 1,
        sleepFn: async () => {
          throw new Error("should not poll after timeout");
        },
      }),
    /Timed out after 0s waiting for draft v0\.1\.0.*npm run release:draft/,
  );
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(!calls.some((call) => call.method === "POST"));
});

test("wait mode returns the Windows draft without creating", async () => {
  let lists = 0;
  const { calls, request } = recordingRequest(async (method) => {
    if (method !== "GET") throw new Error("wait mode must never create");
    lists += 1;
    return lists < 3 ? [] : [draft];
  });
  const found = await waitForDraftRelease({
    tag,
    request,
    timeoutMs: 1000,
    pollMs: 1,
    sleepFn: async () => {},
  });
  assert.equal(found.id, 11);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET", "GET"],
  );
});

test("wait times out with a clear Windows draft error", async () => {
  await assert.rejects(
    () =>
      waitForDraftRelease({
        tag,
        request: async () => [],
        timeoutMs: 0,
        pollMs: 15_000,
        sleepFn: async () => {
          throw new Error("should not poll after timeout");
        },
      }),
    /Timed out after 0s waiting for draft v0\.1\.0\. Run "npm run release:draft" on the Windows machine first/,
  );
  assert.deepEqual(waitTiming({}), {
    timeoutMs: 1_800_000,
    pollMs: 15_000,
  });
  assert.deepEqual(
    waitTiming({
      RELEASE_DRAFT_WAIT_TIMEOUT_MS: "1000",
      RELEASE_DRAFT_WAIT_POLL_MS: "50",
    }),
    { timeoutMs: 1000, pollMs: 50 },
  );
});

test("main wait mode never creates and create mode is the only creator", async () => {
  const wait = recordingRequest(async (method) => {
    if (method !== "GET") throw new Error("wait mode must never create");
    return [];
  });
  await assert.rejects(
    () =>
      main({
        argv: ["node", "ensure-draft-release.js", "--wait"],
        authenticate: () => {},
        session: async () => ({ commit: "b".repeat(40) }),
        request: wait.request,
        sleepFn: async () => {},
        env: {
          RELEASE_DRAFT_WAIT_TIMEOUT_MS: "0",
          RELEASE_DRAFT_WAIT_POLL_MS: "1",
        },
      }),
    /Timed out after 0s waiting for draft v0\.1\.0/,
  );
  assert.ok(wait.calls.every((call) => call.method === "GET"));

  const create = recordingRequest(async (method, _endpoint, body) => {
    if (method === "GET") return [];
    return { id: 31, draft: true, tag_name: body.tag_name };
  });
  const created = await main({
    argv: ["node", "ensure-draft-release.js"],
    authenticate: () => {},
    session: async () => ({ commit: "b".repeat(40) }),
    request: create.request,
  });
  assert.equal(created.id, 31);
  assert.equal(create.calls.filter((call) => call.method === "POST").length, 1);
});
