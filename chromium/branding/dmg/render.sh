#!/bin/bash
# Renders background.html into background.tiff, the disk image window's background: a 1x and
# a 2x picture in one multi-resolution TIFF, so Retina screens get the sharp one.
#
#   chromium/branding/dmg/render.sh [<browser binary>]
#
# Pass a Chromium-based browser binary to render the installer background.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
browser="${1:-${ANUS_RENDER_BROWSER:?pass a Chromium browser binary}}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

render() { # render <scale> <out.png>
  "$browser" --headless --disable-gpu --hide-scrollbars --no-first-run \
    --user-data-dir="$work/profile-$1" --force-device-scale-factor="$1" \
    --window-size=660,440 --screenshot="$2" "file://$here/background.html" >/dev/null 2>&1
}
render 1 "$work/background.png"
render 2 "$work/background@2x.png"
for f in "$work/background.png" "$work/background@2x.png"; do
  if [ ! -s "$f" ]; then echo "error: $browser rendered nothing" >&2; exit 1; fi
done
# 72 and 144 dpi, so the TIFF's two pictures are the same size in points.
sips -s dpiWidth 72 -s dpiHeight 72 "$work/background.png" >/dev/null
sips -s dpiWidth 144 -s dpiHeight 144 "$work/background@2x.png" >/dev/null
tiffutil -cathidpicheck "$work/background.png" "$work/background@2x.png" -out "$here/background.tiff"
echo "made $here/background.tiff"
