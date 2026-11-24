# SPDX-License-Identifier: GPL-3.0-or-later
"""Plan 16 R5: bakes a procedural material to flat maps. The script builds a node graph (or flat geometry) on a unit plane; this
module sets up Cycles (CPU, seeded, no denoise) and bakes each map as an emission pass seen by an orthographic camera straight
down on the plane, so one texel is one pixel and the UVs run 0..1 across the image. tools/art/src/material.ts then makes the maps
tile and derives the normal.

A script calls `start()`, builds its material with `Graph`, and finishes with `bake(b, base, build)`,
where `build(graph)` returns {"albedo": socket, "rough": socket, "height": socket}.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

import bpy  # noqa: E402

from lib.args import parse_args  # noqa: E402
from lib.layout import linear  # noqa: E402


def lin(hex_colour):
    """sRGB 0xRRGGBB to the linear RGBA the nodes take."""
    return (*linear(hex_colour), 1.0)


class Bake:
    def __init__(self):
        self.args = parse_args()
        self.p = self.args.params
        self.size = int(self.p["size"])
        self.seed = int(self.p["seed"])
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        s = self.scene
        s.render.engine = "CYCLES"
        s.cycles.device = "CPU"
        s.cycles.samples = int(self.p["samples"])
        s.cycles.use_denoising = False
        s.cycles.use_adaptive_sampling = False
        s.cycles.seed = self.seed
        s.cycles.use_animated_seed = False
        s.render.resolution_x = s.render.resolution_y = self.size
        s.render.resolution_percentage = 100
        s.render.image_settings.file_format = "PNG"
        s.render.image_settings.color_mode = "RGB"
        s.render.image_settings.color_depth = "8"
        s.render.dither_intensity = 0.0
        s.view_settings.look = "None"
        s.view_settings.exposure = 0.0
        s.view_settings.gamma = 1.0
        s.display_settings.display_device = "sRGB"
        s.render.film_transparent = False
        s.render.filter_size = 1.0
        s.world = bpy.data.worlds.new("black")
        s.world.color = (0, 0, 0)
        cam = bpy.data.cameras.new("cam")
        cam.type = "ORTHO"
        cam.ortho_scale = 1.0
        co = bpy.data.objects.new("cam", cam)
        s.collection.objects.link(co)
        co.location = (0.5, 0.5, 2.0)          # looking down -Z at the unit square [0, 1]^2
        s.camera = co
        self.plane = None

    def make_plane(self):
        """A unit plane over [0, 1]^2 with UVs equal to xy."""
        me = bpy.data.meshes.new("plane")
        me.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
        me.uv_layers.new(name="UVMap")
        for loop, uv in zip(me.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
            me.uv_layers[0].data[loop.index].uv = uv
        obj = bpy.data.objects.new("plane", me)
        self.scene.collection.objects.link(obj)
        self.plane = obj
        mat = bpy.data.materials.new("bake")
        mat.use_nodes = True
        me.materials.append(mat)
        return mat.node_tree

    def render(self, out_png, raw):
        s = self.scene
        s.view_settings.view_transform = "Raw" if raw else "Standard"
        s.render.filepath = out_png
        bpy.ops.render.render(write_still=True)

    def emit(self, nt, socket):
        """Wires `socket` (a colour or a value) into an Emission shader into the output."""
        for n in list(nt.nodes):
            if n.type in ("OUTPUT_MATERIAL", "BSDF_PRINCIPLED", "EMISSION"):
                nt.nodes.remove(n)
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Strength"].default_value = 1.0
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(socket, em.inputs["Color"])
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])


class Graph:
    """Thin helpers over the node tree: the UV vector, noise, ramps and arithmetic."""

    def __init__(self, nt, seed=0):
        self.nt = nt
        self.seed = seed
        self.uv = self.node("ShaderNodeTexCoord").outputs["UV"]

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, out, inp):
        self.nt.links.new(out, inp)

    def vec(self, scale=(1, 1, 1), offset=(0, 0, 0), src=None):
        """The UV (or `src`) scaled and moved; the seed moves the third axis, so each seed is another slice of the noise."""
        m = self.node("ShaderNodeMapping", vector_type="POINT")
        self.link(src or self.uv, m.inputs["Vector"])
        m.inputs["Scale"].default_value = scale
        m.inputs["Location"].default_value = (offset[0], offset[1], offset[2] + self.seed * 7.13)
        return m.outputs["Vector"]

    def noise(self, scale, detail=2.0, rough=0.5, distortion=0.0, vector=None, stretch=(1, 1, 1)):
        n = self.node("ShaderNodeTexNoise", noise_dimensions="3D")
        self.link(vector or self.vec(stretch), n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        n.inputs["Distortion"].default_value = distortion
        return n.outputs["Fac"]

    def voronoi(self, scale, feature="F1", randomness=1.0, vector=None, out="Distance"):
        n = self.node("ShaderNodeTexVoronoi", voronoi_dimensions="3D", feature=feature)
        self.link(vector or self.vec(), n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale
        n.inputs["Randomness"].default_value = randomness
        return n.outputs[out]

    def ramp(self, fac, stops, colour=True):
        """stops: [(position, 0xRRGGBB or float)...]. A colour ramp gives an RGBA socket."""
        r = self.node("ShaderNodeValToRGB")
        el = r.color_ramp.elements
        while len(el) < len(stops):
            el.new(0.5)
        for e, (pos, c) in zip(el, stops):
            e.position = pos
            e.color = lin(c) if isinstance(c, int) else (c, c, c, 1.0)
        self.link(fac, r.inputs["Fac"])
        return r.outputs["Color"]

    def math(self, op, a, b=None, clamp=False):
        n = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs["Value"]

    def mix(self, fac, a, b):
        """Mixes two colours by `fac` (a socket or a number)."""
        n = self.node("ShaderNodeMix", data_type="RGBA", blend_type="MIX")
        if isinstance(fac, (int, float)):
            n.inputs[0].default_value = fac
        else:
            self.link(fac, n.inputs[0])
        for i, v in ((6, a), (7, b)):
            if isinstance(v, int):
                n.inputs[i].default_value = lin(v)
            else:
                self.link(v, n.inputs[i])
        return n.outputs[2]

    def gray(self, fac):
        """A value as a colour (for the roughness and height maps, baked raw)."""
        n = self.node("ShaderNodeCombineColor")
        for k in ("Red", "Green", "Blue"):
            self.link(fac, n.inputs[k])
        return n.outputs["Color"]


def bake(b, base, build, names=("albedo", "rough", "height")):
    """`build(graph)` returns {name: socket}. Each map is rendered as <base>.<name>.png from a fresh graph (the same seed, so the
    same pattern). albedo is sRGB; the others are raw data."""
    nt = b.make_plane()
    for name in names:
        g = Graph(nt, b.seed)
        sock = build(g)[name]
        b.emit(nt, sock)
        b.render(f"{base}.{name}.png", raw=(name != "albedo"))
        for n in list(nt.nodes):
            nt.nodes.remove(n)
    print(f"baked {list(names)} at {b.size}px, seed {b.seed}")
