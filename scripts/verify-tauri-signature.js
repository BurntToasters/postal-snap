import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { json, root } from "./_utils.js";
import { resolveUpdaterPublicKey } from "./updater-pubkey.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeBase64(value, expectedLength, label) {
  const decoded = Buffer.from(String(value ?? "").trim(), "base64");
  if (expectedLength && decoded.length !== expectedLength) {
    throw new Error(`${label} is not a minisign ${label.toLowerCase()}.`);
  }
  if (!decoded.length) {
    throw new Error(`${label} is empty.`);
  }
  return decoded;
}

export function parseMinisignPublicKey(publicKeyBase64) {
  const decodedFile = Buffer.from(
    String(publicKeyBase64 ?? "").trim(),
    "base64",
  );
  const asText = decodedFile.toString("utf8");
  const keyLine = /minisign public key/i.test(asText)
    ? asText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !/^untrusted comment:/i.test(line))
    : String(publicKeyBase64 ?? "").trim();
  const raw = decodeBase64(keyLine, 42, "Updater public key");
  const algorithm = raw.subarray(0, 2).toString("binary");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error("Updater public key uses an unsupported algorithm.");
  }
  return {
    keyId: raw.subarray(2, 10),
    publicKey: raw.subarray(10, 42),
  };
}

export function parseMinisignSignature(signatureText) {
  const lines = String(signatureText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  if (lines.length < 4) {
    throw new Error("Updater signature is not a complete minisign signature.");
  }
  const raw = decodeBase64(lines[1], 74, "Updater signature");
  const trustedComment = lines[2];
  if (!trustedComment.startsWith("trusted comment: ")) {
    throw new Error("Updater signature is missing a trusted comment.");
  }
  const globalSignature = decodeBase64(
    lines[3],
    64,
    "Updater global signature",
  );
  const algorithm = raw.subarray(0, 2).toString("binary");
  return {
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10, 74),
    trustedComment: trustedComment.slice("trusted comment: ".length),
    globalSignature,
    hashed: algorithm === "ED",
    legacy: algorithm === "Ed",
  };
}

function ed25519Key(publicKeyRaw) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]),
    format: "der",
    type: "spki",
  });
}

function verifyEd25519(publicKeyRaw, data, signature) {
  return verify(null, data, ed25519Key(publicKeyRaw), signature);
}

export function verifyTauriSignatureBytes({
  payload,
  signatureText,
  publicKeyBase64,
}) {
  const key = parseMinisignPublicKey(publicKeyBase64);
  const signature = parseMinisignSignature(signatureText);
  if (!signature.keyId.equals(key.keyId)) {
    throw new Error(
      "Updater signature does not match the committed public key.",
    );
  }
  const signed = signature.hashed
    ? createHash("blake2b512").update(payload).digest()
    : payload;
  if (!signature.hashed && !signature.legacy) {
    throw new Error("Updater signature uses an unsupported algorithm.");
  }
  if (!verifyEd25519(key.publicKey, signed, signature.signature)) {
    throw new Error("Updater signature does not match the payload.");
  }
  const comment = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, "utf8"),
  ]);
  if (!verifyEd25519(key.publicKey, comment, signature.globalSignature)) {
    throw new Error("Updater signature trusted comment does not verify.");
  }
}

export async function verifyTauriSignatureFile(
  payloadPath,
  signaturePath,
  publicKeyBase64,
) {
  const [payload, signatureText] = await Promise.all([
    readFile(payloadPath),
    readFile(signaturePath, "utf8"),
  ]);
  verifyTauriSignatureBytes({
    payload,
    signatureText,
    publicKeyBase64,
  });
}

export async function committedUpdaterPublicKey() {
  const config = await json(join(root, "src-tauri/tauri.conf.json"));
  return resolveUpdaterPublicKey({
    committed: config.plugins?.updater?.pubkey,
    fromEnv: process.env.TAURI_UPDATER_PUBLIC_KEY,
  });
}
