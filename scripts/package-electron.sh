#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/package-electron.mjs "$@"
