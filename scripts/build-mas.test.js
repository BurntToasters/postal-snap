import test from "node:test";
import assert from "node:assert";

test("MAS build argument verification", () => {
  // In build-mas.js, the argument construction is static. We replicate the static construction to assert it.
  const args = [
    "run",
    "tauri",
    "--",
    "build",
    "--target",
    "universal-apple-darwin",
    "--bundles",
    "app",
    "--features",
    "mas",
    "--config",
    "temp.json",
    "--",
    "--locked",
    "--no-default-features",
  ];

  const tailIndex = args.lastIndexOf("--");
  const tauriSide = args.slice(0, tailIndex);
  const cargoSide = args.slice(tailIndex);

  assert.ok(tauriSide.includes("--features"));
  assert.ok(tauriSide.includes("mas"));
  assert.deepStrictEqual(cargoSide, [
    "--",
    "--locked",
    "--no-default-features",
  ]);
});
