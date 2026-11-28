import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  parseMinisignPublicKey,
  signedVersion,
  verifyTauriSignatureBytes,
} from "./verify-tauri-signature.js";

const publicKeyLine =
  "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const publicKeyFile = `untrusted comment: minisign public key E7620F1842B4E81F
${publicKeyLine}
`;

test("parses a minisign public key file or key line", () => {
  const fromLine = parseMinisignPublicKey(publicKeyLine);
  const fromFile = parseMinisignPublicKey(
    Buffer.from(publicKeyFile, "utf8").toString("base64"),
  );
  assert.equal(fromLine.publicKey.length, 32);
  assert.deepEqual(fromLine.keyId, fromFile.keyId);
  assert.deepEqual(fromLine.publicKey, fromFile.publicKey);
});

test("verifies a legacy minisign test vector", () => {
  verifyTauriSignatureBytes({
    payload: Buffer.from("test"),
    signatureText: `untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==`,
    publicKeyBase64: publicKeyLine,
  });
  assert.throws(
    () =>
      verifyTauriSignatureBytes({
        payload: Buffer.from("Test"),
        signatureText: `untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==`,
        publicKeyBase64: publicKeyLine,
      }),
    /does not match the payload/,
  );
});

test("verifies a hashed minisign test vector", () => {
  verifyTauriSignatureBytes({
    payload: Buffer.from("test"),
    signatureText: `untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==`,
    publicKeyBase64: publicKeyLine,
  });
});

// Signed-version failure modes (updaters use requireSignedVersion):
// 1. A valid signature with no `version:` field ships and every client rejects it.
// 2. A signature bound to another version ships.
// 3. A forged trusted comment is judged on its version before it is verified.
// 4. Callers without an expected version change behavior.
function signFixture(trustedComment) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("0102030405060708", "hex");
  const rawPublic = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(12);
  const payload = Buffer.from("payload");
  const digest = createHash("blake2b512").update(payload).digest();
  const sig = sign(null, digest, privateKey);
  const global = sign(
    null,
    Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]),
    privateKey,
  );
  const signatureLine = Buffer.concat([Buffer.from("ED"), keyId, sig]);
  const keyLine = Buffer.concat([Buffer.from("Ed"), keyId, rawPublic]);
  return {
    payload,
    publicKeyBase64: keyLine.toString("base64"),
    signatureText: [
      "untrusted comment: signature from tauri secret key",
      signatureLine.toString("base64"),
      `trusted comment: ${trustedComment}`,
      global.toString("base64"),
    ].join("\n"),
  };
}

test("a signature without a signed version is rejected for a release", () => {
  const fixture = signFixture("timestamp:1\tfile:Postal Snap_x64-setup.exe");
  assert.throws(
    () =>
      verifyTauriSignatureBytes({
        ...fixture,
        expectedVersion: "0.5.4-beta.1",
      }),
    /not bound to version 0\.5\.4-beta\.1/,
  );
});

test("a signature bound to another version is rejected", () => {
  const fixture = signFixture("timestamp:1\tfile:a.exe\tversion:0.5.3");
  assert.throws(
    () =>
      verifyTauriSignatureBytes({
        ...fixture,
        expectedVersion: "0.5.4-beta.1",
      }),
    /signed for 0\.5\.3, not 0\.5\.4-beta\.1/,
  );
});

test("a signature bound to the release version passes", () => {
  const fixture = signFixture("timestamp:1\tfile:a.exe\tversion:0.5.4-beta.1");
  verifyTauriSignatureBytes({ ...fixture, expectedVersion: "0.5.4-beta.1" });
  verifyTauriSignatureBytes({ ...fixture, expectedVersion: "v0.5.4-beta.1" });
});

test("a forged version comment fails verification before the version check", () => {
  const fixture = signFixture("timestamp:1\tfile:a.exe");
  const forged = fixture.signatureText.replace(
    "file:a.exe",
    "file:a.exe\tversion:0.5.4-beta.1",
  );
  assert.throws(
    () =>
      verifyTauriSignatureBytes({
        ...fixture,
        signatureText: forged,
        expectedVersion: "0.5.4-beta.1",
      }),
    /trusted comment does not verify/,
  );
});

test("callers without an expected version keep the old behavior", () => {
  verifyTauriSignatureBytes(signFixture("timestamp:1\tfile:a.exe"));
});

test("signedVersion reads the version field from a trusted comment", () => {
  assert.equal(signedVersion("timestamp:1\tfile:a\tversion:1.2.3"), "1.2.3");
  assert.equal(signedVersion("timestamp:1\tfile:a"), null);
});
