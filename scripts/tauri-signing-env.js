import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { filesRecursively } from "./_utils.js";

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
