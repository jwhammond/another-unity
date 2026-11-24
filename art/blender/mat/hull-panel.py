# SPDX-License-Identifier: GPL-3.0-or-later
"""R5 hull panel: beige-grey wall panels, a thin dark seam between them and a faint satin grain. Our own procedural design."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

from lib.bake import Bake, bake  # noqa: E402

b = Bake()
P = b.p


def build(g):
    n = P.get("panels", 2)
    brick = g.node("ShaderNodeTexBrick", offset=0.0, offset_frequency=2, squash=1.0, squash_frequency=2)
    g.link(g.vec(), brick.inputs["Vector"])
    brick.inputs["Scale"].default_value = n
    brick.inputs["Mortar Size"].default_value = P.get("seam", 0.012)
    brick.inputs["Mortar Smooth"].default_value = 0.1
    brick.inputs["Brick Width"].default_value = 1.0
    brick.inputs["Row Height"].default_value = 1.0
    brick.inputs["Color1"].default_value = (1, 1, 1, 1)
    brick.inputs["Color2"].default_value = (1, 1, 1, 1)
    brick.inputs["Mortar"].default_value = (0, 0, 0, 1)
    face = g.math("SUBTRACT", 1.0, brick.outputs["Fac"], clamp=True)   # (the brick node's Fac is the mortar) 1 on a panel, 0 in the seam
    grain = g.noise(P.get("grain", 30), detail=3, rough=0.6, stretch=(1.0, 0.08, 1.0))
    cloud = g.noise(P.get("cloud", 2.5), detail=2)
    base = g.ramp(g.math("ADD", g.math("MULTIPLY", grain, 0.35), g.math("MULTIPLY", cloud, 0.65)), [(0.2, 0xA48C70), (0.6, 0xC0A682), (0.9, 0xD3BD9A)])
    colour = g.mix(g.math("SUBTRACT", 1.0, face, clamp=True), base, 0x2D2A27)
    return {
        "albedo": colour,
        "rough": g.gray(g.math("ADD", 0.55, g.math("MULTIPLY", grain, 0.2))),
        "height": g.gray(g.math("ADD", g.math("MULTIPLY", face, 0.7), g.math("MULTIPLY", grain, 0.08))),
    }


bake(b, b.args.out[:-4], build)
