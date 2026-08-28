import assert from "node:assert/strict";
import test from "node:test";
import {
  quoteWindowsCmdArg,
  resolveSpawnInvocation,
  RM_RETRY_OPTIONS,
  windowsCmdLine,
} from "./_utils.js";

test("Windows cmd quoting wraps spaces and empty args", () => {
  assert.equal(quoteWindowsCmdArg("run"), "run");
  assert.equal(quoteWindowsCmdArg("sync-version"), "sync-version");
  assert.equal(quoteWindowsCmdArg(""), '""');
  assert.equal(quoteWindowsCmdArg("a b"), '"a b"');
  assert.equal(quoteWindowsCmdArg('say "hi"'), '"say \\"hi\\""');
});

test("Windows npm spawn avoids DEP0190 args-plus-shell concatenation", () => {
  const invocation = resolveSpawnInvocation(
    "npm",
    ["run", "sync-version"],
    { stdio: "inherit" },
    "win32",
  );
  assert.equal(invocation.command, "npm.cmd run sync-version");
  assert.equal(invocation.args, undefined);
  assert.equal(invocation.options.shell, true);
  assert.equal(
    windowsCmdLine("npm.cmd", ["run", "sync-version"]),
    invocation.command,
  );
});

test("non-cmd commands stay as file plus argv without a shell", () => {
  const git = resolveSpawnInvocation(
    "git",
    ["status", "--porcelain"],
    {},
    "win32",
  );
  assert.equal(git.command, "git");
  assert.deepEqual(git.args, ["status", "--porcelain"]);
  assert.equal(git.options.shell, false);

  const linuxNpm = resolveSpawnInvocation("npm", ["run", "test"], {}, "linux");
  assert.equal(linuxNpm.command, "npm");
  assert.deepEqual(linuxNpm.args, ["run", "test"]);
  assert.equal(linuxNpm.options.shell, false);
});

test("Windows directory removal retries locked files like IYERIS", () => {
  assert.equal(RM_RETRY_OPTIONS.maxRetries, 8);
  assert.equal(RM_RETRY_OPTIONS.retryDelay, 100);
});
