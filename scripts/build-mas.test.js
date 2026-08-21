import test from "node:test";
import assert from "node:assert";
import { buildMasTauriArgs } from "./build-mas-args.js";

test("MAS build argument verification", () => {
  const args = buildMasTauriArgs({ storeConfigPath: "temp.json" });

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
