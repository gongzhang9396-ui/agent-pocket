#!/bin/bash
set -euo pipefail
umask 077
ap_mobile=$(cd "$(dirname "$0")/.." && pwd)
ap_flutter=${POCKET_FLUTTER_SDK:-"$HOME/AgentPocketTools/Flutter-3.44.4"}
: "${POCKET_IOS_TEAM:?Set the existing authorized Apple development team}"
: "${POCKET_IOS_BUNDLE_ID:?Set a distinct Bundle ID for the Flutter test app}"
: "${POCKET_IOS_DEVICE_UDID:?Set the authorized target iPhone UDID}"
: "${POCKET_RELAY_ORIGIN:?Set the existing Relay HTTPS origin}"
python3 - <<'PY'
import os, re
from urllib.parse import urlsplit
def require(value, label):
    if not value:
        raise SystemExit('Invalid build input: ' + label)
require(re.fullmatch(r'[A-Z0-9]{10}', os.environ['POCKET_IOS_TEAM']), 'team')
bundle = os.environ['POCKET_IOS_BUNDLE_ID']
require(re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', bundle) and len(bundle) <= 255 and
        bundle.endswith('.flutter'), 'distinct Flutter bundle ID')
require(re.fullmatch(r'[A-Fa-f0-9-]{20,64}', os.environ['POCKET_IOS_DEVICE_UDID']), 'target device')
uri = urlsplit(os.environ['POCKET_RELAY_ORIGIN'])
require(uri.scheme == 'https' and uri.hostname and not uri.username and not uri.password and
        uri.path in ('', '/') and not uri.query and not uri.fragment, 'Relay HTTPS origin')
PY
[[ "$(git -C "$ap_flutter" rev-parse HEAD)" == ad70ec4617166f1c38e5d2bfd388af71fda14f06 ]]
export PATH="$ap_flutter/bin:$PATH"
export PUB_CACHE=${POCKET_IOS_PUB_CACHE:-"$HOME/AgentPocketTools/pub-cache"}
mkdir -p "$ap_mobile/build"
ap_job=$(mktemp -d "$ap_mobile/build/ios-candidate.XXXXXX")
printf 'iosCandidateDirectory=%s\n' "$ap_job"
cd "$ap_mobile"
python3 scripts/ios-source-digest.py >"$ap_job/source-before.json"
ap_version=$(python3 -c 'from pathlib import Path;import re;print(re.search(r"^version: ([0-9]+\.[0-9]+\.[0-9]+)\+([0-9]+)",Path("pubspec.yaml").read_text(),re.M).group(1))')
ap_build=$(python3 -c 'from pathlib import Path;import re;print(re.search(r"^version: ([0-9]+\.[0-9]+\.[0-9]+)\+([0-9]+)",Path("pubspec.yaml").read_text(),re.M).group(2))')
flutter --suppress-analytics --no-version-check pub get --enforce-lockfile
flutter --suppress-analytics --no-version-check analyze --no-pub
flutter --suppress-analytics --no-version-check build ios --release --config-only --no-codesign --no-pub \
  --build-name="$ap_version" --build-number="$ap_build"
# A target build does not run the scheme's Flutter framework pre-action.
env FLUTTER_ROOT="$ap_flutter" FLUTTER_APPLICATION_PATH="$ap_mobile" \
  SOURCE_ROOT="$ap_mobile/ios" SRCROOT="$ap_mobile/ios" CONFIGURATION=Release \
  FLUTTER_BUILD_MODE=release ARCHS=arm64 SDKROOT="$(xcrun --sdk iphoneos --show-sdk-path)" \
  BUILT_PRODUCTS_DIR="$ap_job/Products/Release-iphoneos" \
  /bin/sh "$ap_flutter/packages/flutter_tools/bin/xcode_backend.sh" prepare
xcodebuild -project ios/Runner.xcodeproj -target Runner -sdk iphoneos -configuration Release \
  -allowProvisioningUpdates \
  "SYMROOT=$ap_job/Products" "OBJROOT=$ap_job/Intermediates" \
  "DEVELOPMENT_TEAM=$POCKET_IOS_TEAM" "AGENT_POCKET_BUNDLE_ID=$POCKET_IOS_BUNDLE_ID" \
  "AGENT_POCKET_DEFAULT_RELAY_ORIGIN=$POCKET_RELAY_ORIGIN" \
  CODE_SIGN_STYLE=Automatic CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES build
ap_app="$ap_job/Products/Release-iphoneos/Runner.app"
[[ -d "$ap_app/Frameworks/Flutter.framework" && -d "$ap_app/Frameworks/App.framework" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$ap_app/Info.plist")" == "$POCKET_IOS_BUNDLE_ID" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ap_app/Info.plist")" == "$ap_build" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :AgentPocketDefaultRelayOrigin' "$ap_app/Info.plist")" == "$POCKET_RELAY_ORIGIN" ]]
python3 - "$ap_app" <<'PY'
import pathlib, plistlib, subprocess, sys
app = pathlib.Path(sys.argv[1])
frameworks = list((app/'Frameworks').glob('*sodium*.framework'))
if len(frameworks) != 1:
    raise SystemExit('Expected one bundled sodium framework')
framework = frameworks[0]
info = plistlib.loads((framework/'Info.plist').read_bytes())
binary = framework/info['CFBundleExecutable']
architectures = subprocess.check_output(['lipo', '-archs', str(binary)], text=True).split()
if architectures != ['arm64']:
    raise SystemExit('Expected only the iPhone arm64 sodium binary')
symbols = subprocess.check_output(['nm', '-gU', str(binary)], text=True).splitlines()
for required in ['_sodium_init', '_crypto_aead_xchacha20poly1305_ietf_encrypt',
                 '_crypto_aead_xchacha20poly1305_ietf_decrypt']:
    if not any(line.split()[-1:] == [required] for line in symbols):
        raise SystemExit('Bundled sodium is missing ' + required)
print('bundledSodiumArm64AndSymbolsVerified=true')
PY
python3 scripts/ios-source-digest.py >"$ap_job/source-after.json"
python3 - "$ap_job" <<'PY'
import json, pathlib, sys
job = pathlib.Path(sys.argv[1])
before = json.loads((job/'source-before.json').read_text())
after = json.loads((job/'source-after.json').read_text())
if before['sourceDigest'] != after['sourceDigest']:
    old = {item['path']: item['sha256'] for item in before['files']}
    changed = [item['path'] for item in after['files'] if old.get(item['path']) != item['sha256']]
    raise SystemExit('Build tooling changed source inputs. Review before packaging: ' + ', '.join(changed))
PY
python3 "$ap_mobile/../ios/Tools/package-development.py" "$ap_app" \
  --output "$ap_job/Agent-Pocket-Flutter-$ap_version-development.ipa" \
  --device-udid "$POCKET_IOS_DEVICE_UDID" >"$ap_job/signature-verification.json"
cat "$ap_job/signature-verification.json"
printf 'verifiedFlutterAppPath=%s\n' "$ap_app"
printf 'flutterIOSCandidateReady=true\n'
