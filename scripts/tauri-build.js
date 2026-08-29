import { copyFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTauriBuildArgs } from "./tauri-build-args.js";
import {
  ensureReleaseDir,
  json,
  newestMatching,
  output,
  process,
  requireEnv,
  rmRetry,
  root,
  run,
  writeJson,
} from "./_utils.js";
import { resolveUpdaterPublicKey } from "./updater-pubkey.js";
import {
  applyApplePasswordCompatibility,
  artifactSigningPowershellArgs,
  assertAppleSigningIdentityAvailable,
  assertWindowsSigningConfigured,
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
    "[tauri-build] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.",
  );
}
if (requireMacosSigning) requireEnv(["APPLE_SIGNING_IDENTITY"]);
if (requireMacosNotarization) {
  const apiCredentials =
    process.env.APPLE_API_KEY &&
    process.env.APPLE_API_ISSUER &&
    process.env.APPLE_API_KEY_PATH;
  const appleIdCredentials =
    process.env.APPLE_ID &&
    process.env.APPLE_PASSWORD &&
    process.env.APPLE_TEAM_ID;
  if (!apiCredentials && !appleIdCredentials) {
    throw new Error(
      "Set APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID for notarization.",
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
    for (const artifact of artifacts) {
      console.log(
        `[tauri-build] Finalizing Authenticode signature: ${artifact}`,
      );
      await run(
        "powershell.exe",
        artifactSigningPowershellArgs(signScript, ["-FilePath", artifact]),
      );
    }
    await run(
      "powershell.exe",
      artifactSigningPowershellArgs(
        join(root, "scripts/verify-windows-authenticode.ps1"),
        ["-TargetReleaseDir", targetReleaseDir],
      ),
    );
  }
  const candidates = [
    {
      test: (path) => path.endsWith("-setup.exe"),
      name: `Postal-Snap-Windows-${arch}.exe`,
    },
    { test: (path) => path.endsWith(".dmg"), name: "Postal-Snap-macOS.dmg" },
    {
      test: (path) => path.endsWith(".AppImage"),
      name: `Postal-Snap-Linux-${arch}.AppImage`,
    },
    {
      test: (path) => path.endsWith(".nsis.zip"),
      name: `Postal-Snap-Windows-${arch}.nsis.zip`,
    },
    {
      test: (path) => path.endsWith(".nsis.zip.sig"),
      name: `Postal-Snap-Windows-${arch}.nsis.zip.sig`,
    },
    {
      test: (path) => path.endsWith(".app.tar.gz"),
      name: "Postal-Snap-macOS.app.tar.gz",
    },
    {
      test: (path) => path.endsWith(".app.tar.gz.sig"),
      name: "Postal-Snap-macOS.app.tar.gz.sig",
    },
    {
      test: (path) => path.endsWith(".AppImage.tar.gz"),
      name: `Postal-Snap-Linux-${arch}.AppImage.tar.gz`,
    },
    {
      test: (path) => path.endsWith(".AppImage.tar.gz.sig"),
      name: `Postal-Snap-Linux-${arch}.AppImage.tar.gz.sig`,
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
    await run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    if (requireMacosNotarization) {
      const dmg = join(release, "Postal-Snap-macOS.dmg");
      await run("xcrun", ["stapler", "validate", dmg]);
    }
  }
  console.log(`Collected ${pkg.name} ${pkg.version} artifacts in release/`);
}
