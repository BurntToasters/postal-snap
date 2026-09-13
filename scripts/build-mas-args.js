// altool documents "@env:<name>" for -p/--password, so the app-specific
// password never needs to appear in argv.
export function altoolUploadArgs({
  action,
  outputPath,
  apiKey,
  apiIssuer,
  appleId,
}) {
  if (!action || !outputPath) {
    throw new Error("altoolUploadArgs requires action and outputPath");
  }
  const args = ["altool", action, "--type", "macos", "--file", outputPath];
  if (apiKey && apiIssuer) {
    args.push("--apiKey", apiKey, "--apiIssuer", apiIssuer);
    return args;
  }
  if (appleId) {
    args.push("--username", appleId, "--password", "@env:APPLE_PASSWORD");
    return args;
  }
  throw new Error(
    "App Store upload requires APPLE_API_KEY/APPLE_API_ISSUER or APPLE_ID/APPLE_PASSWORD.",
  );
}

export function buildMasTauriArgs({ storeConfigPath }) {
  if (!storeConfigPath) {
    throw new Error("storeConfigPath is required");
  }

  return [
    "run",
    "tauri",
    "--",
    "build",
    "--target",
    "universal-apple-darwin",
    "--bundles",
    "app",
    "--features",
    "mas",
    "--config",
    storeConfigPath,
    "--",
    "--locked",
    "--no-default-features",
  ];
}
