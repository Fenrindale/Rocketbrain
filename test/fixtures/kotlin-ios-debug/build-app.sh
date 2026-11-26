#!/usr/bin/env bash
set -euo pipefail

fixture="$(cd "$(dirname "$0")" && pwd -P)"
output="${1:?select a fresh workspace test-output path}"
app="$output/RocketbrainIosFixture.app"
framework="$fixture/build/bin/iosSimulatorArm64/debugFramework/RocketbrainProbe.framework"
dsym="$output/RocketbrainProbe.framework.dSYM"
test -f "$framework/RocketbrainProbe"
test -f "$framework/Headers/RocketbrainProbe.h"
test ! -e "$output"
mkdir -p "$app/Frameworks"
cp "$fixture/Info.plist" "$app/Info.plist"
cp -R "$framework" "$app/Frameworks/"
xcrun --sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=17.0 -g -O0 -fobjc-arc \
  -F "$(dirname "$framework")" -framework UIKit -framework RocketbrainProbe \
  -Wl,-rpath,@executable_path/Frameworks "$fixture/main.m" -o "$app/RocketbrainIosFixture"
if test -d "$framework.dSYM"; then
  cp -R "$framework.dSYM" "$dsym"
else
  xcrun dsymutil "$framework/RocketbrainProbe" -o "$dsym"
fi
test -s "$dsym/Contents/Resources/DWARF/RocketbrainProbe"
codesign --force --sign - "$app/Frameworks/RocketbrainProbe.framework"
codesign --force --sign - --entitlements "$fixture/Debug.plist" "$app"
codesign --verify --deep "$app"
xcrun dwarfdump --uuid "$app/Frameworks/RocketbrainProbe.framework/RocketbrainProbe"
xcrun dwarfdump --uuid "$dsym/Contents/Resources/DWARF/RocketbrainProbe"
