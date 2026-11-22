#!/bin/sh
set -eu

shell_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${CARGO_TARGET_DIR:?Set CARGO_TARGET_DIR explicitly or run build.mjs with --output <directory>.}"
export CARGO_TARGET_DIR
cargo build --manifest-path "$shell_dir/Cargo.toml" --release --locked
printf 'Executable: %s\n' "$CARGO_TARGET_DIR/release/radar-tauri-compare"
