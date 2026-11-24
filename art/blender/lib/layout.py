# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers for the ship sets (Plan 16): design space (Y up, metres) to Blender (Z up), meshes from vertices, materials, cameras.

Design space is the one tools/art/src/shipcam.ts fits in: x right, y up, the camera looking down -z at zero yaw and pitch.
"""
import math

import bpy
import bmesh
from mathutils import Matrix, Vector


def b(v):
    """Design (x, y, z) to Blender (x, -z, y): a proper rotation, so winding is kept."""
    return (v[0], -v[2], v[1])


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    return ((h >> 16) & 255) / 255.0, ((h >> 8) & 255) / 255.0, (h & 255) / 255.0


def linear(h):
    return tuple(srgb_to_linear(c) for c in hex_rgb(h))


_materials = {}


def material(name, hex_colour, emit=0.0, rough=0.6):
    """A Principled material; its viewport colour is the same, so Workbench's solid render shows it."""
    if name in _materials:
        return _materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    node = m.node_tree.nodes["Principled BSDF"]
    lin = linear(hex_colour)
    node.inputs["Base Color"].default_value = (*lin, 1.0)
    node.inputs["Roughness"].default_value = rough
    if emit > 0:
        node.inputs["Emission Color"].default_value = (*lin, 1.0)
        node.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = (*lin, 1.0)
    _materials[name] = m
    return m


def mesh(name, verts, faces, mat=None):
    """An object from design-space vertices and faces (lists of vertex indices), linked into the scene."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([b(v) for v in verts], [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if mat is not None:
        me.materials.append(mat)
    return obj


def recalc(obj):
    """Outward normals for a closed mesh."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def box(name, mn, mx, mat=None):
    x0, y0, z0 = mn
    x1, y1, z1 = mx
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)]
    return recalc(mesh(name, v, f, mat))


def prism(name, poly_xz, y0, y1, mat=None):
    """A closed block: the plan polygon (design x, z points, may be concave) from height y0 to y1."""
    n = len(poly_xz)
    v = [(x, y0, z) for x, z in poly_xz] + [(x, y1, z) for x, z in poly_xz]
    f = [tuple(range(n, 2 * n)), tuple(reversed(range(n)))] + [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    return recalc(mesh(name, v, f, mat))


def quad(name, corners, mat=None, face_to=None):
    """One face through four corners (in order). With face_to, its normal points toward that design point."""
    c = [Vector(p) for p in corners]
    n = (c[1] - c[0]).cross(c[3] - c[0])
    centre = sum(c, Vector()) / 4
    f = (0, 1, 2, 3)
    if face_to is not None and n.dot(Vector(face_to) - centre) < 0:
        f = (3, 2, 1, 0)
    return mesh(name, corners, [f], mat)


def toward(point, eye, eps):
    """`point` moved `eps` metres toward `eye` along the ray: it projects to exactly the same pixel, and wins a depth tie."""
    p = Vector(point)
    e = Vector(eye)
    d = e - p
    return tuple(p + d.normalized() * min(eps, d.length * 0.5))


def slab(name, corners, thick, mat=None):
    """The quad (bottom-left, bottom-right, top-right, top-left) given thickness downward along -y: closed, for a console top."""
    top = [tuple(p) for p in corners]
    bot = [(p[0], p[1] - thick, p[2]) for p in corners]
    f = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    return recalc(mesh(name, top + bot, f, mat))


def ribbon(name, pts_xz, y0, y1, mat, face_to):
    """A wall along a polyline of (x, z) points from y0 to y1, facing `face_to` (a design point)."""
    objs = []
    for i in range(len(pts_xz) - 1):
        (xa, za), (xb, zb) = pts_xz[i], pts_xz[i + 1]
        objs.append(quad(f"{name}.{i}", [(xa, y0, za), (xb, y0, zb), (xb, y1, zb), (xa, y1, za)], mat, face_to))
    return objs


def ellipse(name, cx, y, cz, rx, rz, mat, up=True, segs=48):
    v = [(cx, y, cz)] + [(cx + rx * math.cos(2 * math.pi * k / segs), y, cz - rz * math.sin(2 * math.pi * k / segs)) for k in range(segs)]
    f = [(0, 1 + k, 1 + (k + 1) % segs) for k in range(segs)]
    if not up:
        f = [t[::-1] for t in f]
    return mesh(name, v, f, mat)


def tube(name, pts, radius, mat, sides=8):
    """A tube along a polyline of design points (a rail)."""
    rings = []
    for i, p in enumerate(pts):
        a = Vector(pts[max(i - 1, 0)])
        c = Vector(pts[min(i + 1, len(pts) - 1)])
        t = (c - a).normalized()
        n = t.cross(Vector((0, 1, 0)))
        if n.length < 1e-6:
            n = Vector((1, 0, 0))
        n.normalize()
        m = t.cross(n).normalized()
        rings.append([tuple(Vector(p) + (n * math.cos(2 * math.pi * k / sides) + m * math.sin(2 * math.pi * k / sides)) * radius) for k in range(sides)])
    verts = [v for r in rings for v in r]
    faces = []
    for i in range(len(rings) - 1):
        for k in range(sides):
            a, bb = i * sides + k, i * sides + (k + 1) % sides
            faces.append((a, bb, bb + sides, a + sides))
    return recalc(mesh(name, verts, faces, mat))


def basis(cam):
    """The camera's right, up and forward axes in design space: tools/art/src/shipcam.ts's `basis`."""
    cp = math.cos(cam["pitch"])
    fwd = Vector((-math.sin(cam["yaw"]) * cp, math.sin(cam["pitch"]), -math.cos(cam["yaw"]) * cp))
    r0 = fwd.cross(Vector((0, 1, 0))).normalized()
    u0 = r0.cross(fwd)
    cr, sr = math.cos(cam["roll"]), math.sin(cam["roll"])
    return r0 * cr - u0 * sr, u0 * cr + r0 * sr, fwd


def make_camera(name, cam, width=640, height=480):
    """A Blender camera for a layout camera: position and axes through `b`, the vertical FOV, and the lens shift in the sensor's units."""
    data = bpy.data.cameras.new(name)
    data.sensor_fit = "VERTICAL"
    data.sensor_height = 24.0
    data.lens = 12.0 / math.tan(cam["fovY"] / 2)
    data.shift_y = -cam.get("shiftY", 0.0) / height
    data.clip_start = 0.05
    data.clip_end = 100.0
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    r, u, f = basis(cam)
    rot = Matrix(((b(r)[0], b(u)[0], -b(f)[0]), (b(r)[1], b(u)[1], -b(f)[1]), (b(r)[2], b(u)[2], -b(f)[2])))
    obj.matrix_world = Matrix.Translation(Vector(b(cam["position"]))) @ rot.to_4x4()
    return obj


def look_camera(name, position, target, fov_y):
    """A level camera (no roll) at `position` looking at `target`, both design points."""
    d = Vector(target) - Vector(position)
    yaw = math.atan2(-d.x, -d.z)
    pitch = math.atan2(d.y, math.hypot(d.x, d.z))
    return make_camera(name, {"position": position, "yaw": yaw, "pitch": pitch, "roll": 0.0, "fovY": fov_y, "shiftY": 0.0})


# --- Plan 16 Task 5: textured materials, UVs, lofts, lights ---------------------------------------------------------------------

_images = {}


def _image(path, colour_space):
    key = (path, colour_space)
    if key not in _images:
        img = bpy.data.images.load(path)
        img.colorspace_settings.name = colour_space
        _images[key] = img
    return _images[key]


def pbr(name, tex, tint=None, emit=0.0, emit_tex=False, emit_colour=None, normal=1.0, rough_scale=1.0, base=None):
    """A Principled material from a baked material's maps (R5): `tex` is {albedo, mr, normal} file paths. `tint` (0xRRGGBB)
    multiplies the albedo (glTF's base colour factor). With `emit`, the albedo also glows at that strength (emit_tex), or
    `emit_colour` does. With `base` (0xRRGGBB) the albedo image isn't used: the colour is flat, under the same normal and roughness maps
    (a maroon rug on the carpet's pile). The mr image is glTF's: G is roughness, B is metal."""
    if name in _materials:
        return _materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"

    def image_node(path, space):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = _image(path, space)
        n.extension = "REPEAT"
        n.interpolation = "Linear"
        nt.links.new(uv.outputs["UV"], n.inputs["Vector"])
        return n

    alb = image_node(tex["albedo"], "sRGB")
    colour = alb.outputs["Color"]
    if tint is not None:
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs[0].default_value = 1.0
        nt.links.new(colour, mix.inputs[6])
        mix.inputs[7].default_value = (*linear(tint), 1.0)
        colour = mix.outputs[2]
    if base is not None:
        bsdf.inputs["Base Color"].default_value = (*linear(base), 1.0)
    else:
        nt.links.new(colour, bsdf.inputs["Base Color"])
    mr = image_node(tex["mr"], "Non-Color")
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(mr.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nm = image_node(tex["normal"], "Non-Color")
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = normal
    nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if emit > 0:
        if emit_tex:
            nt.links.new(colour, bsdf.inputs["Emission Color"])
        else:
            bsdf.inputs["Emission Color"].default_value = (*linear(emit_colour), 1.0)
        bsdf.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = (*linear(tint if tint is not None else 0x808080), 1.0)
    _materials[name] = m
    return m


def auto_uv(obj, tile):
    """Planar UVs in metres / `tile` from each face's dominant axis (design space), so a texture keeps one scale on every wall."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    layer = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        ax, ay, az = abs(n.x), abs(n.z), abs(n.y)           # design x, y (Blender z), z (Blender -y)
        for lp in f.loops:
            v = lp.vert.co
            X, Y, Z = v.x, v.z, -v.y
            if ay >= ax and ay >= az:
                uv = (X, Z)
            elif az >= ax:
                uv = (X, Y)
            else:
                uv = (Z, Y)
            lp[layer].uv = (uv[0] / tile, uv[1] / tile)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def bevel(obj, width, segments=3):
    """A bevel modifier (applied by the exporter) and smooth shading: the soft edges of a seat or a console."""
    m = obj.modifiers.new("bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def rotate_y(obj, degrees, pivot):
    """Turns a mesh about the vertical axis through the design point `pivot` (before any modifier)."""
    a = math.radians(degrees)
    ca, sa = math.cos(a), math.sin(a)
    for v in obj.data.vertices:
        x, y, z = v.co.x, v.co.z, -v.co.y                  # Blender back to design
        dx, dz = x - pivot[0], z - pivot[1]
        nx = pivot[0] + dx * ca + dz * sa
        nz = pivot[1] - dx * sa + dz * ca
        v.co = (nx, -nz, y)
    obj.data.update()
    return obj


def loft(name, a, b_, mat, face_to=None):
    """A band between two equal-length polylines of design points (a ceiling cove, a riser)."""
    objs = []
    for i in range(len(a) - 1):
        objs.append(quad(f"{name}.{i}", [a[i], a[i + 1], b_[i + 1], b_[i]], mat, face_to))
    return objs


def extrude_x(name, profile, x0, x1, mat=None):
    """A closed prism: `profile` is a polygon of (z, y) points, extruded from x0 to x1 (a curved pedestal, a ramp's side view)."""
    n = len(profile)
    verts = [(x0, y, z) for z, y in profile] + [(x1, y, z) for z, y in profile]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)] + [tuple(range(n))[::-1], tuple(n + i for i in range(n))]
    return recalc(mesh(name, verts, faces, mat))


def extrude_z(name, profile, z0, z1, mat=None):
    """A closed prism: `profile` is a polygon of (x, y) points, extruded from z0 to z1 (a ramp)."""
    n = len(profile)
    verts = [(x, y, z0) for x, y in profile] + [(x, y, z1) for x, y in profile]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)] + [tuple(range(n))[::-1], tuple(n + i for i in range(n))]
    return recalc(mesh(name, verts, faces, mat))


def cylinder(name, cx, cz, r, y0, y1, mat=None, sides=24):
    ring = [(cx + r * math.cos(2 * math.pi * k / sides), cz - r * math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    verts = [(x, y0, z) for x, z in ring] + [(x, y1, z) for x, z in ring]
    faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)] + [tuple(range(sides))[::-1], tuple(sides + k for k in range(sides))]
    return recalc(mesh(name, verts, faces, mat))


def light(name, kind, position, energy, colour, target=None, spot_deg=70.0, radius=0.1):
    """A punctual light at a design point (exported as KHR_lights_punctual). Watts, as Blender has them."""
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = linear(colour)
    data.shadow_soft_size = radius
    if kind == "SPOT":
        data.spot_size = math.radians(spot_deg)
        data.spot_blend = 0.4
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = b(position)
    if target is not None:
        d = Vector(b(target)) - Vector(b(position))
        obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return obj


def tube_uv(obj, sides, rings, radius, tile=1.0):
    """UVs for `tube`: u runs along the length in metres / tile (so wood grain follows the rail), v round it."""
    me = obj.data
    cen = []
    for i in range(rings):
        vs = [me.vertices[i * sides + k].co for k in range(sides)]
        cen.append(sum(vs, Vector()) / sides)
    along = [0.0]
    for i in range(1, rings):
        along.append(along[-1] + (cen[i] - cen[i - 1]).length)
    circ = 2 * math.pi * radius
    layer = me.uv_layers.new(name="UVMap") if not me.uv_layers else me.uv_layers[0]
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            ring, k = divmod(vi, sides)
            layer.data[li].uv = (along[ring] / tile, (k / sides) * circ / tile)
    return obj


def merge_by_material(keep):
    """Draw-call diet: applies each mesh's modifiers, then joins every single-material mesh `keep(obj)` is False for into one mesh per
    material (named set:merged.<material>). The items, cards, viewscreen and the like stay apart, as the engine finds them by name."""
    dg = bpy.context.evaluated_depsgraph_get()
    groups = {}
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH" or keep(obj) or len(obj.data.materials) != 1 or obj.data.materials[0] is None:
            continue
        if obj.modifiers:
            me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
            obj.modifiers.clear()
            obj.data = me
        groups.setdefault(obj.data.materials[0].name, []).append(obj)
    for name, objs in groups.items():
        if len(objs) < 2:
            continue
        target = objs[0]
        with bpy.context.temp_override(active_object=target, object=target, selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.join()
        target.name = f"set:merged.{name}"
        target.data.name = target.name
    return len(groups)
