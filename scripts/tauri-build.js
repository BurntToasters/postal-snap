import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureReleaseDir,
  json,
  newestMatching,
  process,
  requireEnv,
  root,
  run,
  writeJson,
} from "./_utils.js";

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
if (requireTauriSigning)
  requireEnv([
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_UPDATER_PUBLIC_KEY",
  ]);
if (requireWindowsSigning) requireEnv(["WINDOWS_CERTIFICATE_THUMBPRINT"]);
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

const overrideDir = await mkdtemp(join(tmpdir(), "postal-snap-config-"));
try {
  const packageInfo = await json(join(root, "package.json"));
  const manifestName = packageInfo.version.includes("-")
    ? "latest-{{target}}-beta-{{arch}}.json"
    : "latest-{{target}}-{{arch}}.json";
  const updaterOverride = storeBuild
    ? { plugins: { updater: null } }
    : {
        plugins: {
          updater: {
            pubkey:
              process.env.TAURI_UPDATER_PUBLIC_KEY ??
              "POSTAL_SNAP_UPDATER_PUBLIC_KEY",
            endpoints: [
              `https://github.com/BurntToasters/postal-snap/releases/latest/download/${manifestName}`,
            ],
          },
        },
      };
  if (requireWindowsSigning) {
    updaterOverride.bundle = {
      windows: {
        certificateThumbprint:
          process.env.WINDOWS_CERTIFICATE_THUMBPRINT.trim(),
        digestAlgorithm: "sha256",
        timestampUrl:
          process.env.WINDOWS_TIMESTAMP_URL?.trim() ||
          "http://timestamp.digicert.com",
      },
    };
  }
  const override = additionalConfig
    ? merge(await json(join(root, additionalConfig)), updaterOverride)
    : updaterOverride;
  const overridePath = join(overrideDir, "build.json");
  await writeJson(overridePath, override);

  // Split tauri args from cargo args using the first "--"
  const delimiterIndex = input.indexOf("--");
  const tauriArgs =
    delimiterIndex < 0 ? [...input] : input.slice(0, delimiterIndex);
  const cargoArgs = delimiterIndex < 0 ? [] : input.slice(delimiterIndex + 1);

  // Normalize cargo args to ensure exactly one "--locked" is present
  const normalizedCargoArgs = cargoArgs.filter((arg) => arg !== "--locked");

  const args = ["run", "tauri", "--", "build", "--config", overridePath];
  if (target) args.push("--target", target);
  if (bundles) args.push("--bundles", bundles);
  if (noBundle) args.push("--no-bundle");
  args.push(...tauriArgs);
  args.push("--", "--locked", ...normalizedCargoArgs);

  await run("npm", args);
} finally {
  await rm(overrideDir, { recursive: true, force: true });
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
  const actualTargetDir = target
    ? join(root, "src-tauri/target", target, "release", "bundle")
    : join(root, "src-tauri/target/release/bundle");
  const arch = /aarch64|arm64/.test(target ?? "") ? "arm64" : "x64";
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
  for (const candidate of candidates) {
    const source = await newestMatching(actualTargetDir, candidate.test);
    if (source) await copyFile(source, join(release, candidate.name));
  }
  if (requireWindowsSigning && process.platform === "win32") {
    const installer = join(release, `Postal-Snap-Windows-${arch}.exe`);
    const escaped = installer.replaceAll("'", "''");
    await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($signature.Status)" }`,
    ]);
  }
  if (requireMacosSigning && process.platform === "darwin") {
    const info = await newestMatching(actualTargetDir, (path) =>
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
