# SPDX-License-Identifier: GPL-3.0-or-later
"""Reads the arguments after `--` that tools/art/src/blender.ts passes: --out <file> and --params <json>."""
import argparse
import json
import sys


def parse_args(argv=None):
    argv = sys.argv if argv is None else argv
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    p = argparse.ArgumentParser(prog="blender -P script.py --")
    p.add_argument("--out", required=True)
    p.add_argument("--params", default="{}")
    p.add_argument("--textures", default="[]", help="json list of texture file paths, in recipe order")
    a = p.parse_args(rest)
    a.params = json.loads(a.params)
    a.textures = json.loads(a.textures)
    return a
