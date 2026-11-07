#!/bin/bash
# Generate macOS resources omitted from the source export, or refresh them after an SVG edit.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
master="$here/branding/logo/anus-logo.svg"
for f in "$here/branding/mac/app.icns" "$here/branding/mac/Assets.car"; do
  if [ ! -s "$f" ] || [ "$master" -nt "$f" ]; then
    exec "$here/branding/logo/build-logo.sh"
  fi
done
