#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# run-harness.sh <name> [timeout]: run tools/rawcheck/harness/<name>/script.txt in the
# export worktree's ScummVM (muted, via tools/scummvm-harness/run.sh). The run's files
# (out.log, and whatever the script writes to @DIR@) end up in $RUNS/<name>.
set -e
NAME=${1:?usage: run-harness.sh <name> [timeout]}
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=${SCUMMVM_TREE:-$HOME/pcode/scummvm-export}
RUNS=${RUNS:-$HOME/pcode/unity-raw/runs}
grep -q HARNESS_HOOK "$TREE/engines/unity/console.cpp" || {
	echo "run-harness.sh: the hooks are off: sh tools/scummvm-harness/toggle.sh on, then make" >&2
	exit 1
}
mkdir -p "$RUNS"
rm -rf "${RUNS:?}/${NAME:?}"
cp -R "$HERE/harness/$NAME" "$RUNS/$NAME"
SCUMMVM_TREE=$TREE sh "$HERE/../scummvm-harness/run.sh" "$RUNS/$NAME" "${2:-300}"
tail -1 "$RUNS/$NAME/out.log"
