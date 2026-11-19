#!/usr/bin/env bash
# Day-file parity check: synthetic sessions -> Dhan-like rolling ATM+-10 store -> day files ->
# browser decoder -> engines. Results must equal running the engines on the original sessions.
# Run from the repository root with the Python package installed: bash tools/dayfile_parity/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
node "$here/gen.js" "$tmp"
python "$here/mkstore.py" "$tmp/store" "$tmp/rows.json"
STRADDLOOP_HOME="$tmp" straddloop export-days --start 2025-10-01 --end 2025-10-31
node "$here/parity.js" "$tmp"
rm -rf "$tmp"
