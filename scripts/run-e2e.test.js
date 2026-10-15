import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";
import test from "node:test";

import { resolveE2ePort } from "./lib/e2e-port.js";
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

function runWithEnv(env) {
  const seen = {};
  const child = new EventEmitter();
  const result = runE2e({
    args: [],
    env,
    createViteServer: async (options) => {
      seen.port = options.server.port;
      return { listen: async () => {}, close: async () => {} };
    },
    spawnChild: (_command, _args, options) => {
      seen.childPort = options.env.POSTAL_SNAP_E2E_PORT;
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  });
  return result.then(() => seen);
}

test("E2E port defaults to 4173", async () => {
  assert.equal(resolveE2ePort({}), 4173);
  const seen = await runWithEnv({});
  assert.equal(seen.port, 4173);
  assert.equal(seen.childPort, "4173");
});

test("E2E port override reaches Vite and the Playwright child", async () => {
  assert.equal(resolveE2ePort({ POSTAL_SNAP_E2E_PORT: "4180" }), 4180);
  const seen = await runWithEnv({ POSTAL_SNAP_E2E_PORT: "4180" });
  assert.equal(seen.port, 4180);
  assert.equal(seen.childPort, "4180");
});

test("E2E port override rejects invalid values", async () => {
  for (const bad of ["abc", "80", "1023", "65536", "41.5", "-4173", "4173x"]) {
    assert.throws(
      () => resolveE2ePort({ POSTAL_SNAP_E2E_PORT: bad }),
      /POSTAL_SNAP_E2E_PORT/,
      bad,
    );
  }
  await assert.rejects(
    runWithEnv({ POSTAL_SNAP_E2E_PORT: "nope" }),
    /POSTAL_SNAP_E2E_PORT/,
  );
});
