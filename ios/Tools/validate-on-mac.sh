#!/bin/bash
set -euo pipefail
ios_root="$(cd "$(dirname "$0")/.." && pwd)"
validation_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-pocket-ios-check.XXXXXX")"
trap 'rm -f "$validation_dir/relay-address-tests"; rmdir "$validation_dir"' EXIT
xcodebuild -version
plutil -lint "$ios_root/Info.plist" "$ios_root/AgentPocket.xcodeproj/project.pbxproj"
xcrun swiftc -warnings-as-errors "$ios_root/Sources/RelayAddress.swift" \
  "$ios_root/Tests/RelayAddressTests.swift" -o "$validation_dir/relay-address-tests"
"$validation_dir/relay-address-tests"
xcodebuild -project "$ios_root/AgentPocket.xcodeproj" -scheme AgentPocket \
  -configuration Debug -destination 'generic/platform=iOS' -sdk iphoneos \
  -derivedDataPath "$ios_root/build/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  SWIFT_TREAT_WARNINGS_AS_ERRORS=YES build
printf '\nUnsigned app: %s\n' "$ios_root/build/DerivedData/Build/Products/Debug-iphoneos/AgentPocket.app"

