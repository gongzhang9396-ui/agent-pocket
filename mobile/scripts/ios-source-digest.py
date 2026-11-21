"""Fingerprint the handwritten Flutter/iOS inputs, excluding generated tooling."""
import hashlib
import json
from pathlib import Path

mobile = Path(__file__).resolve().parent.parent
paths = []
for folder in ['lib', 'assets', 'ios/Runner', 'ios/RunnerTests']:
    for path in (mobile / folder).rglob('*'):
        if path.is_symlink():
            raise SystemExit('iOS source cannot contain symbolic links')
        if path.is_file() and not path.name.startswith('GeneratedPluginRegistrant.'):
            paths.append(path)
for name in ['pubspec.yaml', 'pubspec.lock', 'ios/Runner.xcodeproj/project.pbxproj',
             'ios/Runner.xcodeproj/xcshareddata/xcschemes/Runner.xcscheme',
             'ios/Runner.xcworkspace/contents.xcworkspacedata',
             'ios/Flutter/Debug.xcconfig', 'ios/Flutter/Release.xcconfig',
             'ios/Flutter/AppFrameworkInfo.plist', 'scripts/build-ios-on-mac.sh',
             'scripts/ios-source-digest.py']:
    paths.append(mobile / name)
inventory = []
for path in paths:
    if path.is_symlink() or not path.is_file():
        raise SystemExit('A required iOS source file is absent or is a link')
    inventory.append({'path': path.relative_to(mobile).as_posix(),
                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
verifier = mobile.parent / 'ios/Tools/package-development.py'
if verifier.is_symlink() or not verifier.is_file():
    raise SystemExit('The existing development-signature verifier is required')
inventory.append({'path': '../ios/Tools/package-development.py',
                  'sha256': hashlib.sha256(verifier.read_bytes()).hexdigest()})
inventory.sort(key=lambda entry: entry['path'])
data = ''.join(entry['sha256'] + '  ' + entry['path'] + '\n' for entry in inventory)
print(json.dumps({'sourceDigest': hashlib.sha256(data.encode()).hexdigest(), 'files': inventory}, indent=2))
