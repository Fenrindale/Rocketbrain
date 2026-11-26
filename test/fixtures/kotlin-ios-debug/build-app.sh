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
mkdir -p "$output"
xcrun xcodebuild -project "$fixture/Fixture.xcodeproj" -target RocketbrainIosFixture \
  -sdk iphonesimulator -configuration Debug \
  "BUILD_DIR=$output" "CONFIGURATION_BUILD_DIR=$output" "OBJROOT=$output/intermediates" build
test -x "$app/RocketbrainIosFixture"
test -f "$app/Frameworks/RocketbrainProbe.framework/RocketbrainProbe"
if test -d "$framework.dSYM"; then
  cp -R "$framework.dSYM" "$dsym"
else
  xcrun dsymutil "$framework/RocketbrainProbe" -o "$dsym"
fi
test -s "$dsym/Contents/Resources/DWARF/RocketbrainProbe"
codesign --verify --deep "$app"
xcrun --sdk iphonesimulator vtool -show-build "$app/RocketbrainIosFixture"
/usr/libexec/PlistBuddy -c 'Print :CFBundleSupportedPlatforms:0' "$app/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$app/Info.plist"
codesign -d --entitlements :- "$app"
xcrun dwarfdump --uuid "$app/Frameworks/RocketbrainProbe.framework/RocketbrainProbe"
xcrun dwarfdump --uuid "$dsym/Contents/Resources/DWARF/RocketbrainProbe"
xcrun dwarfdump --debug-line "$dsym/Contents/Resources/DWARF/RocketbrainProbe" \
  | awk '/Probe\.kt/ { if (++found <= 15) print "Reviewed DWARF line file: " $0 } END { if (!found) exit 1 }'
