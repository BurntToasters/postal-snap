import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AZURE_ARTIFACT_SIGNING_ENV_VARS,
  artifactSigningPowershellArgs,
  assertWindowsSigningConfigured,
  missingAzureArtifactSigningVars,
  skipWindowsCodeSigning,
  windowsArtifactsToSign,
} from "./tauri-signing-env.js";

const azureEnv = Object.fromEntries(
  AZURE_ARTIFACT_SIGNING_ENV_VARS.map((name) => [name, "value"]),
);

test("Azure Artifact Signing env list matches IYERIS/Zinnia required vars", () => {
  assert.deepEqual(AZURE_ARTIFACT_SIGNING_ENV_VARS, [
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_ARTIFACT_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_PROFILE",
    "AZURE_ARTIFACT_SIGNING_PUBLISHER",
  ]);
});

test("SKIP_WIN_CODESIGN=1 is the only unsigned Windows escape hatch", () => {
  assert.equal(skipWindowsCodeSigning({}), false);
  assert.equal(skipWindowsCodeSigning({ SKIP_WIN_CODESIGN: "0" }), false);
  assert.equal(skipWindowsCodeSigning({ SKIP_WIN_CODESIGN: "1" }), true);
});

test("assertWindowsSigningConfigured requires Azure vars, not a thumbprint", () => {
  assert.deepEqual(
    assertWindowsSigningConfigured({ requireWindowsSigning: false }),
    { skipSigning: true },
  );
  assert.throws(
    () =>
      assertWindowsSigningConfigured({
        requireWindowsSigning: true,
        target: "x86_64-unknown-linux-gnu",
        platform: "linux",
        env: azureEnv,
      }),
    /Windows build target/,
  );
  assert.throws(
    () =>
      assertWindowsSigningConfigured({
        requireWindowsSigning: true,
        target: "x86_64-pc-windows-msvc",
        noBundle: true,
        platform: "win32",
        env: azureEnv,
      }),
    /--no-bundle/,
  );
  assert.throws(
    () =>
      assertWindowsSigningConfigured({
        requireWindowsSigning: true,
        target: "x86_64-pc-windows-msvc",
        platform: "linux",
        env: azureEnv,
      }),
    /must run on Windows/,
  );
  assert.deepEqual(
    assertWindowsSigningConfigured({
      requireWindowsSigning: true,
      target: "x86_64-pc-windows-msvc",
      platform: "win32",
      env: { SKIP_WIN_CODESIGN: "1" },
    }),
    { skipSigning: true },
  );
  assert.throws(
    () =>
      assertWindowsSigningConfigured({
        requireWindowsSigning: true,
        target: "x86_64-pc-windows-msvc",
        platform: "win32",
        env: {},
      }),
    /AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET, AZURE_ARTIFACT_SIGNING_ENDPOINT, AZURE_ARTIFACT_SIGNING_ACCOUNT, AZURE_ARTIFACT_SIGNING_PROFILE, AZURE_ARTIFACT_SIGNING_PUBLISHER/,
  );
  assert.doesNotMatch(
    missingAzureArtifactSigningVars({}).join(","),
    /WINDOWS_CERTIFICATE/,
  );
  assert.deepEqual(
    assertWindowsSigningConfigured({
      requireWindowsSigning: true,
      target: "aarch64-pc-windows-msvc",
      platform: "win32",
      env: azureEnv,
    }),
    { skipSigning: false },
  );
});

test("windowsArtifactsToSign collects runtime and NSIS exe, not updater zip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "postal-snap-sign-"));
  try {
    await writeFile(join(dir, "Postal Snap.exe"), "runtime");
    await writeFile(join(dir, "readme.txt"), "skip");
    await mkdir(join(dir, "bundle", "nsis"), { recursive: true });
    await writeFile(
      join(dir, "bundle", "nsis", "Postal Snap_0.1.0_x64-setup.exe"),
      "setup",
    );
    await writeFile(
      join(dir, "bundle", "nsis", "Postal Snap_0.1.0_x64-setup.nsis.zip"),
      "zip",
    );
    const files = await windowsArtifactsToSign(dir);
    assert.equal(files.length, 2);
    assert.ok(files.some((path) => path.endsWith("Postal Snap.exe")));
    assert.ok(files.some((path) => path.endsWith("-setup.exe")));
    assert.ok(!files.some((path) => path.endsWith(".zip")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifactSigningPowershellArgs match Zinnia SignTool invocation flags", () => {
  assert.deepEqual(
    artifactSigningPowershellArgs("scripts/windows-artifact-sign.ps1", [
      "-FilePath",
      "app.exe",
    ]),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/windows-artifact-sign.ps1",
      "-FilePath",
      "app.exe",
    ],
  );
});
