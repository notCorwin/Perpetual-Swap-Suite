#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
npm run build
# Use a reproducible ad-hoc signature locally. Release signing/notarization is
# configured by CI credentials rather than a developer-machine certificate.
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never
app="dist/mac-arm64/Perpetual Swap Suite.app"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
echo "$app"
