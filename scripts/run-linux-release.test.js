import test from "node:test";
import assert from "node:assert/strict";
import { selectLinuxReleaseScript } from "./run-linux-release.js";

test("Linux release entry point selects the signing host architecture", () => {
  assert.equal(
    selectLinuxReleaseScript({ platform: "linux", arch: "x64" }),
    "release:linux:x64",
  );
  assert.equal(
    selectLinuxReleaseScript({ platform: "linux", arch: "arm64" }),
    "release:linux:arm64",
  );
  assert.equal(
    selectLinuxReleaseScript({
      platform: "linux",
      arch: "arm64",
      resume: true,
    }),
    "release:linux:arm64:resume",
  );
});

test("Linux release entry point rejects the wrong host", () => {
  assert.throws(
    () => selectLinuxReleaseScript({ platform: "darwin", arch: "arm64" }),
    /Linux signing host/,
  );
  assert.throws(
    () => selectLinuxReleaseScript({ platform: "linux", arch: "riscv64" }),
    /Unsupported Linux release architecture/,
  );
});
