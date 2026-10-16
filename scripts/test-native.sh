#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."

research_test_directory="$(mktemp -d "${TMPDIR:-/tmp}/perp-radar-tests.XXXXXX")"
research_test_directory="${research_test_directory:a}"
research_test_channel="$(uuidgen)"
cleanup() {
  trap '' INT TERM
  # LaunchServices can detach lifecycle children from xctest's process group.
  # Match only this invocation's private app paths, including after a timeout.
  # Graceful UI termination can start/reconnect a helper while shutting down.
  # Rescan before escalation, and keep bundles until every child is stopped.
  for signal in TERM TERM KILL; do
    local pids=($(ps -axo pid=,comm= | awk -v root="$research_test_directory/" 'index($0, root) { print $1 }'))
    (( ${#pids} )) || break
    kill -"$signal" "${pids[@]}" 2>/dev/null || true
    [[ "$signal" == KILL ]] || sleep 0.1
  done
  for domain in "$research_test_channel" "${research_test_directory}"/*(N:t); do
    /usr/bin/defaults delete "RadarServiceTests.$domain" >/dev/null 2>&1 || true
  done
  rm -rf "$research_test_directory"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export PERPETUAL_RADAR_BACKGROUND=1 PERPETUAL_RADAR_TEST_CHANNEL="$research_test_channel" PERPETUAL_RADAR_TEST_DIRECTORY="$research_test_directory" NSUnbufferedIO=YES
if [[ "${1:-}" == "--xctest" ]]; then
  shift
  xcrun xctest "$@" .build/release/PerpetualRadarPackageTests.xctest &
else
  swift test "$@" &
fi
wait $!
