#!/bin/bash
# Generate a signed Sparkle appcast locally. Set ANUS_DOWNLOAD_URL_PREFIX to the
# HTTPS asset prefix (with trailing /) and ANUS_RELEASE_SITE_URL to your release site.
# Usage: make-appcast.sh <Uranus-Browser-version[-x64].dmg> [appcast folder]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <Uranus-Browser-<version>.dmg> [<folder>]" >&2
  exit 1
fi
dmg="$1"
if [ ! -f "$dmg" ]; then
  echo "error: no $dmg" >&2
  exit 1
fi
release="${ANUS_RELEASE_DIR:-$release_out/anus-release}"
folder="${2:-$release/appcast}"
prefix="${ANUS_DOWNLOAD_URL_PREFIX:?set the HTTPS download prefix ending in /}"
site="${ANUS_RELEASE_SITE_URL:?set the release site URL}"
[[ "$prefix" = https://*/ && "$site" = https://* ]] || { echo "error: use HTTPS release URLs" >&2; exit 1; }
sparkle="$("$here/scripts/fetch-sparkle.sh")"

# Sparkle installs what it downloads only if Gatekeeper would open it: a Developer ID
# signed, notarized and stapled dmg.
echo "== check $dmg"
codesign --verify --strict "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature "$dmg"

mkdir -p "$folder"
cp -f "$dmg" "$folder/"

echo "== generate_appcast $folder"
"$sparkle/bin/generate_appcast" \
  --download-url-prefix "$prefix" \
  --maximum-versions 1 \
  --embed-release-notes \
  -o "$folder/$release_feed" \
  --link "$site" \
  "$folder"

feed="$folder/$release_feed"
if [ ! -f "$feed" ] || ! grep -q 'sparkle:edSignature' "$feed"; then
  echo "error: $feed is missing or has no EdDSA signature" >&2
  exit 1
fi
echo "== $(basename "$dmg"): $("$sparkle/bin/sign_update" "$folder/$(basename "$dmg")")"
cat <<EOF

Made $feed. To publish it and the dmg to $prefix:
  chromium/scripts/publish-release.sh $dmg
EOF
