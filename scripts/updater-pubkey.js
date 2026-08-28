export const PLACEHOLDER_UPDATER_PUBLIC_KEY = "POSTAL_SNAP_UPDATER_PUBLIC_KEY";

export function normalizeUpdaterPublicKey(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

export function isPlaceholderUpdaterPublicKey(value) {
  const normalized = normalizeUpdaterPublicKey(value);
  return !normalized || normalized === PLACEHOLDER_UPDATER_PUBLIC_KEY;
}

export function isMinisignPublicKey(value) {
  if (isPlaceholderUpdaterPublicKey(value)) return false;
  try {
    const decoded = Buffer.from(String(value ?? "").trim(), "base64").toString(
      "utf8",
    );
    return /minisign public key/i.test(decoded);
  } catch {
    return false;
  }
}

export function resolveUpdaterPublicKey({
  committed,
  fromEnv,
  requireSigning = false,
} = {}) {
  const envKey = String(fromEnv ?? "").trim();
  const committedKey = String(committed ?? "").trim();

  if (requireSigning) {
    if (!envKey) {
      throw new Error(
        "Missing required environment variables: TAURI_UPDATER_PUBLIC_KEY",
      );
    }
    if (!isMinisignPublicKey(envKey)) {
      throw new Error(
        "TAURI_UPDATER_PUBLIC_KEY is still a placeholder. Generate a Tauri updater key with `npm run tauri -- signer generate`, store the private key outside git, and put the public key in both TAURI_UPDATER_PUBLIC_KEY and src-tauri/tauri.conf.json.",
      );
    }
    if (
      committedKey &&
      !isPlaceholderUpdaterPublicKey(committedKey) &&
      normalizeUpdaterPublicKey(envKey) !==
        normalizeUpdaterPublicKey(committedKey)
    ) {
      throw new Error(
        "TAURI_UPDATER_PUBLIC_KEY does not match plugins.updater.pubkey in tauri.conf.json.",
      );
    }
    return envKey;
  }

  const chosen = envKey || committedKey;
  if (!isMinisignPublicKey(chosen)) {
    throw new Error(
      "Direct builds need a real Tauri updater public key in src-tauri/tauri.conf.json.",
    );
  }
  return chosen;
}
