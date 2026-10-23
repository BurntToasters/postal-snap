export function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

// Strict release versions only: X.Y.Z with an optional prerelease tag and no
// build metadata or `v` prefix. Shared by updater manifest validation.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isSemVer(value) {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}
