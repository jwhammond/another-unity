#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# run.sh <dir> [timeout]: run harness script <dir>/script.txt in the export worktree's
# ScummVM, muted, logging to <dir>/out.log. From ~/pcode/unity-tools/run.sh.
HERE=$(cd "$(dirname "$0")" && pwd)
# (one ScummVM at a time: every run takes the harness lock first, and waits for it)
LOCK=${HARNESS_LOCK:-$HOME/pcode/unity-raw/runs/.harness.lock}
if [ -z "$HARNESS_LOCKED" ]; then
	mkdir -p "$(dirname "$LOCK")"
	HARNESS_LOCKED=1 exec /usr/bin/lockf -k "$LOCK" sh "$0" "$@"
fi
INI=${HARNESS_INI:-$HERE/harness.ini}
if ! grep -qx 'mute=true' "$INI"; then
	echo "run.sh: $INI must have mute=true" >&2
	exit 1
fi
D=$1; T=${2:-120}
D=$(cd "$D" && pwd)
sed "s|@DIR@|$D|g" "$D/script.txt" > "$D/script.run"
mkdir -p "${SAVEDIR:=$D/saves}"
sed -e "s|^unity_script=.*|unity_script=$D/script.run|" -e "s|^savepath=.*|savepath=$SAVEDIR|" "$INI" > "$D/harness.ini"
grep -qx 'mute=true' "$D/harness.ini" || { echo "run.sh: the run's ini lost mute=true" >&2; exit 1; }
cd "${SCUMMVM_TREE:-$HOME/pcode/scummvm-export}"
export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ASAN_OPTIONS=halt_on_error=1
./scummvm --config="$D/harness.ini" --path="${GAMEPATH:-$HOME/pcode/unity-gamedata/cd}" --auto-detect $SCUMMVM_ARGS -d 1 > "$D/out.log" 2>&1 &
PID=$!
# (a run killed at the timeout says so before its exit line: ScummVM exits 0 on SIGTERM too)
rm -f "$D/timedout"
( sleep "$T"; touch "$D/timedout"; kill -TERM $PID 2>/dev/null; sleep 3; kill -9 $PID 2>/dev/null ) &
W=$!
wait $PID
STATUS=$?
[ -e "$D/timedout" ] && echo "HARNESS: killed at the ${T}s timeout" >> "$D/out.log"
echo "exit=$STATUS" >> "$D/out.log"
kill $W 2>/dev/null
