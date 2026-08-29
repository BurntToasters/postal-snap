import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureReleaseDir,
  json,
  newestMatching,
  process,
  requireEnv,
  root,
  run,
  output,
} from "./_utils.js";
import { buildMasTauriArgs } from "./build-mas-args.js";
import { validateEntitlementsPlist } from "./validate-macos-entitlements.js";

requireEnv([
  "APPLE_SIGNING_IDENTITY",
  "APPLE_INSTALLER_IDENTITY",
  "APPLE_TEAM_ID",
  "MAS_PROVISIONING_PROFILE",
]);
const pkg = await json(join(root, "package.json"));
const buildNumber = process.env.MAS_BUILD_NUMBER ?? "1";
if (!/^\d+$/.test(buildNumber)) {
  throw new Error("MAS_BUILD_NUMBER must contain only digits.");
}
const temporary = await mkdtemp(join(tmpdir(), "postal-snap-mas-"));
try {
  const storeConfig = await json(join(root, "src-tauri/tauri.mas.conf.json"));
  storeConfig.version = pkg.version.replace(/-.+$/, "");
  storeConfig.bundle.macOS.bundleVersion = buildNumber;
  const entitlements = (
    await readFile(join(root, "src-tauri/entitlements.mas.plist"), "utf8")
  )
    .replaceAll("$(AppIdentifierPrefix)", `${process.env.APPLE_TEAM_ID}.`)
    .replaceAll("$(TeamIdentifierPrefix)", process.env.APPLE_TEAM_ID);
  const entitlementsPath = join(temporary, "entitlements.plist");
  await writeFile(entitlementsPath, entitlements);
  await validateEntitlementsPlist(entitlementsPath);
  storeConfig.bundle.macOS.entitlements = entitlementsPath;
  storeConfig.bundle.macOS.signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
  const provisioningProfile = isAbsolute(process.env.MAS_PROVISIONING_PROFILE)
    ? process.env.MAS_PROVISIONING_PROFILE
    : resolve(root, process.env.MAS_PROVISIONING_PROFILE);
  storeConfig.bundle.macOS.files = {
    "embedded.provisionprofile": provisioningProfile,
  };
  const storeConfigPath = join(temporary, "tauri.mas.conf.json");
  await writeFile(storeConfigPath, `${JSON.stringify(storeConfig, null, 2)}\n`);

  const bundleOutputDir = join(
    root,
    "src-tauri/target/universal-apple-darwin/release/bundle",
  );
  await rm(bundleOutputDir, { recursive: true, force: true });
  await run("npm", buildMasTauriArgs({ storeConfigPath }));
  const info = await newestMatching(join(bundleOutputDir, "macos"), (path) =>
    path.endsWith("Postal Snap.app/Contents/Info.plist"),
  );
  if (!info) throw new Error("Mac App Store app bundle was not produced.");
  const app = info.slice(0, -"/Contents/Info.plist".length);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const signedEntitlements = await output("codesign", [
    "--display",
    "--entitlements",
    ":-",
    app,
  ]);
  if (!signedEntitlements.includes("com.apple.security.app-sandbox"))
    throw new Error("Mac App Store bundle is missing App Sandbox entitlement.");
  const release = await ensureReleaseDir();
  const outputPath = join(
    release,
    `PostalSnap-${pkg.version}-Mac-App-Store.pkg`,
  );
  await rm(outputPath, { force: true });
  await run("productbuild", [
    "--component",
    app,
    "/Applications",
    "--sign",
    process.env.APPLE_INSTALLER_IDENTITY,
    outputPath,
  ]);
  await run("pkgutil", ["--check-signature", outputPath]);
  if (process.argv.includes("--upload")) {
    const apiAuth = process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER;
    const accountAuth = process.env.APPLE_ID && process.env.APPLE_PASSWORD;
    if (!apiAuth && !accountAuth) {
      throw new Error(
        "Set APPLE_API_KEY/APPLE_API_ISSUER or APPLE_ID/APPLE_PASSWORD for App Store upload.",
      );
    }
    const auth = apiAuth
      ? [
          "--apiKey",
          process.env.APPLE_API_KEY,
          "--apiIssuer",
          process.env.APPLE_API_ISSUER,
        ]
      : [
          "--username",
          process.env.APPLE_ID,
          "--password",
          process.env.APPLE_PASSWORD,
        ];
    await run("xcrun", [
      "altool",
      "--validate-app",
      "--type",
      "macos",
      "--file",
      outputPath,
      ...auth,
    ]);
    await run("xcrun", [
      "altool",
      "--upload-app",
      "--type",
      "macos",
      "--file",
      outputPath,
      ...auth,
    ]);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
