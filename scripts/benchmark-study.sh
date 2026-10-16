#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."

[[ -n "${1:-}" ]] || { print -u2 'Usage: scripts/benchmark-study.sh STUDY_ID [RESEARCH_DATABASE]'; exit 2; }
study_id="$1"
source_database="${2:-$HOME/Library/Application Support/PerpetualRadar/Research/research.sqlite3}"
scripts/build-native.sh
snapshot_directory="$(mktemp -d "$PWD/.build/study-benchmark.XXXXXX")"

# SQLite backup includes committed WAL pages and remains consistent while the
# installed application runs. The shipping worker writes only to this snapshot.
python3 - "$source_database" "$snapshot_directory/research.sqlite3" <<'PY'
import pathlib, sqlite3, sys
source = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination, pages=8192)
finally:
    destination.close()
    source.close()
PY

print "Benchmark snapshot: $snapshot_directory"
PERPETUAL_RADAR_BACKGROUND=1 NSUnbufferedIO=YES caffeinate -i .build/release/PerpetualRadar --study-benchmark "$snapshot_directory" "$study_id"
