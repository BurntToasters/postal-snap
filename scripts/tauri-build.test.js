import test from "node:test";
import assert from "node:assert";
import { buildTauriBuildArgs as buildTauriArgs } from "./tauri-build-args.js";

function buildTauriArgsWrapper(input, target, bundles, noBundle, overridePath) {
  return buildTauriArgs({
    input,
    target,
    bundles,
    noBundle,
    overridePath,
  });
}

test("Case 1: no caller Cargo args (Windows build)", () => {
  const input = [];
  const args = buildTauriArgsWrapper(
    input,
    "x86_64-pc-windows-msvc",
    "nsis",
    false,
    "dummy.json",
  );
  assert.deepStrictEqual(args.slice(-2), ["--", "--locked"]);
});

test("Case 2: caller Cargo arg (MS Store)", () => {
  const input = ["--features", "msstore", "--", "--no-default-features"];
  const args = buildTauriArgsWrapper(
    input,
    undefined,
    undefined,
    false,
    "dummy.json",
  );
  const tailIndex = args.lastIndexOf("--");
  assert.deepStrictEqual(args.slice(tailIndex), [
    "--",
    "--locked",
    "--no-default-features",
  ]);
});

test("Case 3: caller already has locked", () => {
  const input = ["--", "--locked", "--no-default-features"];
  const args = buildTauriArgsWrapper(
    input,
    undefined,
    undefined,
    false,
    "dummy.json",
  );
  const tailIndex = args.lastIndexOf("--");
  assert.deepStrictEqual(args.slice(tailIndex), [
    "--",
    "--locked",
    "--no-default-features",
  ]);
  const lockedCount = args.filter((a) => a === "--locked").length;
  assert.strictEqual(lockedCount, 1);
});

test("Case 4: multiple Cargo args", () => {
  const input = ["--", "--no-default-features", "--features", "foo"];
  const args = buildTauriArgsWrapper(
    input,
    undefined,
    undefined,
    false,
    "dummy.json",
  );
  const tailIndex = args.lastIndexOf("--");
  assert.deepStrictEqual(args.slice(tailIndex), [
    "--",
    "--locked",
    "--no-default-features",
    "--features",
    "foo",
  ]);
});

test("Case 5: no accidental Tauri/Cargo crossover", () => {
  const input = ["--features", "msstore", "--", "--no-default-features"];
  const args = buildTauriArgsWrapper(
    input,
    "x86_64",
    "nsis",
    false,
    "dummy.json",
  );
  const tailIndex = args.lastIndexOf("--");
  const tauriSide = args.slice(0, tailIndex);
  const cargoSide = args.slice(tailIndex);
  assert.ok(tauriSide.includes("--target"));
  assert.ok(tauriSide.includes("x86_64"));
  assert.ok(tauriSide.includes("--bundles"));
  assert.ok(tauriSide.includes("nsis"));
  assert.ok(tauriSide.includes("--features"));
  assert.ok(tauriSide.includes("msstore"));
  assert.deepStrictEqual(cargoSide, [
    "--",
    "--locked",
    "--no-default-features",
  ]);
});
