#!/bin/sh
set -eu
security unlock-keychain "$HOME/Library/Keychains/login.keychain-db"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${MAC_KEYCHAIN_PASSWORD:?Set MAC_KEYCHAIN_PASSWORD}" "$HOME/Library/Keychains/login.keychain-db"
