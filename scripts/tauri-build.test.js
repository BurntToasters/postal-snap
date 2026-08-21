import test from "node:test";
import assert from "node:assert";

function buildTauriArgs(input, target, bundles, noBundle, overridePath) {
  const delimiterIndex = input.indexOf("--");
  const tauriArgs =
    delimiterIndex < 0 ? [...input] : input.slice(0, delimiterIndex);
  const cargoArgs = delimiterIndex < 0 ? [] : input.slice(delimiterIndex + 1);

  const normalizedCargoArgs = cargoArgs.filter((arg) => arg !== "--locked");

  const args = ["run", "tauri", "--", "build", "--config", overridePath];
  if (target) args.push("--target", target);
  if (bundles) args.push("--bundles", bundles);
  if (noBundle) args.push("--no-bundle");

  args.push(...tauriArgs);
  args.push("--", "--locked", ...normalizedCargoArgs);

  return args;
}

test("Case 1: no caller Cargo args (Windows build)", () => {
  const input = [];
  const args = buildTauriArgs(
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
  const args = buildTauriArgs(input, undefined, undefined, false, "dummy.json");
  const tailIndex = args.lastIndexOf("--");
  assert.deepStrictEqual(args.slice(tailIndex), [
    "--",
    "--locked",
    "--no-default-features",
  ]);
});

test("Case 3: caller already has locked", () => {
  const input = ["--", "--locked", "--no-default-features"];
  const args = buildTauriArgs(input, undefined, undefined, false, "dummy.json");
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
  const args = buildTauriArgs(input, undefined, undefined, false, "dummy.json");
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
  const args = buildTauriArgs(input, "x86_64", "nsis", false, "dummy.json");
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
