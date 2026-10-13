#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."

# Per-file optimization keeps release builds incremental. Local CI passes
# --build-tests to share the same shipping executable with its test harness.
swift build -c release -Xswiftc -no-whole-module-optimization -Xswiftc -enable-testing "$@"
