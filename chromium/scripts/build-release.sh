#!/bin/bash
# Builds the release (non-component, optimized) UrAnus Browser.app and packages it.
#
#   chromium/scripts/build-release.sh [--dmg] [--no-package] [autoninja arguments...]
#
# The release flow, each step safe to run again (a full build takes 3-6 hours; when it stops
# for any reason, run the same command and it carries on where it was):
#   1. builds the shell (chromium/shell/dist; needs `npm ci` at the repo root once);
#   2. puts branding and patches on the checkout with apply.sh, unless this same patch set is
#      already there (out/Release/anus-applied.sha256): re-applying rewrites every patched
#      file and so recompiles them. ANUS_REAPPLY=1 applies anyway;
#   3. stages the shell in the checkout at //anus/shell, where the anus_shell_dir GN arg
#      (patch 0050) copies it into the framework's Resources/anus-shell, which is where the
#      app loads it from without --anus-shell-dir. It sits inside the checkout because the
#      build (siso) only tracks files under the source root; it is not part of Chromium's git;
#      Sparkle.framework (fetch-sparkle.sh) is staged the same way, at //anus/Sparkle.framework,
#      for the app's Contents/Frameworks (patch 0053);
#   4. writes out/Release/args.gn from chromium/build/release.gn plus UrAnus Browser's version
#      (package.json) and build number (see below), only when it changes, so a re-run doesn't
#      regenerate. ANUS_OFFICIAL=1 adds is_official_build = true: ThinLTO, slower still,
#      and a full rebuild when switched;
#   5. autoninja -C out/Release chrome, under caffeinate so the Mac doesn't sleep;
#   6. package-release.sh: copies the app to out/Release/anus-release/UrAnus Browser, adds the
#      native host (with its Node) and signs it all, ad hoc unless ANUS_SIGN_IDENTITY names
#      an identity; --dmg also makes UrAnus-Browser-<version>.dmg there. See that script.
# Then copy UrAnus Browser.app to /Applications and run
#   chromium/scripts/install-native-host.sh --app "/Applications/UrAnus Browser.app"
#
# ANUS_ARCH=x64 builds for Intel Macs instead, into out/Release-x64 (see env.sh); its
# package step needs an Intel Node in ANUS_NODE.
#
# Dev builds (build.sh, out/Dev) share the checkout: don't run both at once. The release app
# uses the default profile folder, ~/Library/Application Support/UrAnus Browser.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"
root="$(cd "$here/.." && pwd)"
out="$release_out"
updates="${ANUS_UPDATES:-0}"
case "$updates" in
  0) ;;
  1)
    : "${ANUS_SPARKLE_FEED_URL:?set an HTTPS appcast URL for this architecture}"
    : "${ANUS_SPARKLE_PUBLIC_KEY:?set the Sparkle EdDSA public key}"
    [[ "$ANUS_SPARKLE_FEED_URL" =~ ^https://[a-zA-Z0-9._:/%=+~-]+$ ]] || { echo "error: invalid Sparkle feed URL" >&2; exit 1; }
    [[ "$ANUS_SPARKLE_PUBLIC_KEY" =~ ^[a-zA-Z0-9+/]{43}=$ ]] || { echo "error: invalid Sparkle public key" >&2; exit 1; }
    ;;
  *) echo "error: ANUS_UPDATES must be 0 or 1" >&2; exit 1 ;;
esac

package=1
package_args=()
ninja_args=()
for arg in "$@"; do
  case "$arg" in
    --no-package) package=0 ;;
    --dmg) package_args+=(--dmg) ;;
    *) ninja_args+=("$arg") ;;
  esac
done

[ -d "$src/chrome/app/theme/chromium" ] || { echo "error: set CHROMIUM_SRC to a Chromium src checkout" >&2; exit 1; }

step() { printf '\n== %s\n' "$*"; }

"$here/scripts/ensure-branding.sh"

step "shell"
if [ ! -d "$root/node_modules/esbuild" ]; then
  echo "error: no node_modules in $root; run npm ci there first" >&2
  exit 1
fi
(cd "$root" && node chromium/shell/build.mjs)
if [ ! -f "$here/shell/dist/manifest.json" ]; then
  echo "error: the shell build left no $here/shell/dist/manifest.json" >&2
  exit 1
fi
rules="$here/shell/dist/rules/easylist.json"
if [ ! -f "$rules" ] || [ "$(wc -c <"$rules")" -lt 10000 ]; then
  echo "warning: the ad blocker's rules look empty (no network for build-adblock.mjs?)" >&2
fi

step "patches"
mkdir -p "$out"
stamp="$out/anus-applied.sha256"
want="$(cat "$here"/patches/*.patch "$here/branding/BRANDING" "$here"/branding/mac/* \
  "$here"/branding/logo/product_logo_*.png | shasum -a 256 | cut -d' ' -f1)"
last="$(ls "$here"/patches/*.patch | tail -n 1)"
if [ "${ANUS_REAPPLY:-0}" != 1 ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ] &&
  (cd "$src" && git apply --reverse --check "$last" 2>/dev/null); then
  echo "already applied (ANUS_REAPPLY=1 to apply again)"
else
  rm -f "$stamp"
  "$here/scripts/apply.sh"
  echo "$want" >"$stamp"
fi

step "stage the shell at //anus/shell"
staged="$src/anus/shell"
if diff -rq "$here/shell/dist" "$staged" >/dev/null 2>&1; then
  echo "unchanged"
else
  # A fresh folder, so its time is newer than the copy in the app and the build copies it.
  rm -rf "$staged"
  mkdir -p "$src/anus"
  cp -R "$here/shell/dist" "$staged"
  echo "staged $staged"
fi

# Sparkle is available only for maintainers who configure their own feed.
if [ "$updates" = 0 ]; then
  step "no Sparkle (ANUS_UPDATES=0)"
else
  step "stage Sparkle at //anus/Sparkle.framework"
  # The official Sparkle 2 release, pinned and checked (fetch-sparkle.sh); the
  # anus_sparkle_framework GN arg (patch 0053) copies it into Contents/Frameworks.
  sparkle_dir="$("$here/scripts/fetch-sparkle.sh")"
  staged_sparkle="$src/anus/Sparkle.framework"
  if diff -rq "$sparkle_dir/Sparkle.framework" "$staged_sparkle" >/dev/null 2>&1; then
    echo "unchanged"
  else
    rm -rf "$staged_sparkle"
    mkdir -p "$src/anus"
    # cp -R keeps the framework's symlinks (Versions/Current and the top-level links), and,
    # like the shell's, the fresh copy is newer than the one in the app, so the build copies it.
    cp -R "$sparkle_dir/Sparkle.framework" "$staged_sparkle"
    echo "staged $staged_sparkle"
  fi
fi

step "$(basename "$out")/args.gn"
# release.gn is the arm64 build; ANUS_ARCH=x64 (env.sh) swaps the CPU.
args="$(sed -e "s/^target_cpu = .*/target_cpu = \"$ANUS_ARCH\"/" \
  "$here/build/release.gn")"
# The package version and an optional maintainer-supplied build counter.
anus_version="$(node -p 'require(process.argv[1]).version' "$root/package.json")"
# Source archives do not carry Git metadata. Published builds should set a monotonic counter.
anus_build_number="${ANUS_BUILD_NUMBER:-1}"
[[ "$anus_build_number" =~ ^[0-9]+$ ]] || { echo "error: ANUS_BUILD_NUMBER must be numeric" >&2; exit 1; }
args="$args
anus_version = \"$anus_version\"
anus_build_number = \"$anus_build_number\""
if [ "$updates" = 1 ]; then
  args="$args
anus_sparkle_framework = \"//anus/Sparkle.framework\"
anus_sparkle_feed_url = \"$ANUS_SPARKLE_FEED_URL\"
anus_sparkle_public_key = \"$ANUS_SPARKLE_PUBLIC_KEY\""
fi
if [ "${ANUS_OFFICIAL:-0}" = 1 ]; then
  args="$args
is_official_build = true"
fi
if [ -f "$out/args.gn" ] && [ "$(cat "$out/args.gn")" = "$args" ]; then
  echo "unchanged"
else
  printf '%s\n' "$args" >"$out/args.gn"
  echo "wrote $out/args.gn"
fi

cd "$src"
if [ ! -f "$out/build.ninja" ]; then
  step "gn gen $out"
  gn gen "$out"
fi

step "autoninja -C $out chrome"
caffeinate -i autoninja -C "$out" chrome ${ninja_args[@]+"${ninja_args[@]}"}
if [ "$updates" = 0 ]; then
  # Ninja leaves outputs of targets that are gone: no Sparkle from an earlier build here.
  rm -rf "$out/$(sed -n 's/^PRODUCT_FULLNAME=//p' "$here/branding/BRANDING").app/Contents/Frameworks/Sparkle.framework"
fi

if [ "$package" = 1 ]; then
  step "package"
  "$here/scripts/package-release.sh" ${package_args[@]+"${package_args[@]}"}
fi
