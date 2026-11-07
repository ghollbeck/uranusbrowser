#!/bin/bash
# Puts UrAnus Browser's branding and patches on the Chromium checkout, then builds the
# dev (component) app at out/Dev/UrAnus Browser.app. Extra arguments go to autoninja.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"

"$here/scripts/apply.sh"
cd "$src"
out=out/Dev
mkdir -p "$out"
if [ ! -f "$out/args.gn" ]; then
  sed "s/^target_cpu = .*/target_cpu = \"$ANUS_ARCH\"/" "$here/build/dev.gn" > "$out/args.gn"
fi
if [ ! -f "$out/build.ninja" ]; then
  gn gen "$out"
fi
autoninja -C "$out" chrome "$@"
