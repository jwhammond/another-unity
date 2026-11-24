#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# run-scummvm.sh <walk file> [seed] [timeout]: play a walkthrough in the export worktree's ScummVM,
# traced and muted (tools/scummvm-harness/run.sh). The run's files (trace.jsonl, out.log) end up in
# $RUNS/tracediff-<walk file's name>.
set -e
WALK=${1:?usage: run-scummvm.sh <walk file> [seed] [timeout]}
SEED=${2:-42}
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=${SCUMMVM_TREE:-$HOME/pcode/scummvm-export}
RUNS=${RUNS:-$HOME/pcode/unity-raw/runs}
grep -q HARNESS_HOOK "$TREE/engines/unity/console.cpp" || {
	echo "run-scummvm.sh: the hooks are off: sh tools/scummvm-harness/toggle.sh on, then make" >&2
	exit 1
}
D=$RUNS/tracediff-$(basename "$WALK" .walk)
rm -rf "${D:?}"
mkdir -p "$D"
cp "$WALK" "$D/walk.txt"
{
	# the ship's triggers a new game has enabled, as tools/rawcheck/harness/walk turns them off
	# (tools/tracediff/src/preamble.ts keeps the TypeScript side's list; preamble.test.ts checks both)
	for t in 0x10 3 0x13 0x14 0x15 0x40 0x4a; do echo "trigger $t off"; done
	echo "trace @DIR@/trace.jsonl $SEED"
	echo "walkthrough @DIR@/walk.txt quit"
	echo "wait 3600000"
} > "$D/script.txt"
SCUMMVM_TREE=$TREE sh "$HERE/../scummvm-harness/run.sh" "$D" "${3:-1800}"
tail -1 "$D/out.log"
