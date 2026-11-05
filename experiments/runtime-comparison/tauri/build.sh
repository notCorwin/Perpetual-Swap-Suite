#!/bin/sh
set -eu

shell_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$shell_dir/../../.." && pwd)
export CARGO_TARGET_DIR="$repo_root/artifacts/runtime-comparison/tauri-target"
cargo build --manifest-path "$shell_dir/Cargo.toml" --release --locked
printf 'Executable: %s\n' "$CARGO_TARGET_DIR/release/radar-tauri-compare"
