#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# shots.sh <label> <battle>...: the screenshot check (M8 spec §9.3; docs/unity-local.md). For each battle: the views'
# inputs and shots in a harness script (tracediff combat-script, combatshots script), ScummVM's run of it (run.sh: its
# lock, muted), the shots it took and the battle each shows replayed in the port (tracediff combat-states); then the
# port's screens of those states in the parity mode (Playwright, unity-combat-shots.spec.ts, E2E_PORT, default 5292) and
# the comparison (combatshots compare). Everything lands in $RUNS/combatshots/<label>/b<battle>: report.md and sheet.png
# are for the user's eye, local only. A battle that can't be scripted, shot or replayed is said and skipped, and the
# rest go on. Exits 1 if a shot differs or is missing or a battle was skipped, 2 for a bad command line.
set -e
[ $# -ge 2 ] || { echo "usage: shots.sh <label> <battle>..." >&2; exit 2; }
LABEL=$1
shift
case $LABEL in ""|.|..|*[!A-Za-z0-9._-]*) echo "shots.sh: the label must be letters, digits, '.', '_' or '-'" >&2; exit 2 ;; esac
for B in "$@"; do case $B in ''|*[!0-9]*) echo "shots.sh: a battle is a number: \"$B\"" >&2; exit 2 ;; esac; done
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
TREE=${SCUMMVM_TREE:-$HOME/pcode/scummvm-export}
RUNS=${RUNS:-$HOME/pcode/unity-raw/runs}
GAME=$ROOT/games/unity
OUT=$RUNS/combatshots/$LABEL
td() { npx tsx "$ROOT/tools/tracediff/src/main.ts" "$@"; }
cs() { npx tsx "$ROOT/tools/combatshots/src/cli.ts" "$@"; }
grep -aq unity_skip_intro "$TREE/scummvm" || { echo "shots.sh: $TREE/scummvm was built without the harness hooks: toggle.sh on, then make" >&2; exit 1; }
rm -rf "${OUT:?}"
mkdir -p "$OUT"
FAILED=0
for B in "$@"; do
	D=$OUT/b$B
	mkdir -p "$D"
	# (a battle tracediff won't script, as one with no Enterprise, is skipped: the others still run and compare)
	if ! { cs inputs > "$D/views.inputs" &&
		td combat-script --game "$GAME" --battle "$B" --difficulty 1 --seed $((7000 + B)) --cap 130 --inputs "$D/views.inputs" --out "$D/script.base" &&
		cs script --in "$D/script.base" --out "$D/script.txt"; }; then
		echo "shots.sh: battle $B: no harness script (see above): skipped" >&2
		FAILED=1
		continue
	fi
	# (run.sh's exit isn't the run's; its stderr is never piped)
	SCUMMVM_TREE=$TREE sh "$ROOT/tools/scummvm-harness/run.sh" "$D" 600 > /dev/null || true
	STEPS=$(cs shots --dir "$D") || { echo "battle $B: no shots (see $D/out.log)"; FAILED=1; continue; }
	# (without every state its shots show, the port can't draw them: the battle is skipped, its shots.json put aside)
	if ! td combat-states --game "$GAME" --scummvm "$D/trace.jsonl" --steps "$STEPS" --out "$D"; then
		echo "shots.sh: battle $B: its states weren't all replayed: skipped" >&2
		mv "$D/shots.json" "$D/shots.skipped.json"
		FAILED=1
	fi
done
E2E_PORT=${E2E_PORT:-5292} COMBATSHOTS_DIR=$OUT COMBATSHOTS_ART=${COMBATSHOTS_ART:-} npm run e2e -- unity-combat-shots.spec.ts || FAILED=1
for B in "$@"; do
	[ -f "$OUT/b$B/shots.json" ] || continue
	# (COMBATSHOTS_ART=1: the port's side with the art on, its console judged by lining up alone: Plan 30 R17)
	cs compare --dir "$OUT/b$B" ${COMBATSHOTS_ART:+--art} || FAILED=1
done
exit $FAILED
