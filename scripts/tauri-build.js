import { copyFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTauriBuildArgs } from "./tauri-build-args.js";
import {
  isLinuxAppImage,
  isLinuxAppImageSignature,
  newestMatching,
} from "./lib/artifacts.js";
import { ensureReleaseDir, json, requireEnv, writeJson } from "./lib/json.js";
import { existsSync, process, root } from "./lib/paths.js";
import { output, rmRetry, run } from "./lib/spawn.js";
import { resolveUpdaterPublicKey } from "./updater-pubkey.js";
import {
  AZURE_ARTIFACT_SIGNING_ENV_VARS,
  applyApplePasswordCompatibility,
  artifactSigningPowershellArgs,
  assertAppleSigningIdentityAvailable,
  assertWindowsSigningConfigured,
  envForChild,
  inspectCodesignDisplay,
  macosBundleExecutablePath,
  missingAzureArtifactSigningVars,
  notarytoolSubmitArgs,
  resolveNotarytoolKeychainProfile,
  skipWindowsCodeSigning,
  windowsArtifactsToSign,
} from "./tauri-signing-env.js";
import { validateEntitlementsPlist } from "./validate-macos-entitlements.js";

const input = process.argv.slice(2);
const take = (flag) => {
  const index = input.indexOf(flag);
  if (index < 0) return undefined;
  const value = input[index + 1];
  input.splice(index, 2);
  return value;
};
const has = (flag) => {
  const index = input.indexOf(flag);
  if (index < 0) return false;
  input.splice(index, 1);
  return true;
};
const target = take("--target");
const bundles = take("--bundles");
const additionalConfig = take("--config");
const noBundle = has("--no-bundle");
const requireTauriSigning = has("--require-tauri-signing");
const requireWindowsSigning = has("--require-windows-signing");
const requireMacosSigning = has("--require-macos-signing");
const requireMacosNotarization = has("--require-macos-notarization");
const storeBuild =
  additionalConfig?.includes("tauri.mas.conf") ||
  additionalConfig?.includes("tauri.msstore.conf") ||
  additionalConfig?.includes("tauri.flatpak.conf") ||
  input.some(
    (value, index) =>
      (input[index - 1] === "--features" &&
        value
          .split(",")
          .some((feature) =>
            ["flatpak", "mas", "msstore"].includes(feature.trim()),
          )) ||
      /^--features=(?:.*,)?(?:flatpak|mas|msstore)(?:,.*)?$/.test(value),
  );
const macosBuild =
  requireMacosSigning ||
  /apple-darwin/i.test(target ?? "") ||
  (process.platform === "darwin" && !target);
const targetReleaseDir = target
  ? join(root, "src-tauri/target", target, "release")
  : join(root, "src-tauri/target/release");
const bundleOutputDir = join(targetReleaseDir, "bundle");

if (macosBuild && !storeBuild) {
  await validateEntitlementsPlist(join(root, "src-tauri/entitlements.plist"));
}
applyApplePasswordCompatibility(process.env);
const windowsTarget = target
  ? /windows/i.test(target)
  : process.platform === "win32";
if (
  !storeBuild &&
  !noBundle &&
  windowsTarget &&
  String(process.env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim() &&
  !skipWindowsCodeSigning(process.env)
) {
  const missing = missingAzureArtifactSigningVars(process.env);
  if (missing.length) {
    throw new Error(
      `TAURI_SIGNING_PRIVATE_KEY is set, so Windows production builds must also carry Authenticode signatures. Missing Azure Artifact Signing env vars: ${missing.join(", ")}. Set SKIP_WIN_CODESIGN=1 only for deliberate unsigned artifacts.`,
    );
  }
}
if (requireTauriSigning)
  requireEnv([
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]);
const windowsSigning = assertWindowsSigningConfigured({
  requireWindowsSigning,
  target,
  noBundle,
  platform: process.platform,
  env: process.env,
});
if (requireWindowsSigning && windowsSigning.skipSigning) {
  console.warn(
    "[tauri-build] ALLOW_UNSIGNED_WINDOWS=1 with SKIP_WIN_CODESIGN=1; producing deliberately unsigned Windows artifacts.",
  );
}
if (requireWindowsSigning && !windowsSigning.skipSigning) {
  process.env.POSTAL_SNAP_REQUIRE_WIN_CODESIGN = "1";
}
if (requireMacosSigning) requireEnv(["APPLE_SIGNING_IDENTITY"]);
if (requireMacosNotarization) {
  const keychainProfile = resolveNotarytoolKeychainProfile(process.env);
  const apiCredentials =
    process.env.APPLE_API_KEY &&
    process.env.APPLE_API_ISSUER &&
    process.env.APPLE_API_KEY_PATH;
  const appleIdCredentials =
    process.env.APPLE_ID &&
    process.env.APPLE_PASSWORD &&
    process.env.APPLE_TEAM_ID;
  if (!keychainProfile && !apiCredentials && !appleIdCredentials) {
    throw new Error(
      "Set NOTARYTOOL_KEYCHAIN_PROFILE, APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH, or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID for notarization.",
    );
  }
}
if (requireMacosSigning && process.platform === "darwin") {
  const identities = await output("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  assertAppleSigningIdentityAvailable(
    process.env.APPLE_SIGNING_IDENTITY,
    identities,
  );
}

if (!noBundle) {
  await rmRetry(bundleOutputDir, { recursive: true });
  console.log(`[tauri-build] Cleared stale bundle output: ${bundleOutputDir}`);
}

const overrideDir = await mkdtemp(join(tmpdir(), "postal-snap-config-"));
try {
  const packageInfo = await json(join(root, "package.json"));
  const manifestName = packageInfo.version.includes("-")
    ? "latest-{{target}}-beta-{{arch}}.json"
    : "latest-{{target}}-{{arch}}.json";
  const committedConfig = await json(join(root, "src-tauri/tauri.conf.json"));
  const updaterOverride = storeBuild
    ? { plugins: { updater: null } }
    : {
        plugins: {
          updater: {
            pubkey: resolveUpdaterPublicKey({
              committed: committedConfig.plugins?.updater?.pubkey,
              fromEnv: process.env.TAURI_UPDATER_PUBLIC_KEY,
              requireSigning: requireTauriSigning,
            }),
            endpoints: [
              `https://github.com/BurntToasters/postal-snap/releases/latest/download/${manifestName}`,
            ],
          },
        },
      };
  const override = additionalConfig
    ? merge(await json(join(root, additionalConfig)), updaterOverride)
    : updaterOverride;
  const overridePath = join(overrideDir, "build.json");
  await writeJson(overridePath, override);

  const args = buildTauriBuildArgs({
    input,
    target,
    bundles,
    noBundle,
    overridePath,
  });

  const bundleList = String(bundles ?? "")
    .split(",")
    .map((value) => value.trim());
  const appImageBuild =
    bundleList.includes("appimage") &&
    (target ? /linux/i.test(target) : process.platform === "linux");
  if (appImageBuild) {
    // linuxdeploy's bundled strip cannot handle .relr.dyn on glibc >= 2.36.
    process.env.NO_STRIP = "true";
  }

  await run("npm", args);
} finally {
  try {
    await rmRetry(overrideDir, { recursive: true });
  } catch {
    console.warn("[tauri-build] Could not remove temporary config directory.");
  }
}

function merge(base, override) {
  if (
    !base ||
    !override ||
    Array.isArray(base) ||
    Array.isArray(override) ||
    typeof base !== "object" ||
    typeof override !== "object"
  ) {
    return override;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? merge(result[key], value) : value;
  }
  return result;
}

if (!noBundle) {
  const pkg = await json(join(root, "package.json"));
  const release = await ensureReleaseDir();
  const arch = /aarch64|arm64/.test(target ?? "") ? "arm64" : "x64";
  if (requireWindowsSigning && !windowsSigning.skipSigning) {
    const artifacts = await windowsArtifactsToSign(targetReleaseDir);
    if (!artifacts.length) {
      throw new Error(
        `No Windows runtime or installer executables found under ${targetReleaseDir}`,
      );
    }
    const signScript = join(root, "scripts/windows-artifact-sign.ps1");
    const signerEnv = envForChild(process.env, AZURE_ARTIFACT_SIGNING_ENV_VARS);
    for (const artifact of artifacts) {
      console.log(
        `[tauri-build] Finalizing Authenticode signature: ${artifact}`,
      );
      await run(
        "powershell.exe",
        artifactSigningPowershellArgs(signScript, ["-FilePath", artifact]),
        { env: signerEnv },
      );
    }
    await resignWindowsUpdaterSignatures(bundleOutputDir);
    await run(
      "powershell.exe",
      artifactSigningPowershellArgs(
        join(root, "scripts/verify-windows-authenticode.ps1"),
        ["-TargetReleaseDir", targetReleaseDir],
      ),
      { env: signerEnv },
    );
  }
  const candidates = [
    {
      test: (path) => path.endsWith("-setup.exe"),
      name: `Postal-Snap-Windows-${arch}.exe`,
    },
    {
      test: (path) => path.endsWith("-setup.exe.sig"),
      name: `Postal-Snap-Windows-${arch}.exe.sig`,
    },
    { test: (path) => path.endsWith(".dmg"), name: "Postal-Snap-macOS.dmg" },
    {
      test: isLinuxAppImage,
      name: `Postal-Snap-Linux-${arch}.AppImage`,
    },
    {
      test: isLinuxAppImageSignature,
      name: `Postal-Snap-Linux-${arch}.AppImage.sig`,
    },
    {
      test: (path) => path.endsWith(".app.tar.gz"),
      name: "Postal-Snap-macOS.app.tar.gz",
    },
    {
      test: (path) => path.endsWith(".app.tar.gz.sig"),
      name: "Postal-Snap-macOS.app.tar.gz.sig",
    },
  ];
  const collected = new Set();
  for (const candidate of candidates) {
    const source = await newestMatching(bundleOutputDir, candidate.test);
    if (source) {
      await copyFile(source, join(release, candidate.name));
      collected.add(candidate.name);
    }
  }
  if (requireMacosSigning) {
    const required = [
      "Postal-Snap-macOS.dmg",
      "Postal-Snap-macOS.app.tar.gz",
      "Postal-Snap-macOS.app.tar.gz.sig",
    ];
    const missing = required.filter((name) => !collected.has(name));
    if (missing.length) {
      throw new Error(
        `Signed macOS build did not produce required artifacts: ${missing.join(", ")}`,
      );
    }
  }
  if (requireTauriSigning && process.platform === "win32") {
    const required = [
      `Postal-Snap-Windows-${arch}.exe`,
      `Postal-Snap-Windows-${arch}.exe.sig`,
    ];
    const missing = required.filter((name) => !collected.has(name));
    if (missing.length) {
      throw new Error(
        `Signed Windows build did not produce required updater artifacts: ${missing.join(", ")}`,
      );
    }
  }
  if (requireTauriSigning && process.platform === "linux") {
    const required = [
      `Postal-Snap-Linux-${arch}.AppImage`,
      `Postal-Snap-Linux-${arch}.AppImage.sig`,
    ];
    const missing = required.filter((name) => !collected.has(name));
    if (missing.length) {
      throw new Error(
        `Signed Linux build did not produce required updater artifacts: ${missing.join(", ")}`,
      );
    }
  }
  if (requireMacosSigning && process.platform === "darwin") {
    const info = await newestMatching(bundleOutputDir, (path) =>
      path.endsWith("Postal Snap.app/Contents/Info.plist"),
    );
    if (!info) throw new Error("Signed Postal Snap.app was not produced.");
    const app = info.slice(0, -"/Contents/Info.plist".length);
    await run("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      app,
    ]);
    const display = await output(
      "codesign",
      ["--display", "--verbose=4", app],
      { includeStderr: true },
    );
    inspectCodesignDisplay(display);
    const executableName = await output("/usr/libexec/PlistBuddy", [
      "-c",
      "Print:CFBundleExecutable",
      join(app, "Contents/Info.plist"),
    ]);
    const binary = macosBundleExecutablePath(app, executableName);
    if (!existsSync(binary)) {
      throw new Error(
        `Postal Snap.app is missing Mach-O executable "${executableName}".`,
      );
    }
    const archs = await output("lipo", ["-archs", binary]);
    if (!/\bx86_64\b/.test(archs) || !/\barm64\b/.test(archs)) {
      throw new Error(
        `Postal Snap.app is not a universal binary: ${archs.trim()}`,
      );
    }
    if (requireMacosNotarization) {
      await run("xcrun", ["stapler", "validate", app]);
      const dmg = join(release, "Postal-Snap-macOS.dmg");
      await notarizeAppleArtifact(dmg);
      await run("xcrun", ["stapler", "staple", dmg]);
      await run("xcrun", ["stapler", "validate", dmg]);
      await run("spctl", ["--assess", "--type", "install", "--verbose=2", dmg]);
    }
    await run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    await run("hdiutil", ["verify", join(release, "Postal-Snap-macOS.dmg")]);
  }
  console.log(`Collected ${pkg.name} ${pkg.version} artifacts in release/`);
}

async function resignWindowsUpdaterSignatures(bundleDir) {
  const setup = await newestMatching(bundleDir, (path) =>
    path.endsWith("-setup.exe"),
  );
  if (!setup) return;
  console.log(
    `[tauri-build] Replacing updater signature after Authenticode: ${setup}`,
  );
  await run("npm", ["run", "tauri", "--", "signer", "sign", setup], {
    env: envForChild(process.env, [
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ]),
  });
}

async function notarizeAppleArtifact(path) {
  const keychainProfile = resolveNotarytoolKeychainProfile(process.env);
  const hasApiKey = Boolean(
    process.env.APPLE_API_KEY &&
    process.env.APPLE_API_ISSUER &&
    process.env.APPLE_API_KEY_PATH,
  );
  const hasAppleId = Boolean(
    process.env.APPLE_ID &&
    process.env.APPLE_PASSWORD &&
    process.env.APPLE_TEAM_ID,
  );
  if (!keychainProfile && !hasApiKey && !hasAppleId) {
    throw new Error(
      "DMG notarization requires NOTARYTOOL_KEYCHAIN_PROFILE, an App Store Connect API key, or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID.",
    );
  }
  const args = notarytoolSubmitArgs({
    path,
    keychainProfile,
    apiKeyPath: process.env.APPLE_API_KEY_PATH,
    apiKeyId: process.env.APPLE_API_KEY,
    apiIssuer: process.env.APPLE_API_ISSUER,
    appleId: process.env.APPLE_ID,
    applePassword: process.env.APPLE_PASSWORD,
    appleTeamId: process.env.APPLE_TEAM_ID,
  });
  console.log(`[tauri-build] Submitting ${path} to notarytool`);
  await run("xcrun", args);
}
