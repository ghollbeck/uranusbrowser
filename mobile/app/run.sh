#!/usr/bin/env bash
# ./run.sh [simulator|build|device|device-build]
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
mode="${1:-simulator}"
case "$mode" in
  simulator|build|device|device-build) ;;
  *) echo "usage: $0 [simulator|build|device|device-build]" >&2; exit 2 ;;
esac
if [ "${ANUS_BUILD_LOCKED:-}" != "$HERE" ]; then
  exec python3 "$HERE/Tools/build-lock.py" "$@"
fi
DEVICE_NAME="${FLECHA_SIM:-UrAnus Browser}"
xcodegen generate --quiet

if [ "$mode" = device-build ] || [ "$mode" = device ]; then
  team="${ANUS_IOS_TEAM:?set your Apple development team ID}"
  bundle="${ANUS_IOS_BUNDLE_ID:?set a bundle ID owned by your development team}"
  if [ "$mode" = device ]; then
    device="${FLECHA_DEVICE:?set your iPhone name or device ID}"
  fi
  ./Tools/fetch-llama.sh
  sign_extra=()
  if [ "${ANUS_BROWSER_ENTITLEMENT:-}" = 1 ]; then
    sign_extra=(CODE_SIGN_ENTITLEMENTS=Sources/WebBrowser.entitlements 'OTHER_SWIFT_FLAGS=$(inherited) -DANUS_WEB_BROWSER')
  fi
  xcodebuild -project Flecha.xcodeproj -scheme Flecha -configuration Debug -sdk iphoneos \
    -destination 'generic/platform=iOS' -derivedDataPath "$HERE/.build-device" -jobs 2 \
    DEVELOPMENT_TEAM="$team" PRODUCT_BUNDLE_IDENTIFIER="$bundle" ${sign_extra[@]+"${sign_extra[@]}"} build -quiet
  app="$HERE/.build-device/Build/Products/Debug-iphoneos/Flecha.app"
  echo "signed build: $app"
  [ "$mode" = device-build ] && exit 0
  xcrun devicectl device install app --device "$device" "$app"
  xcrun devicectl device process launch --device "$device" "$bundle"
  exit 0
fi

xcodebuild -project Flecha.xcodeproj -scheme Flecha -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$HERE/.build" \
  CODE_SIGNING_ALLOWED=NO -jobs 2 build -quiet
[ "$mode" = build ] && exit 0

UDID=$(xcrun simctl list devices | grep -F "$DEVICE_NAME (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/' || true)
if [ -z "$UDID" ]; then
  UDID=$(xcrun simctl create "$DEVICE_NAME" "iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-26-5)
fi
xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator --args -CurrentDeviceUDID "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null

APP="$HERE/.build/Build/Products/Debug-iphonesimulator/Flecha.app"
BUNDLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" "$BUNDLE"
echo "running on $DEVICE_NAME ($UDID)"
