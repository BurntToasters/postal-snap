import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { isLinuxAppImage, isLinuxAppImageSignature } from "./artifacts.js";
import {
  RM_RETRY_OPTIONS,
  output,
  quoteWindowsCmdArg,
  resolveSpawnInvocation,
  windowsCmdLine,
} from "./spawn.js";

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

test("Linux updater predicates match IYERIS/Zinnia AppImage payloads", () => {
  assert.equal(isLinuxAppImage("Postal-Snap-Linux-x64.AppImage"), true);
  assert.equal(isLinuxAppImage("postal-snap_0.1.7_amd64.appimage"), true);
  assert.equal(isLinuxAppImage("Postal-Snap-Linux-x64.AppImage.tar.gz"), false);
  assert.equal(
    isLinuxAppImageSignature("Postal-Snap-Linux-x64.AppImage.sig"),
    true,
  );
  assert.equal(
    isLinuxAppImageSignature("Postal-Snap-Linux-x64.AppImage.tar.gz.sig"),
    false,
  );
});

test("output can include stderr for tools like codesign --display", async () => {
  const args = ["-e", "process.stderr.write('flags=0x10000(runtime)\\n')"];
  const withStderr = await output(process.execPath, args, {
    includeStderr: true,
  });
  assert.match(withStderr, /flags=0x10000\(runtime\)/);
  const stdoutOnly = await output(process.execPath, args);
  assert.equal(stdoutOnly, "");
});
