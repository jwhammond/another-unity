# SPDX-License-Identifier: GPL-3.0-or-later
"""R5 console glass: dark, glossy, with a faint grid and a little smudge. Our own procedural design."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

from lib.bake import Bake, bake  # noqa: E402

b = Bake()
P = b.p


def build(g):
    brick = g.node("ShaderNodeTexBrick", offset=0.0, offset_frequency=2, squash=1.0, squash_frequency=2)
    g.link(g.vec(), brick.inputs["Vector"])
    brick.inputs["Scale"].default_value = P.get("grid", 12)
    brick.inputs["Mortar Size"].default_value = 0.012
    brick.inputs["Mortar Smooth"].default_value = 0.2
    brick.inputs["Brick Width"].default_value = 1.0
    brick.inputs["Row Height"].default_value = 1.0
    brick.inputs["Color1"].default_value = (1, 1, 1, 1)
    brick.inputs["Color2"].default_value = (1, 1, 1, 1)
    brick.inputs["Mortar"].default_value = (0, 0, 0, 1)
    line = brick.outputs["Fac"]                  # 1 on a grid line (the brick node's Fac is the mortar)
    smudge = g.noise(P.get("smudge", 3), detail=3)
    base = g.ramp(smudge, [(0.3, 0x05080D), (0.7, 0x0C131B)])
    colour = g.mix(g.math("MULTIPLY", line, 0.55), base, 0x1F4652)
    return {
        "albedo": colour,
        "rough": g.gray(g.math("ADD", 0.07, g.math("MULTIPLY", smudge, 0.12))),
        "height": g.gray(g.math("MULTIPLY", line, 0.3)),
    }


bake(b, b.args.out[:-4], build)
