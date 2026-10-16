#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
npm run build
# electron-builder is responsible for distribution signing when CI provides a
# notarized Developer ID identity (CSC_LINK / CSC_KEY_PASSWORD). Local builds
# stay ad-hoc signed; manually re-signing Electron Framework with an Apple
# Development identity invalidates its bundled dylib signatures.
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never
app="dist/mac-arm64/Perpetual Swap Suite.app"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
echo "$app"
