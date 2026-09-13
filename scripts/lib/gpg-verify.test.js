import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGpgSignatureFingerprint,
  expectedGpgFingerprint,
  gpgVerifyStatusArgs,
  parseGpgValidsigFingerprint,
} from "./gpg-verify.js";

const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
const otherFingerprint = "FEDCBA9876543210FEDCBA9876543210FEDCBA98";

const validsigStatus = [
  "[GNUPG:] NEWSIG",
  "[GNUPG:] KEY_CONSIDERED ABCDEF0123456789ABCDEF0123456789ABCDEF01 0",
  `[GNUPG:] VALIDSIG ${fingerprint} 2026-01-01 1767225600 0 4 0 1 8 00 ${fingerprint}`,
  "[GNUPG:] GOODSIG ABCDEF01 Example Signer",
].join("\n");

test("gpgVerifyStatusArgs asks gpg for machine-readable status", () => {
  assert.deepEqual(gpgVerifyStatusArgs("artifact.asc", "artifact.exe"), [
    "--batch",
    "--status-fd",
    "1",
    "--verify",
    "artifact.asc",
    "artifact.exe",
  ]);
  assert.throws(
    () => gpgVerifyStatusArgs("", "artifact.exe"),
    /signature path/,
  );
});

test("parseGpgValidsigFingerprint reads VALIDSIG from status output", () => {
  assert.equal(parseGpgValidsigFingerprint(validsigStatus), fingerprint);
  assert.equal(
    parseGpgValidsigFingerprint("[GNUPG:] GOODSIG ABCDEF01 Example"),
    null,
  );
  assert.equal(parseGpgValidsigFingerprint(undefined), null);
});

test("expectedGpgFingerprint normalizes GPG_KEY_ID and rejects it missing", () => {
  assert.equal(
    expectedGpgFingerprint({ GPG_KEY_ID: " 0123 4567 abcd " }),
    "01234567ABCD",
  );
  assert.equal(expectedGpgFingerprint({}), null);
});

test("assertGpgSignatureFingerprint compares fingerprints fail-closed", () => {
  assert.equal(
    assertGpgSignatureFingerprint(validsigStatus, fingerprint),
    fingerprint,
  );
  assert.equal(
    assertGpgSignatureFingerprint(validsigStatus, fingerprint.toLowerCase()),
    fingerprint,
  );
  assert.throws(
    () => assertGpgSignatureFingerprint(validsigStatus, otherFingerprint),
    /fingerprint mismatch/,
  );
  assert.throws(
    () => assertGpgSignatureFingerprint("no status here", fingerprint),
    /did not report VALIDSIG/,
  );
  assert.throws(
    () => assertGpgSignatureFingerprint(validsigStatus, "ABCDEF01"),
    /full 40- or 64-character fingerprint/,
  );
  assert.throws(
    () => assertGpgSignatureFingerprint(validsigStatus, ""),
    /requires GPG_KEY_ID/,
  );
});
