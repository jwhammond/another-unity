#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# toggle.sh on|off: insert or remove the local test harness hooks in the export
# worktree (never commit them). From ~/pcode/unity-tools/harness/toggle.sh.
T=${SCUMMVM_TREE:-$HOME/pcode/scummvm-export}
HERE=$(cd "$(dirname "$0")" && pwd)
F=$T/engines/unity/console.cpp
U=$T/engines/unity/unity.cpp
M=$T/engines/unity/msgbox.cpp
H=$HERE/harness.inc
remove() {
	sed -i "" "/HARNESS_HOOK/d" "$T"/engines/unity/*.cpp "$T"/engines/unity/*.h
}
# (make 3.81 compares whole seconds: an object built in the same second as a toggle looks up to date, and the
# binary goes with or without hooks the sources no longer have; so every toggle drops the hooked files' objects)
stale() {
	rm -f "$T"/engines/unity/console.o "$T"/engines/unity/unity.o "$T"/engines/unity/msgbox.o
}
case "$1" in
on)
	# (from none, so a half-applied set can't pass for a whole one)
	remove
	stale
	perl -0pi -e 's|(void UnityConsole::runPendingCommand\(\) \{\n)|$1#include "'"$H"'" // HARNESS_HOOK\n|' "$F"
	perl -0pi -e 's|(#include "common/archive.h"\n)|$1#include "common/tokenizer.h" // HARNESS_HOOK\n#include "common/system.h" // HARNESS_HOOK\n#include "common/events.h" // HARNESS_HOOK\n#include "graphics/paletteman.h" // HARNESS_HOOK\n#include "image/png.h" // HARNESS_HOOK\n#include "common/config-manager.h" // HARNESS_HOOK\n#include "common/file.h" // HARNESS_HOOK\n#include "common/fs.h" // HARNESS_HOOK\n#include "graphics/surface.h" // HARNESS_HOOK\n#include "backends/keymapper/keymapper.h" // HARNESS_HOOK\n#include "unity/cues.h" // HARNESS_HOOK\n|' "$F"
	perl -0pi -e 's/\n(\t+)(startupScreen\(\);|playMovie\(kMovie(?:Teaser|Title)\);)/\n$1if (!ConfMan.getBool("unity_skip_intro")) \/\/ HARNESS_HOOK\n$1$2/g' "$U"
	perl -0pi -e 's|(\twhile \(_in_dialog && !shouldQuit\(\)\) \{\n\t\tcheckEvents\(\);\n)|$1\t\t_console->runPendingCommand(); // HARNESS_HOOK\n|' "$U"
	perl -0pi -e 's|(\t\tupdateWalking\(\);\n\t\tdrawScene\(\);\n\t\t_system->updateScreen\(\);\n)|$1\t\t_console->runPendingCommand(); // HARNESS_HOOK\n|' "$U"
	perl -0pi -e 's|(\t\tif \(selected != -1\) \{\n)|\t\t_console->runPendingCommand(); // HARNESS_HOOK\n$1|' "$M"
	for f in "$F" "$U" "$M"; do
		n=$(grep -c HARNESS_HOOK "$f")
		echo "$f: $n"
		if [ "$n" -eq 0 ]; then
			echo "toggle.sh: no hooks went into $f (has its code changed?)" >&2
			exit 1
		fi
	done
	;;
off)
	remove
	stale
	if grep -l HARNESS_HOOK "$T"/engines/unity/*.cpp "$T"/engines/unity/*.h; then
		echo "toggle.sh: hooks are left in the files above" >&2
		exit 1
	fi
	;;
*)
	echo "usage: toggle.sh on|off" >&2
	exit 1
	;;
esac
