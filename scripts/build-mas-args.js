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
