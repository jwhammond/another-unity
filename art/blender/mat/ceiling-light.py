# SPDX-License-Identifier: GPL-3.0-or-later
"""R5 ceiling light: a warm diffuser, a bit brighter in the middle of each cell, with faint ribs. Our own procedural design."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

from lib.bake import Bake, bake  # noqa: E402

b = Bake()
P = b.p


def build(g):
    cells = g.node("ShaderNodeTexBrick", offset=0.0, offset_frequency=2, squash=1.0, squash_frequency=2)
    g.link(g.vec(), cells.inputs["Vector"])
    cells.inputs["Scale"].default_value = P.get("cells", 4)
    cells.inputs["Mortar Size"].default_value = 0.03
    cells.inputs["Mortar Smooth"].default_value = 0.5
    cells.inputs["Brick Width"].default_value = 1.0
    cells.inputs["Row Height"].default_value = 1.0
    cells.inputs["Color1"].default_value = (1, 1, 1, 1)
    cells.inputs["Color2"].default_value = (1, 1, 1, 1)
    cells.inputs["Mortar"].default_value = (0, 0, 0, 1)
    face = g.math("SUBTRACT", 1.0, cells.outputs["Fac"], clamp=True)   # 1 on a cell, 0 on a rib
    cloud = g.noise(6, detail=2)
    colour = g.mix(g.math("MULTIPLY", g.math("SUBTRACT", 1.0, face, clamp=True), 0.5), g.mix(g.math("MULTIPLY", cloud, 0.4), 0xFFEFCB, 0xFFE2A8), 0xC9A96A)
    return {
        "albedo": colour,
        "rough": g.gray(g.math("ADD", 0.85, g.math("MULTIPLY", cloud, 0.1))),
        "height": g.gray(g.math("MULTIPLY", face, 0.5)),
    }


bake(b, b.args.out[:-4], build)
