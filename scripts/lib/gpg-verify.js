import process from "node:process";

export function gpgVerifyStatusArgs(signaturePath, payloadPath) {
  if (!signaturePath || !payloadPath) {
    throw new Error(
      "gpgVerifyStatusArgs requires a signature path and a payload path.",
    );
  }
  return [
    "--batch",
    "--status-fd",
    "1",
    "--verify",
    signaturePath,
    payloadPath,
  ];
}

export function parseGpgValidsigFingerprint(statusOutput) {
  for (const line of String(statusOutput ?? "").split(/\r?\n/)) {
    const match = line.match(/\[GNUPG:\]\s+VALIDSIG\s+([0-9A-Fa-f]{40,64})\b/);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

export function expectedGpgFingerprint(env = process.env) {
  const value = String(env.GPG_KEY_ID ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();
  return value || null;
}

export function assertGpgSignatureFingerprint(
  statusOutput,
  expectedFingerprint,
) {
  const expected = String(expectedFingerprint ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!expected) {
    throw new Error(
      "Release signature verification requires GPG_KEY_ID set to the expected signer's full fingerprint.",
    );
  }
  if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/.test(expected)) {
    throw new Error(
      `GPG_KEY_ID must be the signer's full 40- or 64-character fingerprint; got "${expectedFingerprint}".`,
    );
  }
  const actual = parseGpgValidsigFingerprint(statusOutput);
  if (!actual) {
    throw new Error(
      "GPG verification did not report VALIDSIG; refusing to accept the signature.",
    );
  }
  if (actual !== expected) {
    throw new Error(
      `GPG signature fingerprint mismatch: got ${actual}, expected ${expected}.`,
    );
  }
  return actual;
}
