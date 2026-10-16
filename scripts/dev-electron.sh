#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
npm run dev:renderer &
vite_pid=$!
cleanup() { kill "$vite_pid" 2>/dev/null || true }
trap cleanup EXIT INT TERM
until curl --silent --fail http://127.0.0.1:5173 >/dev/null; do sleep 0.2; done
ELECTRON_RENDERER_URL=http://127.0.0.1:5173 npx electron .
