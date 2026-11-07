#!/bin/bash
# Renders every UrAnus Browser logo file from the SVG masters, so changing the logo is: edit
# anus-logo.svg (and anus-mark.svg to match), run this, commit what it wrote.
#
#   chromium/branding/logo/build-logo.sh
#
# Writes
#   chromium/branding/logo/product_logo_{16,24,48,64,128,256}.png   Chromium's product logos
#   chromium/branding/mac/app.icns                                  the Dock / Finder / dmg icon
#   chromium/branding/mac/Assets.car                                the same icon as an asset catalog
#                                                                   (macOS 26 reads this before app.icns)
#   chromium/shell/ui/logo.ts                                       the logo and the mark, inline, for the shell UI
# Needs rsvg-convert (brew install librsvg), sips, iconutil, xcrun actool (Xcode) and node, all
# already on the Mac that builds UrAnus Browser. Nothing is installed or touched outside the repo.
#
# Render the full SVG canvas at each size.
# Assets.car embeds a timestamp, so it differs on every run; app.icns and the PNGs do not.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
branding="$(cd "$here/.." && pwd)"
master="$here/anus-logo.svg"
for tool in rsvg-convert sips iconutil node; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

full="0 0 1024 1024"     # the whole canvas: the tile is 46..978 x 50..974

render() { # render <viewBox> <pixels> <out.png>
  sed "s|viewBox=\"0 0 1024 1024\" width=\"1024\" height=\"1024\"|viewBox=\"$1\" width=\"$2\" height=\"$2\"|" "$master" >"$work/r.svg"
  grep -q "viewBox=\"$1\"" "$work/r.svg" || { echo "error: the svg header in $master changed" >&2; exit 1; }
  rsvg-convert -w "$2" -h "$2" "$work/r.svg" -o "$3"
}

echo "== product logos"
for s in 16 24 48 64 128 256; do render "$full" "$s" "$here/product_logo_$s.png"; done

mkdir -p "$branding/mac"
echo "== app.icns"
iconset="$work/AppIcon.iconset"
mkdir -p "$iconset"
render "$full" 16 "$iconset/icon_16x16.png"
render "$full" 32 "$iconset/icon_16x16@2x.png"
render "$full" 32 "$iconset/icon_32x32.png"
render "$full" 64 "$iconset/icon_32x32@2x.png"
render "$full" 128 "$iconset/icon_128x128.png"
render "$full" 256 "$iconset/icon_128x128@2x.png"
render "$full" 256 "$iconset/icon_256x256.png"
render "$full" 512 "$iconset/icon_256x256@2x.png"
render "$full" 512 "$iconset/icon_512x512.png"
render "$full" 1024 "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o "$branding/mac/app.icns"

echo "== Assets.car"
# Chromium's Info.plist asks for CFBundleIconName AppIcon, and the app also carries an "Icon"
# set (256 px, 1x and 2x) like the catalog it replaces.
xc="$work/Assets.xcassets"
mkdir -p "$xc/AppIcon.appiconset" "$xc/Icon.iconset"
echo '{ "info" : { "author" : "xcode", "version" : 1 } }' >"$xc/Contents.json"
{
  echo '{ "images" : ['
  sep=""
  for spec in "16 1 16" "16 2 32" "32 1 32" "32 2 64" "128 1 128" "128 2 256" "256 1 256" "256 2 512" "512 1 512" "512 2 1024"; do
    set -- $spec
    name="appicon_$3.png"
    if [ ! -f "$xc/AppIcon.appiconset/$name" ]; then
      render "$full" "$3" "$xc/AppIcon.appiconset/$name"
    fi
    printf '%s{ "filename" : "%s", "idiom" : "mac", "scale" : "%sx", "size" : "%sx%s" }' "$sep" "$name" "$2" "$1" "$1"
    sep=$',\n'
  done
  echo '], "info" : { "author" : "xcode", "version" : 1 } }'
} >"$xc/AppIcon.appiconset/Contents.json"
cp "$iconset/icon_256x256.png" "$xc/Icon.iconset/icon_256x256.png"
cp "$iconset/icon_256x256@2x.png" "$xc/Icon.iconset/icon_256x256@2x.png"
mkdir -p "$work/car"
xcrun actool "$xc" --compile "$work/car" --platform macosx --minimum-deployment-target 12.0 \
  --app-icon AppIcon --output-partial-info-plist "$work/partial.plist" >"$work/actool.log" 2>&1 \
  || { cat "$work/actool.log" >&2; echo "error: actool failed" >&2; exit 1; }
cp "$work/car/Assets.car" "$branding/mac/Assets.car"

echo "== shell logo.ts"
node "$here/build-shell-logo.mjs"
