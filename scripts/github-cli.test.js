import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { output, root, run } from "./_utils.js";
import {
  githubApiArgs,
  githubCliEnvironment,
  githubStatusCode,
  releaseUploadArgs,
  runGitHub,
} from "./github-cli.js";

test("GitHub CLI children use credential-store authentication", () => {
  assert.deepEqual(
    githubCliEnvironment({
      PATH: "/bin",
      GH_TOKEN: "old",
      GITHUB_TOKEN: "old-too",
    }),
    { PATH: "/bin" },
  );
});

test("GitHub CLI commands preserve API and upload semantics", () => {
  assert.deepEqual(githubApiArgs("PATCH", "repos/o/r/releases/1", true), [
    "api",
    "--method",
    "PATCH",
    "repos/o/r/releases/1",
    "--input",
    "-",
  ]);
  assert.deepEqual(
    releaseUploadArgs("o/r", "v1.0.0", "/tmp/app.zip", { clobber: true }),
    [
      "release",
      "upload",
      "v1.0.0",
      "--repo",
      "o/r",
      "--clobber",
      "/tmp/app.zip",
    ],
  );
  assert.equal(githubStatusCode("HTTP 422: Validation Failed"), 422);
});

test("missing GitHub CLI tells the operator to install gh and log in", () => {
  assert.throws(
    () =>
      runGitHub(["auth", "status", "--hostname", "github.com"], {
        env: { PATH: "", PATHEXT: "" },
      }),
    /Install gh and run `gh auth login`/,
  );
});

test("shared run helpers refuse to spawn gh with inherited tokens", async () => {
  await assert.rejects(
    () => run("gh", ["auth", "status"]),
    /scripts\/github-cli\.js/,
  );
  await assert.rejects(
    () => output("gh", ["auth", "status"]),
    /scripts\/github-cli\.js/,
  );
});

test("release scripts spawn gh through the credential-store helper", async () => {
  const helper = await readFile(join(root, "scripts/github-cli.js"), "utf8");
  assert.match(helper, /delete childEnvironment\.GH_TOKEN/);
  assert.match(helper, /delete childEnvironment\.GITHUB_TOKEN/);
  assert.match(helper, /env:\s*githubCliEnvironment\(/);
  assert.match(helper, /"auth",\s*"status",\s*"--hostname",\s*"github.com"/);

  for (const name of [
    "ensure-draft-release.js",
    "finalize-release.js",
    "verify-release-draft.js",
    "release-identity.js",
  ]) {
    const source = await readFile(join(root, "scripts", name), "utf8");
    assert.match(source, /from "\.\/github-cli\.js"/);
    assert.doesNotMatch(source, /\b(?:run|output)\(\s*["']gh["']/);
  }
  for (const name of [
    "ensure-draft-release.js",
    "finalize-release.js",
    "verify-release-draft.js",
  ]) {
    const source = await readFile(join(root, "scripts", name), "utf8");
    assert.match(source, /assertGitHubCliAuthenticated/);
  }
});
