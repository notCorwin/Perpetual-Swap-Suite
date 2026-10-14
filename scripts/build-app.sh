#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."

if [[ "${1:-}" != "--prebuilt" ]]; then
  npm run build
  scripts/build-native.sh
fi
[[ -s dist/index.html && -x .build/release/PerpetualRadar ]]

app="$PWD/.build/app/Perpetual Swap Suite.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp ".build/release/PerpetualRadar" "$app/Contents/MacOS/PerpetualRadar"
cp macos/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
scripts/build-icons.sh
compiled="$PWD/.build/icon-assets/compiled"
cp "$compiled/Assets.car" "$app/Contents/Resources/Assets.car"
rm -rf "$app/Contents/Resources/Web"
ditto dist "$app/Contents/Resources/Web"
cp macos/Info.plist "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
helper="$app/Contents/Library/LoginItems/Perpetual Swap Suite Monitor.app"
mkdir -p "$helper/Contents/MacOS" "$helper/Contents/Resources"
cp ".build/release/PerpetualRadar" "$helper/Contents/MacOS/PerpetualRadar"
cp macos/AppIcon.icns "$helper/Contents/Resources/AppIcon.icns"
cp macos/Monitor-Info.plist "$helper/Contents/Info.plist"
printf 'APPL????' > "$helper/Contents/PkgInfo"
revision="${APP_REVISION:-$(git rev-parse HEAD 2>/dev/null || true)}"
if [[ -n "$revision" ]]; then
  /usr/libexec/PlistBuddy -c "Add :CFBundleSourceRevision string $revision" "$app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleSourceRevision string $revision" "$helper/Contents/Info.plist"
  commit_date="${APP_COMMIT_DATE:-$(TZ=UTC git show -s --date=format-local:'%Y-%m-%dT%H:%M:%SZ' --format=%cd "$revision" 2>/dev/null || true)}"
  if [[ -n "$commit_date" ]]; then
    /usr/libexec/PlistBuddy -c "Add :CFBundleSourceCommitDate string $commit_date" "$app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Add :CFBundleSourceCommitDate string $commit_date" "$helper/Contents/Info.plist"
  fi
  build_number="${APP_BUILD_NUMBER:-$(git rev-list --count "$revision" 2>/dev/null || true)}"
  if [[ "$build_number" == <-> ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$helper/Contents/Info.plist"
  fi
fi
codesign --force --sign - "$helper" >/dev/null
codesign --force --sign - "$app" >/dev/null
codesign --verify --deep --strict "$app"
touch "$app"
if [[ -z "${CI:-}" ]]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
fi
echo "$app"
