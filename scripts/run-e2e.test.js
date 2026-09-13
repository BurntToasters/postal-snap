import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";
import test from "node:test";

import { isDirectRun, runE2e } from "./run-e2e.js";

test("E2E runner owns Vite and closes it after Playwright", async () => {
  const calls = [];
  const server = {
    async listen() {
      calls.push("listen");
    },
    async close() {
      calls.push("close");
    },
  };
  const child = new EventEmitter();

  const result = runE2e({
    args: ["e2e/mail-flow.spec.ts"],
    env: { TEST_ENV: "kept" },
    createViteServer: async (options) => {
      assert.equal(options.server.strictPort, true);
      return server;
    },
    spawnChild: (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(-2), ["test", "e2e/mail-flow.spec.ts"]);
      assert.equal(options.env.TEST_ENV, "kept");
      assert.equal(options.env.POSTAL_SNAP_E2E_EXTERNAL_SERVER, "1");
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.equal(await result, 0);
  assert.deepEqual(calls, ["listen", "close"]);
});

test("E2E entry-point detection ignores path casing", () => {
  assert.equal(isDirectRun("/repo/scripts/run-e2e.js"), true);
  assert.equal(isDirectRun("/repo/scripts/RUN-E2E.JS"), true);
  assert.equal(isDirectRun("/repo/scripts/Run-E2e.Js"), true);
  assert.equal(isDirectRun("/repo/scripts/run-e2e.test.js"), false);
  assert.equal(isDirectRun(undefined), false);
});
