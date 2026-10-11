#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."

# Asset compilation is a normal incremental build: invalidate on either input
# or the selected asset compiler changing, never on an unrelated test edit.
compiled="$PWD/.build/icon-assets/compiled"
fingerprint="$(shasum scripts/build-icons.sh macos/AppIcon.icns macos/AppIconContents.json "$(xcrun --find actool)")"
if [[ -s "$compiled/Assets.car" && -f "$compiled/inputs.sha" && "$(cat "$compiled/inputs.sha")" == "$fingerprint" ]]; then
  exit 0
fi
iconset="$PWD/.build/icon-assets/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$iconset"
iconutil -c iconset macos/AppIcon.icns -o "$PWD/.build/icon-assets/AppIcon.iconset"
cp "$PWD/.build/icon-assets/AppIcon.iconset/"*.png "$iconset/"
cp macos/AppIconContents.json "$iconset/Contents.json"
mkdir -p "$compiled"
xcrun actool --compile "$compiled" --platform macosx --minimum-deployment-target 14.0 --app-icon AppIcon --output-partial-info-plist "$PWD/.build/icon-assets/Info.plist" "$PWD/.build/icon-assets/Assets.xcassets"

printf '%s\n' "$fingerprint" > "$compiled/inputs.sha"
