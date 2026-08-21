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
