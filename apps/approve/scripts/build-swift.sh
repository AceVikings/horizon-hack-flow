#!/bin/sh
# Build and codesign ate-approve (SPEC §10.1). Set ATE_APPROVE_SIGN_ID to a Developer ID / setup cert
# identity; defaults to ad-hoc ("-").
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
mkdir -p "$ROOT/bin"
swiftc -O -o "$ROOT/bin/ate-approve" "$ROOT/swift/ate-approve.swift" \
  -framework CryptoKit -framework LocalAuthentication -framework Security
codesign -s "${ATE_APPROVE_SIGN_ID:--}" --force --options runtime --identifier dev.vikings.ate.approve "$ROOT/bin/ate-approve"
echo "built $ROOT/bin/ate-approve"
echo "install: sudo install -d -o root -g wheel -m 0755 /usr/local/libexec/ate && sudo install -o root -g wheel -m 0755 $ROOT/bin/ate-approve /usr/local/libexec/ate/ate-approve"
