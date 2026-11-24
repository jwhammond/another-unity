# SPDX-License-Identifier: GPL-3.0-or-later
"""R5 trim: dark grey painted metal with a fine brushed grain. Our own procedural design."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

from lib.bake import Bake, bake  # noqa: E402

b = Bake()
P = b.p


def build(g):
    brush = g.noise(P.get("brush", 40), detail=5, rough=0.7, stretch=(0.02, 1.0, 1.0))
    cloud = g.noise(4, detail=2)
    colour = g.ramp(g.math("ADD", g.math("MULTIPLY", brush, 0.7), g.math("MULTIPLY", cloud, 0.3)), [(0.25, 0x23252A), (0.55, 0x34373D), (0.8, 0x44474E)])
    return {
        "albedo": colour,
        "rough": g.gray(g.math("ADD", 0.38, g.math("MULTIPLY", brush, 0.2))),
        "height": g.gray(g.math("ADD", 0.5, g.math("MULTIPLY", brush, 0.3))),
    }


bake(b, b.args.out[:-4], build)
