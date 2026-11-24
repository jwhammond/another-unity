#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# combat-parity.sh <label> <difficulty> <cap> [battle...]: fight each battle (every battle with an Enterprise, if none
# is named) in the export worktree's ScummVM, traced and muted, one run at a time under the harness lock; replay each
# in the port and compare (docs/tracediff.md, "Space combat"). INPUTS=<file> plays a scripted battle's `at` lines.
# A label is one whole run: its directory, $RUNS/combat-parity/<label>, is cleared first. Each battle's files land in
# its b<battle>: script.txt, trace.jsonl, out.log, port.jsonl, report.md; its lines in summary.txt, which always ends
# with the count of each outcome: clean, differs, problems (no script, or a trace tracediff couldn't compare, said
# why), and ScummVM didn't finish (never diffed as a difference). Exits 1 if any battle differs or has problems, else
# 2 if ScummVM didn't finish one, else 0; 2 for a bad command line, with nothing run.
set -e
USAGE="usage: combat-parity.sh <label> <difficulty 0-2> <cap> [battle...]"
bad() {
	echo "combat-parity.sh: $1" >&2
	echo "$USAGE" >&2
	exit 2
}
[ $# -ge 3 ] || bad "a label, a difficulty and a cap, then any battles"
LABEL=$1 DIFFICULTY=$2 CAP=$3
shift 3
# (a label is a directory name under $RUNS/combat-parity, so it can't climb out of it)
case $LABEL in ""|.|..|*[!A-Za-z0-9._-]*) bad "the label must be letters, digits, '.', '_' or '-': \"$LABEL\"" ;; esac
case $DIFFICULTY in 0|1|2) ;; *) bad "the difficulty must be 0, 1 or 2: \"$DIFFICULTY\"" ;; esac
case $CAP in ''|*[!0-9]*) bad "the cap must be a number of steps: \"$CAP\"" ;; esac
for B in "$@"; do
	case $B in ''|*[!0-9]*) bad "a battle must be a battle's number (tracediff combat-battles lists them): \"$B\"" ;; esac
done
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
# (the inputs file as the caller named it, then everything from the repo's root)
[ -z "$INPUTS" ] || INPUTS=$(cd "$(dirname "$INPUTS")" && pwd)/$(basename "$INPUTS")
cd "$ROOT"
TREE=${SCUMMVM_TREE:-$HOME/pcode/scummvm-export}
RUNS=${RUNS:-$HOME/pcode/unity-raw/runs}
GAME=$ROOT/games/unity
td() {
	npx tsx "$ROOT/tools/tracediff/src/main.ts" "$@"
}
grep -q HARNESS_HOOK "$TREE/engines/unity/console.cpp" || {
	echo "combat-parity.sh: the hooks are off: sh tools/scummvm-harness/toggle.sh on, then make" >&2
	exit 1
}
# (a binary built before the hooks went in, or kept by make across a toggle, has none: only the hooked unity.cpp
# names the unity_skip_intro option, so the binary carries that string when its hooks were compiled in)
grep -aq unity_skip_intro "$TREE/scummvm" || {
	echo "combat-parity.sh: $TREE/scummvm was built without the hooks: cd $TREE && make" >&2
	exit 1
}
# (the run's directory is cleared, so only under the traces' own directory)
mkdir -p "$RUNS"
RUNS=$(cd "$RUNS" && pwd -P)
case $RUNS/ in
"$(cd "$HOME/pcode/unity-raw/runs" 2>/dev/null && pwd -P)"/*) ;;
*)
	echo "combat-parity.sh: RUNS must be ~/pcode/unity-raw/runs or under it: $RUNS" >&2
	exit 2
	;;
esac
OUT=$RUNS/combat-parity/$LABEL
rm -rf "${RUNS:?}/combat-parity/${LABEL:?}"
mkdir -p "$OUT"
: > "$OUT/summary.txt"
if [ $# -gt 0 ]; then
	BATTLES=$*
elif ! BATTLES=$(td combat-battles --game "$GAME" 2>&1); then
	printf '%s\n' "$BATTLES" "combat-parity.sh $LABEL: tracediff combat-battles failed: no battle fought" >> "$OUT/summary.txt"
	cat "$OUT/summary.txt"
	exit 1
fi
CLEAN=0 DIFFER=0 PROBLEMS=0 UNFINISHED=0
for B in $BATTLES; do
	D=$OUT/b$B
	rm -rf "${D:?}"
	mkdir -p "$D"
	if ! td combat-script --game "$GAME" --battle "$B" --difficulty "$DIFFICULTY" --seed $((7000 + B)) --cap "$CAP" ${INPUTS:+--inputs "$INPUTS"} --out "$D/script.txt"; then
		echo "battle $B: problems: no script" >> "$OUT/summary.txt"
		PROBLEMS=$((PROBLEMS + 1))
		continue
	fi
	# (run.sh's exit isn't the run's: its watchdog's kill fails once a killed run is gone; out.log says how it went)
	SCUMMVM_TREE=$TREE sh "$ROOT/tools/scummvm-harness/run.sh" "$D" 1800 > /dev/null || true
	if ! tail -1 "$D/out.log" 2>/dev/null | grep -qx 'exit=0' || grep -q '^HARNESS: killed' "$D/out.log"; then
		echo "battle $B: ScummVM didn't finish ($(tail -1 "$D/out.log" 2>/dev/null || echo 'no out.log'))" >> "$OUT/summary.txt"
		UNFINISHED=$((UNFINISHED + 1))
		continue
	fi
	# (tracediff combat's exit: 0 CLEAN; 1 DIFFERS or PROBLEMS; 2 DIDN'T FINISH, or a trace it couldn't compare;
	# its stderr too, so a crash's reason lands in the summary)
	RC=0
	RESULT=$(td combat --game "$GAME" --scummvm "$D/trace.jsonl" --out "$D/port.jsonl" --report "$D/report.md" 2>&1) || RC=$?
	printf '%s\n' "$RESULT" >> "$OUT/summary.txt"
	# (the verdict is the line's; output with none, a crash's stack, is problems, and says so)
	V=$(printf '%s\n' "$RESULT" | sed -nE "s/^tracediff combat: battle [0-9]+: (CLEAN|DIFFERS|PROBLEMS|DIDN'T FINISH).*/\1/p" | head -1)
	if [ "$RC" -eq 0 ] && [ "$V" = CLEAN ]; then
		CLEAN=$((CLEAN + 1))
	elif [ "$V" = DIFFERS ]; then
		DIFFER=$((DIFFER + 1))
	elif [ "$V" = "DIDN'T FINISH" ]; then
		UNFINISHED=$((UNFINISHED + 1))
	elif [ "$V" = PROBLEMS ]; then
		PROBLEMS=$((PROBLEMS + 1))
	else
		echo "battle $B: problems: tracediff combat gave no verdict (exit $RC)${RESULT:+; its output is above}" >> "$OUT/summary.txt"
		PROBLEMS=$((PROBLEMS + 1))
	fi
done
echo "combat-parity.sh $LABEL: $CLEAN clean, $DIFFER differ, $PROBLEMS with problems, $UNFINISHED ScummVM didn't finish" >> "$OUT/summary.txt"
cat "$OUT/summary.txt"
[ $((DIFFER + PROBLEMS)) -eq 0 ] || exit 1
[ "$UNFINISHED" -eq 0 ] || exit 2
exit 0
