import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMinisignPublicKey,
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
