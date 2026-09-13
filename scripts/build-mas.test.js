import test from "node:test";
import assert from "node:assert";
import { altoolUploadArgs, buildMasTauriArgs } from "./build-mas-args.js";

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

test("altool upload uses @env for the app-specific password", () => {
  assert.deepStrictEqual(
    altoolUploadArgs({
      action: "--validate-app",
      outputPath: "app.pkg",
      appleId: "person@example.com",
    }),
    [
      "altool",
      "--validate-app",
      "--type",
      "macos",
      "--file",
      "app.pkg",
      "--username",
      "person@example.com",
      "--password",
      "@env:APPLE_PASSWORD",
    ],
  );
  assert.deepStrictEqual(
    altoolUploadArgs({
      action: "--upload-app",
      outputPath: "app.pkg",
      apiKey: "KEYID",
      apiIssuer: "ISSUER",
    }),
    [
      "altool",
      "--upload-app",
      "--type",
      "macos",
      "--file",
      "app.pkg",
      "--apiKey",
      "KEYID",
      "--apiIssuer",
      "ISSUER",
    ],
  );
  const accountArgs = altoolUploadArgs({
    action: "--upload-app",
    outputPath: "app.pkg",
    appleId: "person@example.com",
  });
  assert.equal(
    accountArgs[accountArgs.indexOf("--password") + 1],
    "@env:APPLE_PASSWORD",
  );
  assert.throws(
    () => altoolUploadArgs({ action: "--upload-app", outputPath: "app.pkg" }),
    /APPLE_API_KEY\/APPLE_API_ISSUER or APPLE_ID\/APPLE_PASSWORD/,
  );
});
