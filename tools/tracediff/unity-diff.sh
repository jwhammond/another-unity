#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# unity-diff.sh <walk file> [seed]: play a walkthrough in ScummVM and in the TypeScript engine, then diff
# the traces. Everything lands in $RUNS/tracediff-<walk file's name>: trace.jsonl, ts.jsonl, report.md.
set -e
WALK=${1:?usage: unity-diff.sh <walk file> [seed]}
SEED=${2:-42}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
RUNS=${RUNS:-$HOME/pcode/unity-raw/runs}
D=$RUNS/tracediff-$(basename "$WALK" .walk)
sh "$HERE/run-scummvm.sh" "$WALK" "$SEED"
cd "$ROOT"
# (a walkthrough that stops at an error is still diffed: the error is part of the comparison)
npx tsx tools/tracediff/src/main.ts run --game games/unity --walk "$WALK" --seed "$SEED" --out "$D/ts.jsonl" || true
npx tsx tools/tracediff/src/main.ts diff --game games/unity --scummvm "$D/trace.jsonl" --ts "$D/ts.jsonl" --out "$D/report.md"
