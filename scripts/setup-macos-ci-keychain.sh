#!/usr/bin/env bash
set -euo pipefail
set +x

signing_root="${RUNNER_TEMP:-/tmp}/postal-snap-signing"
certificate_path="$signing_root/certificate.p12"
keychain_path="$signing_root/postal-snap.keychain-db"
cleanup() {
  rm -f "$certificate_path"
}
trap cleanup EXIT

if [[ -z "${APPLE_CERTIFICATE_P12_BASE64:-}" || -z "${APPLE_CERTIFICATE_PASSWORD:-}" || -z "${APPLE_KEYCHAIN_PASSWORD:-}" ]]; then
  echo "Missing Apple certificate/keychain secrets." >&2
  exit 1
fi

mkdir -p "$signing_root"
printf '%s' "$APPLE_CERTIFICATE_P12_BASE64" | openssl base64 -d -A -out "$certificate_path"
security create-keychain -p "$APPLE_KEYCHAIN_PASSWORD" "$keychain_path"
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$APPLE_KEYCHAIN_PASSWORD" "$keychain_path"
security import "$certificate_path" -k "$keychain_path" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/productbuild
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$APPLE_KEYCHAIN_PASSWORD" "$keychain_path"
security list-keychains -d user -s "$keychain_path"
echo "macOS signing keychain is ready."
