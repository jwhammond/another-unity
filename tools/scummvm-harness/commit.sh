#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# commit.sh "<subject>" "<body>" <file>...: commit named files in the export worktree with
# the harness hooks off and a clean build; then turn the hooks back on and rebuild.
# (If it stops part way, the hooks may be off: run toggle.sh on, then make.)
set -e
# (the harness lock, as run.sh takes it: no commit's toggles and rebuild under a running ScummVM; commit.sh runs
# no harness run itself, and a run.sh under it would see HARNESS_LOCKED and not wait on this lock. Taken before the
# arguments are read, so the locked re-run gets all of them)
LOCK=${HARNESS_LOCK:-$HOME/pcode/unity-raw/runs/.harness.lock}
if [ -z "$HARNESS_LOCKED" ]; then
	mkdir -p "$(dirname "$LOCK")"
	HARNESS_LOCKED=1 exec /usr/bin/lockf -k "$LOCK" sh "$0" "$@"
fi
SUBJECT=${1:?usage: commit.sh "<subject>" "<body>" <file>...}
BODY=$2
shift 2
[ $# -gt 0 ] || { echo "commit.sh: name the files to commit" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=${SCUMMVM_TREE:-$HOME/pcode/scummvm-export}
LOG=$(mktemp)
cd "$TREE"
git diff --cached --quiet || { echo "commit.sh: the index is not empty" >&2; exit 1; }

sh "$HERE/toggle.sh" off
make -j8 > "$LOG" 2>&1 || { tail -30 "$LOG"; echo "commit.sh: the build failed" >&2; exit 1; }
# (the linker's "built for newer version" notes about homebrew dylibs are not build warnings)
if grep -E "error|warning:" "$LOG" | grep -v "^ld: warning: building for macOS"; then
	echo "commit.sh: the build has errors or warnings" >&2
	exit 1
fi
git add -- "$@"
if git diff --cached | grep -q HARNESS_HOOK; then
	echo "commit.sh: a harness hook is staged" >&2
	exit 1
fi
# (the trailer names the model that made the change: MODEL, e.g. claude-opus-5-5; Plan 18's follow-up)
TRAILER="Assisted-by: Claude:${MODEL:-claude-opus-5-5}"
if [ -n "$BODY" ]; then
	git commit -m "$SUBJECT" -m "$BODY" -m "$TRAILER"
else
	git commit -m "$SUBJECT" -m "$TRAILER"
fi

sh "$HERE/toggle.sh" on
make -j8 > "$LOG" 2>&1 || { tail -30 "$LOG"; echo "commit.sh: the build with the hooks failed" >&2; exit 1; }
rm -f "$LOG"
