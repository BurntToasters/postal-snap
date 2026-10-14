import assert from "node:assert/strict";
import test from "node:test";
import {
  checkContract,
  mockCommands,
  rustCommands,
} from "./check-ipc-contract.js";

// Failure modes: stale mocks, new unmocked commands, stale exceptions, and
// unrelated object keys or plugin handlers mistaken for application commands.
test("extracts registrations rather than unrelated object properties", () => {
  assert.deepEqual(
    [...rustCommands("tauri::generate_handler![a::one, b::two]")],
    ["one", "two"],
  );
  assert.deepEqual(
    [
      ...mockCommands(`
    const unrelated = { bogus() {} };
    Object.assign(mock.handlers, { one() {}, two: () => null });
    switch (command) { case "three": break; case "plugin:event|emit": break; }
  `),
    ],
    ["one", "two", "three"],
  );
});

test("rejects drift in either direction and expired exceptions", () => {
  assert.deepEqual(checkContract(new Set(["one"]), new Set(["one"]), {}), []);
  assert.match(
    checkContract(new Set(["one"]), new Set(["old"]), {}).join(" "),
    /old/,
  );
  assert.match(checkContract(new Set(["one"]), new Set(), {}).join(" "), /one/);
  assert.deepEqual(
    checkContract(new Set(["one"]), new Set(), { one: "Native dialog" }),
    [],
  );
  assert.match(
    checkContract(new Set(["one"]), new Set(["one"]), {
      one: "Native dialog",
    }).join(" "),
    /exception/,
  );
  assert.match(
    checkContract(new Set(), new Set(), { old: "Removed" }).join(" "),
    /exception/,
  );
});
