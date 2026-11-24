# SPDX-License-Identifier: GPL-3.0-or-later
"""R5 carpet: the bridge's blue-grey loop pile (the original's periwinkle, the show's darker blue-grey), with a faint diagonal weave. Our own procedural design."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

from lib.bake import Bake, bake  # noqa: E402

b = Bake()
P = b.p


def build(g):
    loops = g.voronoi(P.get("loops", 110), randomness=0.95)                # distance to the nearest loop centre: 0 at its middle
    shade = g.math("MULTIPLY", loops, 1.5, clamp=True)
    pile = g.ramp(shade, [(0.0, 0x7F90BC), (0.5, 0x4F5E8C), (1.0, 0x252E4C)])
    cloud = g.noise(P.get("cloud", 3.5), detail=4, rough=0.6)
    patch = g.mix(g.math("MULTIPLY", g.math("SUBTRACT", cloud, 0.25, clamp=True), 1.6, clamp=True), pile, 0x34406A)   # large soft patches of tone
    wave = g.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="DIAGONAL", wave_profile="SIN")
    g.link(g.vec(), wave.inputs["Vector"])
    wave.inputs["Scale"].default_value = P.get("weave", 6)
    weave = g.mix(g.math("MULTIPLY", wave.outputs["Fac"], 0.05), patch, 0x7686B4)   # a faint diagonal band
    return {
        "albedo": weave,
        "rough": g.gray(g.math("ADD", 0.85, g.math("MULTIPLY", loops, 0.12))),
        "height": g.gray(g.math("SUBTRACT", 1.0, shade)),
    }


bake(b, b.args.out[:-4], build)
