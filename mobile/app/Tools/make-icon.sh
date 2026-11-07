#!/usr/bin/env bash
# Renders the iOS app icon from the Flecha logo master (chromium/branding/logo/flecha-logo.svg).
# The master is a macOS tile with a margin; iOS wants the tile edge to edge (the system rounds the corners)
# and an opaque 1024 px PNG, so crop to the tile, fill the corners and drop the alpha channel.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=../../chromium/branding/logo/flecha-logo.svg
OUT=Sources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
TMP=$(mktemp -d)
sed 's/viewBox="0 0 1024 1024"/viewBox="116 116 792 792"/' "$SRC" > "$TMP/tile.svg"
rsvg-convert -w 1024 -h 1024 --background-color '#eef1f6' "$TMP/tile.svg" -o "$TMP/icon.png"
sips -s format jpeg -s formatOptions best "$TMP/icon.png" --out "$TMP/icon.jpg" >/dev/null
sips -s format png "$TMP/icon.jpg" --out "$OUT" >/dev/null
rm -rf "$TMP"
echo "wrote $OUT"
