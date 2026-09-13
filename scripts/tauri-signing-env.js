import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { filesRecursively } from "./lib/artifacts.js";

export const AZURE_ARTIFACT_SIGNING_ENV_VARS = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_PROFILE",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER",
];

export function skipWindowsCodeSigning(env = process.env) {
  return String(env.SKIP_WIN_CODESIGN ?? "").trim() === "1";
}

export function allowUnsignedWindows(env = process.env) {
  return String(env.ALLOW_UNSIGNED_WINDOWS ?? "").trim() === "1";
}

export function missingAzureArtifactSigningVars(env = process.env) {
  return AZURE_ARTIFACT_SIGNING_ENV_VARS.filter(
    (name) => !String(env[name] ?? "").trim(),
  );
}

export function assertWindowsSigningConfigured({
  requireWindowsSigning = false,
  target = "",
  noBundle = false,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!requireWindowsSigning) return { skipSigning: true };
  const windowsTarget = target ? /windows/i.test(target) : platform === "win32";
  if (!windowsTarget) {
    throw new Error(
      "--require-windows-signing requires a Windows build target.",
    );
  }
  if (noBundle) {
    throw new Error(
      "--require-windows-signing cannot be combined with --no-bundle.",
    );
  }
  if (platform !== "win32") {
    throw new Error("Authenticode release builds must run on Windows.");
  }
  if (skipWindowsCodeSigning(env)) {
    if (!allowUnsignedWindows(env)) {
      throw new Error(
        "SKIP_WIN_CODESIGN=1 is not allowed for signed Windows release builds. Unset SKIP_WIN_CODESIGN, or set ALLOW_UNSIGNED_WINDOWS=1 to explicitly produce unsigned Windows artifacts.",
      );
    }
    return { skipSigning: true };
  }
  const missing = missingAzureArtifactSigningVars(env);
  if (missing.length) {
    throw new Error(
      `Missing required Azure Artifact Signing env vars: ${missing.join(", ")}`,
    );
  }
  return { skipSigning: false };
}

function isWindowsSignedBinary(path) {
  const lower = path.toLowerCase();
  return lower.endsWith(".exe") || lower.endsWith(".msi");
}

export async function windowsArtifactsToSign(targetReleaseDir) {
  const files = [];
  for (const entry of await readdir(targetReleaseDir, {
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
      files.push(join(targetReleaseDir, entry.name));
    }
  }
  for (const path of await filesRecursively(join(targetReleaseDir, "bundle"))) {
    if (isWindowsSignedBinary(path)) files.push(path);
  }
  return [...new Set(files)].sort();
}

export function artifactSigningPowershellArgs(scriptPath, extra = []) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...extra,
  ];
}

export function applyApplePasswordCompatibility(env = process.env) {
  if (env.APPLE_PASSWORD?.trim()) return env;
  const legacy = env.APPLE_APP_SPECIFIC_PASSWORD?.trim();
  if (legacy) env.APPLE_PASSWORD = legacy;
  return env;
}

export const RELEASE_SECRET_ENV_VARS = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "AZURE_CLIENT_SECRET",
  "APPLE_PASSWORD",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_API_KEY",
  "GPG_PASSPHRASE",
  "SSH_USER_PWD",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_KEYCHAIN_PASSWORD",
];

// Children that sign or verify one artifact keep the ambient environment but
// drop release secrets they do not consume, so a compromised helper cannot
// read unrelated signing material.
export function envForChild(env = process.env, allowed = []) {
  const keep = new Set(allowed);
  const result = { ...env };
  for (const name of RELEASE_SECRET_ENV_VARS) {
    if (!keep.has(name)) delete result[name];
  }
  return result;
}

export const NOTARYTOOL_KEYCHAIN_PROFILE_ENV = "NOTARYTOOL_KEYCHAIN_PROFILE";

export function resolveNotarytoolKeychainProfile(env = process.env) {
  return String(env.NOTARYTOOL_KEYCHAIN_PROFILE ?? "").trim();
}

// Prefer the documented keychain profile or App Store Connect API key, then
// support Apple's Apple ID plus app-specific password authentication.
export function notarytoolSubmitArgs({
  path,
  keychainProfile,
  apiKeyPath,
  apiKeyId,
  apiIssuer,
  appleId,
  applePassword,
  appleTeamId,
} = {}) {
  if (!path) throw new Error("notarytool submit requires an artifact path.");
  const args = ["notarytool", "submit", path, "--wait"];
  const profile = String(keychainProfile ?? "").trim();
  if (profile) {
    args.push("--keychain-profile", profile);
    return args;
  }
  if (apiKeyPath && apiKeyId && apiIssuer) {
    args.push("--key", apiKeyPath, "--key-id", apiKeyId, "--issuer", apiIssuer);
    return args;
  }
  if (appleId && applePassword && appleTeamId) {
    args.push(
      "--apple-id",
      appleId,
      "--password",
      applePassword,
      "--team-id",
      appleTeamId,
    );
    return args;
  }
  throw new Error(
    "DMG notarization requires NOTARYTOOL_KEYCHAIN_PROFILE, an App Store Connect API key, or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID.",
  );
}

// Zinnia zip-macos.js: codesign --display --verbose=4 writes
// Authority/TeamIdentifier/flags to stderr. Callers must pass stdout+stderr.
export function inspectCodesignDisplay(details, label = "Postal Snap.app") {
  const text = String(details ?? "");
  if (/Signature=adhoc/i.test(text)) {
    throw new Error(
      `${label} is signed ad hoc, not with a Developer ID Application certificate.`,
    );
  }
  if (!/Authority=Developer ID Application:/i.test(text)) {
    throw new Error(
      `${label} is not signed with a Developer ID Application certificate.`,
    );
  }
  if (!/\bflags=.*runtime/.test(text)) {
    throw new Error(`${label} is missing the Hardened Runtime flag.`);
  }
  const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error(`${label} signature has no TeamIdentifier.`);
  }
  return { teamIdentifier };
}

export function macosBundleExecutablePath(appPath, executableName) {
  const name = String(executableName ?? "").trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error("CFBundleExecutable is missing or invalid.");
  }
  return join(appPath, "Contents", "MacOS", name);
}

export function assertAppleSigningIdentityAvailable(
  identity,
  identitiesOutput,
) {
  const wanted = String(identity ?? "").trim();
  if (!wanted) {
    throw new Error("APPLE_SIGNING_IDENTITY is missing.");
  }
  const listing = String(identitiesOutput ?? "");
  if (/0 valid identities found/i.test(listing)) {
    throw new Error(
      "No valid code-signing identities found in keychain. If this is an SSH session, run `npm run mac:ssh:keychain` first.",
    );
  }
  if (!listing.includes(wanted)) {
    throw new Error(
      `APPLE_SIGNING_IDENTITY "${wanted}" was not found in keychain identities.`,
    );
  }
}
