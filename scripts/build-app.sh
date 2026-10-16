#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."

if [[ "${1:-}" != "--prebuilt" ]]; then
  npm run build
  scripts/build-native.sh
fi

[[ -s dist/index.html && -x .build/release/PerpetualSwapSuite ]]
app="$PWD/.build/app/Perpetual Swap Suite.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp .build/release/PerpetualSwapSuite "$app/Contents/MacOS/PerpetualSwapSuite"
cp macos/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
ditto dist "$app/Contents/Resources/Web"
cp macos/Info.plist "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

revision="${APP_REVISION:-$(git rev-parse HEAD 2>/dev/null || true)}"
if [[ -n "$revision" ]]; then
  /usr/libexec/PlistBuddy -c "Add :CFBundleSourceRevision string $revision" "$app/Contents/Info.plist"
fi

codesign --force --sign - "$app" >/dev/null
codesign --verify --deep --strict "$app"
touch "$app"
echo "$app"
