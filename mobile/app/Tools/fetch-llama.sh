#!/usr/bin/env bash
# Fetch the pinned llama.cpp xcframework the Algorithm Diet uses to run Underdog Woof on the iPhone.
# Release zip from GitHub, checked against the release's SHA-256. It has a device slice only (ios-arm64), so only
# iphoneos builds link it; Simulator builds use the Mac bridge instead (see Sources/Diet/LocalModel.swift).
# Output: Vendor/llama.xcframework (ignored by git). run.sh calls this for device builds.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=b11600   # published 2026-10-13
SHA=a44f73ae282a7dc38c73107dd646d22d2463a442c7d2a36d8c9c373764759e68
DEST=Vendor/llama.xcframework
[ -d "$DEST" ] && [ -f "Vendor/.llama-$TAG" ] && exit 0
mkdir -p Vendor
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -s -o "$TMP/llama.zip" "https://github.com/ggml-org/llama.cpp/releases/download/$TAG/llama-$TAG-xcframework.zip"
echo "$SHA  $TMP/llama.zip" | shasum -a 256 -c - >/dev/null
mkdir "$TMP/x" && unzip -q "$TMP/llama.zip" -d "$TMP/x"
SRC=$(find "$TMP/x" -maxdepth 3 -name llama.xcframework -type d | head -1)
[ -n "$SRC" ] || { echo "no llama.xcframework in the zip" >&2; exit 1; }
rm -rf "$DEST" Vendor/.llama-*
mv "$SRC" "$DEST"
touch "Vendor/.llama-$TAG"
echo "llama.cpp $TAG -> $DEST"
