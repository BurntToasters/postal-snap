export function topChangelogVersion(changelog) {
  const match = String(changelog ?? "").match(
    /^#{2,6}\s+Changes in\s+`v?([^:`\s]+):?`/m,
  );
  return match ? match[1] : null;
}

export function assertTopChangelogVersion(
  changelog,
  version,
  label = "CHANGELOG.md",
) {
  const expected = String(version ?? "")
    .trim()
    .replace(/^v/i, "");
  if (!expected) {
    throw new Error(`${label}: package version is missing.`);
  }
  const actual = topChangelogVersion(changelog);
  if (!actual) {
    throw new Error(
      `${label} has no "## Changes in ..." section; add one for v${expected} before releasing.`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      `${label} top section is v${actual} but package.json is v${expected}; update the changelog before releasing.`,
    );
  }
  return actual;
}
