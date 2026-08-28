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
