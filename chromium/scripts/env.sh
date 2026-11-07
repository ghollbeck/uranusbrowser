# shellcheck shell=bash
# Shared configuration for contributor builds. CHROMIUM_SRC must be a dedicated
# Chromium checkout: apply.sh resets the files it patches.
ANUS_DISK="${ANUS_DISK:-${XDG_CACHE_HOME:-$HOME/.cache}/anus-browser}"
src="${CHROMIUM_SRC:-$HOME/chromium/src}"
if [ -n "${DEPOT_TOOLS:-}" ]; then
  export PATH="$DEPOT_TOOLS:$PATH"
fi

ANUS_ARCH="${ANUS_ARCH:-arm64}"
# The scripts that source this use these; ShellCheck can't see that from here.
# shellcheck disable=SC2034
case "$ANUS_ARCH" in
  arm64) release_out="$src/out/Release"; release_suffix=""; release_feed="appcast.xml"; node_arch="arm64" ;;
  x64) release_out="$src/out/Release-x64"; release_suffix="-x64"; release_feed="appcast-x64.xml"; node_arch="x86_64" ;;
  *) echo "error: ANUS_ARCH must be arm64 or x64, not $ANUS_ARCH" >&2; exit 1 ;;
esac
