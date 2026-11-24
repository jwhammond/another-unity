# SPDX-License-Identifier: GPL-3.0-or-later
"""R5 LCARS: rounded bars and blocks in the show's palette on black, no text and no glyphs. Flat geometry seen by the orthographic
camera, so the edges are antialiased. The layout keeps clear of the borders and the centre lines (0.07 each side), where
tools/art/src/tileable.ts's crossfade blends. Our own procedural design."""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

import bpy  # noqa: E402
from lib.bake import Bake, lin  # noqa: E402

b = Bake()
P = b.p
PALETTE = [0xFF9900, 0xFF9900, 0xFFCC99, 0xCC99CC, 0x9999CC, 0xCC6666, 0xFFCC66, 0x6688CC]
BLACK = 0x050509
GUTTER = 0.07
rng = random.Random(b.seed)


def rounded(x0, y0, x1, y1, r, segs=6):
    """A convex outline of a rounded rectangle, counter-clockwise."""
    r = min(r, (x1 - x0) / 2, (y1 - y0) / 2)
    pts = []
    for cx, cy, a0 in ((x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180), (x1 - r, y0 + r, 270)):
        for k in range(segs + 1):
            a = math.radians(a0 + 90 * k / segs)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


blocks = []   # (outline, colour hex, relief): relief 1 stands proud


def add(x0, y0, x1, y1, r, colour):
    blocks.append((rounded(x0, y0, x1, y1, r), colour))


for qx0, qx1 in ((GUTTER, 0.5 - GUTTER), (0.5 + GUTTER, 1 - GUTTER)):
    for qy0, qy1 in ((GUTTER, 0.5 - GUTTER), (0.5 + GUTTER, 1 - GUTTER)):
        col = rng.choice(PALETTE)
        spine = 0.045                                    # the quadrant's vertical elbow bar
        add(qx0, qy0, qx0 + spine, qy1, 0.02, col)
        y = qy1
        while y - qy0 > 0.04:
            h = rng.uniform(0.03, 0.075)
            if y - h < qy0:
                h = y - qy0
            x = qx0 + spine + 0.008
            while qx1 - x > 0.03:
                w = rng.uniform(0.035, 0.17)
                w = min(w, qx1 - x)
                if rng.random() < 0.8:
                    add(x, y - h, x + w, y, h / 2 if rng.random() < 0.5 else 0.012, rng.choice(PALETTE))
                x += w + 0.008
            y -= h + 0.01


def mesh_for(outline, name):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x, y, 0.0) for x, y in outline], [], [tuple(range(len(outline)))])
    ob = bpy.data.objects.new(name, me)
    b.scene.collection.objects.link(ob)
    return ob


def material(name, rgba):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = rgba
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m


background = mesh_for([(0, 0), (1, 0), (1, 1), (0, 1)], "ground")
objs = [mesh_for(o, f"block{i}") for i, (o, _) in enumerate(blocks)]
for z, ob in enumerate(objs):
    ob.location.z = 0.001                                # above the ground; the camera looks straight down, so only the order matters
base = os.path.splitext(b.args.out)[0]


def variant(name, ground, per_block, raw):
    for i, ob in enumerate(objs):
        ob.data.materials.clear()
        ob.data.materials.append(material(f"{name}{i}", per_block(blocks[i][1])))
    background.data.materials.clear()
    background.data.materials.append(material(f"{name}g", ground))
    b.render(f"{base}.{name}.png", raw=raw)


def gray(v):
    return (v, v, v, 1.0)


variant("albedo", lin(BLACK), lambda c: lin(c), raw=False)
variant("rough", gray(0.5), lambda c: gray(0.28), raw=True)        # the blocks are glossy plastic over a matt ground
variant("height", gray(0.35), lambda c: gray(0.65), raw=True)      # and stand a little proud
print(f"baked lcars: {len(blocks)} blocks at {b.size}px, seed {b.seed}")
