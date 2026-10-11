#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."

research_test_directory="$(mktemp -d "${TMPDIR:-/tmp}/perp-radar-tests.XXXXXX")"
research_test_channel="$(uuidgen)"
trap 'rm -rf "$research_test_directory"; /usr/bin/defaults delete "RadarServiceTests.$research_test_channel" >/dev/null 2>&1 || true' EXIT
PERPETUAL_RADAR_BACKGROUND=1 PERPETUAL_RADAR_TEST_CHANNEL="$research_test_channel" PERPETUAL_RADAR_TEST_DIRECTORY="$research_test_directory" swift test "$@"
