# SPDX-License-Identifier: GPL-3.0-or-later
"""R5 wood rail: warm satin wood (a reddish-brown hardwood) with long straight grain. Our own procedural design."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

from lib.bake import Bake, bake  # noqa: E402

b = Bake()
P = b.p


def build(g):
    # grain runs along u: the pattern is stretched along it (small scale in u, large in v)
    ring = g.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Y", wave_profile="SIN")
    g.link(g.vec((1.0, 1.0, 1.0)), ring.inputs["Vector"])
    ring.inputs["Scale"].default_value = P.get("rings", 5)
    ring.inputs["Distortion"].default_value = 2.5
    ring.inputs["Detail"].default_value = 2.0
    ring.inputs["Detail Scale"].default_value = 1.5
    fine = g.noise(P.get("fine", 14), detail=4, rough=0.6, stretch=(0.06, 1.0, 1.0))        # fine pores, long in u
    streak = g.math("ADD", g.math("MULTIPLY", ring.outputs["Fac"], 0.6), g.math("MULTIPLY", fine, 0.5))
    colour = g.ramp(streak, [(0.0, 0x5C2511), (0.5, 0x8C4222), (1.0, 0xB5642F)])
    return {
        "albedo": colour,
        "rough": g.gray(g.math("ADD", 0.32, g.math("MULTIPLY", fine, 0.2))),
        "height": g.gray(g.math("ADD", 0.5, g.math("MULTIPLY", fine, 0.25))),
    }


bake(b, b.args.out[:-4], build)
