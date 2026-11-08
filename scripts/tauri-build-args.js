export function buildTauriBuildArgs({
  input = [],
  target,
  bundles,
  noBundle = false,
  overridePath,
}) {
  if (!overridePath) {
    throw new Error("overridePath is required");
  }

  const delimiterIndex = input.indexOf("--");

  const tauriArgs =
    delimiterIndex < 0 ? [...input] : input.slice(0, delimiterIndex);

  const cargoArgs = delimiterIndex < 0 ? [] : input.slice(delimiterIndex + 1);

  const normalizedCargoArgs = cargoArgs.filter((arg) => arg !== "--locked");

  const args = ["run", "tauri", "--", "build", "--config", overridePath];

  if (target) {
    args.push("--target", target);
  }

  if (bundles) {
    args.push("--bundles", bundles);
  }

  if (noBundle) {
    args.push("--no-bundle");
  }

  args.push(...tauriArgs);

  args.push("--", "--locked", ...normalizedCargoArgs);

  return args;
}

export function isMacosBuild({ requireMacosSigning, target, platform }) {
  return Boolean(
    requireMacosSigning ||
    /apple-darwin/i.test(target ?? "") ||
    (platform === "darwin" && !target),
  );
}

export function isStoreBuild({ additionalConfig, input = [] }) {
  return Boolean(
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
    ),
  );
}

// Adds Cargo features to the Tauri side of the argument list (before "--").
export function withBuildFeatures(input, features) {
  const result = [...input];
  const delimiter = result.indexOf("--");
  const end = delimiter < 0 ? result.length : delimiter;
  const index = result.indexOf("--features", 0);
  if (index >= 0 && index < end) {
    const existing = result[index + 1].split(",").map((name) => name.trim());
    const missing = features.filter((name) => !existing.includes(name));
    result[index + 1] = [...existing, ...missing].join(",");
    return result;
  }
  result.splice(end, 0, "--features", features.join(","));
  return result;
}

// Direct macOS builds get the private-API vibrancy feature. Store builds never do.
export function resolveBuildInput({
  input = [],
  additionalConfig,
  target,
  platform,
  requireMacosSigning = false,
}) {
  const storeBuild = isStoreBuild({ additionalConfig, input });
  const macosBuild = isMacosBuild({ requireMacosSigning, target, platform });
  return macosBuild && !storeBuild
    ? withBuildFeatures(input, ["macos-vibrancy"])
    : [...input];
}
