# SPDX-License-Identifier: GPL-3.0-or-later
"""The bridge set (Plan 16 Tasks 3 and 5): geometry from the recipe's design numbers, an invisible proxy per lifted item, the fitted
camera, the show's materials from the baked textures, its lights, a flat ID pass for the alignment check and a look render.

Input (--params): the layout JSON from tools/art/src/shiplayout.ts: camera, items (each with the quad its rectangle unprojects to),
crew and `design`. `--textures` is a JSON list of {id, albedo, mr, normal} from the recipe's `materials` (R5); without it the set
is built in flat colours. Output: <out> (a .glb) and, beside it, <out minus .glb>.id.png, .solid.png and .look.png.

The composition is the game's own (a level camera on two consoles, a curved rail and the display bank behind); the set's details
follow the show: an arched ceiling ring round a skylight, a raised command deck with ramps, tilted console fronts with LCARS plates
on curved lit pedestals, swivel command chairs, pillars with lit strips and a display bank over equipment lockers.
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # art/blender, so `lib` imports under blender -P

import bpy  # noqa: E402
from lib import idpass, layout as L  # noqa: E402
from lib.args import parse_args  # noqa: E402
from lib.extras import tag  # noqa: E402

args = parse_args()
P = args.params
D = P["design"]
CAM = P["camera"]
EYE = tuple(CAM["position"])
EPS = 0.02
TEX = {t["id"]: t for t in args.textures}

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24


def T(tex_id, name, flat, tint=None, rough=0.7, **kw):
    """A baked material (R5) when its textures were given, else a flat stand-in in `flat`."""
    if tex_id in TEX:
        return L.pbr(name, TEX[tex_id], tint=tint, **kw)
    return L.material(name, flat, emit=1.0 if kw.get("emit") else 0.0, rough=rough)


# R5's set: carpet, wood-rail, hull-panel, lcars, console-glass, ceiling-light, trim. The tints only darken or warm a texture.
M = {
    "floor": T("carpet", "floor", 0x2F364A, rough=1.0),
    "oval": T("carpet", "oval", 0x7A3A4C, base=0x8E3F58, rough=1.0),
    "wall": T("hull-panel", "wall", 0x8E92AE, tint=0xEBDCC2),
    "pillar": T("hull-panel", "pillar", 0xB9A66E, tint=0xE7D29A),
    "ceiling": T("hull-panel", "ceiling", 0xA8A090, tint=0xF2EAD6),
    "cabinet": T("hull-panel", "cabinet", 0x6E749C, tint=0xB4AEA8),
    "door": T("hull-panel", "door", 0x6E707C, tint=0xA39A8E),
    "gold": T("hull-panel", "gold", 0xBE9B50, tint=0xE3B867),
    "rail": T("wood-rail", "rail", 0xB56F2E),
    "trim": T("trim", "trim", 0x33323A),
    "glass": T("console-glass", "glass", 0x05060A, rough=0.1),
    "lcars": T("lcars", "lcars", 0xFF8A1F, emit=1.8, emit_tex=True),
    "sky": T("ceiling-light", "sky", 0xFFFFFF, emit=1.6, emit_tex=True, tint=0xFFFFFF),
    "coveglow": T("ceiling-light", "coveglow", 0xFFE6B0, emit=1.2, emit_tex=True, tint=0xFFE9B8),
    "screen": L.material("screen", 0x05060A, emit=0.6, rough=0.6),
    "orange": L.material("orange", 0xF06E1E, emit=2.0),
    "cyan": L.material("cyan", 0x8FDDF5, emit=1.4),
    "card": L.material("card", 0x8C8880, rough=0.9),
    "leather": L.material("leather", 0xB48E52, rough=0.55),
    "pad": L.material("pad", 0x24252B, rough=0.6),
}
LCARS = [0xFF8A1F, 0xFFC34D, 0x6AD0FF, 0xEEEEEE, 0xB07CFF]
colours = {}      # object name -> ID colour (0xRRGGBB)


def item_tag(obj, it, **kw):
    tag(obj, item=it["index"], action=it["action"], **kw)
    colours[obj.name] = it["colour"]
    return obj


def uv(obj, tile=2.4):
    return L.auto_uv(obj, tile)


def ring_pts(cx, cz, rx, rz, y, n=64):
    return [(cx + rx * math.cos(2 * math.pi * k / n), y, cz - rz * math.sin(2 * math.pi * k / n)) for k in range(n + 1)]


# --- the room: floor, deck, walls ------------------------------------------------------------------------------------------------
poly = [tuple(p) for p in D["wallPoly"]]
H = D["wallHeight"]
centre = (0.0, 1.0, 2.0)
uv(L.ellipse("set:floor", 0, 0, 0, D["floorRadius"], D["floorRadius"], M["floor"]), 1.3)

dk = D["deck"]
DH = dk["h"]
uv(L.ellipse("set:deck", dk["cx"], DH, dk["cz"], dk["rx"], dk["rz"], M["floor"], segs=64), 1.3)
c = D["carpet"]
uv(L.ellipse("set:carpet", c["cx"], DH + 0.004, c["cz"], c["rx"], c["rz"], M["oval"], segs=64), 1.3)
lo, hi = ring_pts(dk["cx"], dk["cz"], dk["rx"], dk["rz"], 0.0), ring_pts(dk["cx"], dk["cz"], dk["rx"], dk["rz"], DH)
for i in range(len(lo) - 1):                                        # the deck's riser
    mid = ((lo[i][0] + lo[i + 1][0]) / 2, DH / 2, (lo[i][2] + lo[i + 1][2]) / 2)
    out = (dk["cx"] + (mid[0] - dk["cx"]) * 4, DH / 2, dk["cz"] + (mid[2] - dk["cz"]) * 4)
    uv(L.quad(f"set:riser.{i}", [lo[i], lo[i + 1], hi[i + 1], hi[i]], M["cabinet"], out), 1.0)
for side, (x, sgn) in enumerate(((dk["cx"] - dk["rx"], -1), (dk["cx"] + dk["rx"], 1))):   # a ramp at each end of the deck
    r = dk["ramp"]
    prof = [(x - sgn * r["len"], 0.0), (x + sgn * 0.12, DH), (x + sgn * 0.12, 0.0)]
    uv(L.extrude_z(f"set:ramp.{side}", prof if sgn < 0 else prof[::-1], r["z0"], r["z1"], M["floor"]), 1.3)

bank_seg = D["bank"]["seg"]
y0, y1 = D["bank"]["y0"], D["bank"]["y1"]
for i in range(len(poly) - 1):
    seg = [poly[i], poly[i + 1]]
    if i == bank_seg:
        for o in L.ribbon(f"set:cabinet.{i}", seg, 0.1, y0, M["cabinet"], centre):
            uv(o)
        for o in L.ribbon(f"set:kick.{i}", seg, 0, 0.1, M["trim"], centre):
            uv(o, 1.0)
        (xa, za), (xb, zb) = seg
        scr = L.quad("viewscreen", [(xa, y0, za), (xb, y0, zb), (xb, y1, zb), (xa, y1, za)], M["screen"], centre)
        tag(scr, viewscreen=True)
        for o in L.ribbon(f"set:wallhi.{i}", seg, y1, H, M["wall"], centre):
            uv(o)
        for k, (ya, yb) in enumerate(((y0 - 0.07, y0), (y1, y1 + 0.07))):          # the bank's frame, proud of the wall
            uv(L.box(f"set:bankframe.{k}", (xa - 0.07, ya, za), (xb + 0.07, yb, za + 0.05), M["trim"]), 1.0)
        for k, (xx0, xx1) in enumerate(((xa - 0.07, xa), (xb, xb + 0.07))):
            uv(L.box(f"set:bankside.{k}", (xx0, y0 - 0.07, za), (xx1, y1 + 0.07, za + 0.05), M["trim"]), 1.0)
        rng = random.Random(7)                       # seeded: the same panels every run
        x = xa + 0.15
        while x < xb - 0.5:
            w = rng.uniform(0.25, 0.6)
            h = rng.uniform(0.1, 0.3)
            yb = rng.uniform(y0 + 0.08, y1 - h - 0.08)
            z = za + (zb - za) * (x - xa) / (xb - xa) + 0.01
            col = LCARS[rng.randrange(len(LCARS))]
            L.quad(f"set:lcars.{len(colours)}.{int(x * 100)}", [(x, yb, z), (x + w, yb, z), (x + w, yb + h, z), (x, yb + h, z)], L.material(f"lcars{col:06x}", col, emit=1.1), centre)
            x += w + rng.uniform(0.05, 0.3)
    else:
        for o in L.ribbon(f"set:wall.{i}", seg, 0.12, H, M["wall"], centre):
            uv(o)
        for o in L.ribbon(f"set:skirt.{i}", seg, 0, 0.12, M["trim"], centre):
            uv(o, 1.0)

# --- the ceiling: a beam over the wall, the ring's cove, its glowing rim, and the skylight with its ribs ------------------------
bm = D["beam"]
rg = D["ring"]
for o in L.ribbon("set:beam", poly, bm["y0"], bm["y1"], M["pillar"], centre):
    uv(o)
for o in L.ribbon("set:wallceil", poly, H, bm["y0"], M["ceiling"], centre):
    uv(o)
cc = (rg["cx"], rg["cz"])
outer = [(x, bm["y1"], z) for x, z in poly]
inner = [(cc[0] + (x - cc[0]) * rg["scale"], rg["y0"], cc[1] + (z - cc[1]) * rg["scale"]) for x, z in poly]
rim = [(x, rg["y1"], z) for x, _, z in inner]
down = (cc[0], 0.5, cc[1])
for o in L.loft("set:cove", outer, inner, M["ceiling"], down):
    uv(o)
GL = rg["glow"]                                                               # the glowing rim and the skylight cover only the back segments
rim_in = inner[GL[0]:GL[1] + 1]
for o in L.loft("set:rim", rim_in, [(x, rg["y1"], z) for x, _, z in rim_in], M["coveglow"], down):
    uv(o, 3.0)
flat = [(x, rg["y1"] + 0.02, z) for x, _, z in inner]
uv(L.mesh("set:ceiling", [(cc[0], rg["y1"] + 0.02, cc[1])] + flat, [(0, 1 + k, 2 + k) for k in range(len(flat) - 1)][::-1], M["ceiling"]), 3.0)
uv(L.ellipse("set:ceiling-far", cc[0], rg["y1"] + 0.02, cc[1], 40, 40, M["ceiling"], up=False), 3.0)
fan = [(x, rg["y1"] + 0.006, z) for x, _, z in rim_in]
sky = L.mesh("set:skylight", [(cc[0], rg["y1"] + 0.006, cc[1])] + fan, [(0, 1 + k, 2 + k) for k in range(len(fan) - 1)][::-1], M["sky"])
uv(sky, 3.0)
dense = []
for (xa_, ya_, za_), (xb_, yb_, zb_) in zip(fan, fan[1:]):                     # the rim, subdivided about every metre, for the ribs
    nseg = max(1, round(math.hypot(xb_ - xa_, zb_ - za_)))
    dense += [(xa_ + (xb_ - xa_) * s / nseg, ya_, za_ + (zb_ - za_) * s / nseg) for s in range(nseg)]
dense.append(fan[-1])
for k, (px, _, pz) in enumerate(dense):                                       # the skylight's ribs: thin flat beams from the middle to the rim
    dx, dz = px - cc[0], pz - cc[1]
    n = math.hypot(dx, dz)
    wx, wz = -dz / n * 0.06, dx / n * 0.06
    yy = rg["y1"] - 0.004
    uv(L.quad(f"set:rib.{k}", [(cc[0] - wx, yy, cc[1] - wz), (cc[0] + wx, yy, cc[1] + wz), (px + wx, yy, pz + wz), (px - wx, yy, pz - wz)], M["trim"], (cc[0], 0.0, cc[1])), 1.0)

# --- pillars, strips, the tactical locker, the rail ------------------------------------------------------------------------------
for k, p in enumerate(D["pillars"]):
    uv(L.bevel(L.box(f"set:pillar.{k}", (p["x"] - p["sx"] / 2, 0, p["z"] - p["sz"]), (p["x"] + p["sx"] / 2, p["h"], p["z"]), M["pillar"]), 0.04), 1.5)
for k, s in enumerate(D["strips"]):
    z = D["pillars"][s["pillar"]]["z"] + 0.012
    f = 0.04
    L.quad(f"set:stripframe.{k}", [(s["x"] - s["sx"] / 2 - f, s["y0"] - f, z - 0.004), (s["x"] + s["sx"] / 2 + f, s["y0"] - f, z - 0.004), (s["x"] + s["sx"] / 2 + f, s["y1"] + f, z - 0.004), (s["x"] - s["sx"] / 2 - f, s["y1"] + f, z - 0.004)], M["trim"], EYE)
    L.quad(f"set:strip.{k}", [(s["x"] - s["sx"] / 2, s["y0"], z), (s["x"] + s["sx"] / 2, s["y0"], z), (s["x"] + s["sx"] / 2, s["y1"], z), (s["x"] - s["sx"] / 2, s["y1"], z)], M["orange"], EYE)
t = D["tactical"]
uv(L.bevel(L.box("set:tactical-body", (t["x0"], 0, t["z"] - t["depth"]), (t["x1"], t["top"], t["z"] - 0.02), M["cabinet"]), 0.02), 2.4)
uv(L.box("set:tactical-toe", (t["x0"] - 0.02, 0, t["z"] - 0.1), (t["x1"] + 0.02, 0.1, t["z"] - 0.01), M["trim"]), 1.0)
rail = L.tube("set:rail", [(p[0], D["rail"]["y"], p[1]) for p in D["rail"]["pts"]], D["rail"]["r"], M["rail"], sides=12)
L.tube_uv(rail, 12, len(D["rail"]["pts"]), D["rail"]["r"])


# --- command chairs: a column on a disc, a cushioned seat, a tall back with a headrest, two arms ----------------------------------
def chair(k, ch):
    x, z, h = ch["x"], ch["z"], ch["h"]
    yaw = ch.get("yaw", 0.0)
    parts = [
        L.cylinder(f"set:chair-base.{k}", x, z, 0.3, DH, DH + 0.04, M["pad"]),
        L.cylinder(f"set:chair-column.{k}", x, z, 0.07, DH + 0.04, 0.3 + DH, M["trim"], sides=12),
        L.box(f"set:chair-seat.{k}", (x - 0.28, 0.3 + DH, z - 0.28), (x + 0.28, 0.42 + DH, z + 0.28), M["leather"]),
        L.box(f"set:chair-back.{k}", (x - 0.27, 0.4 + DH, z + 0.2), (x + 0.27, h - 0.14, z + 0.32), M["leather"]),
        L.box(f"set:chair-head.{k}", (x - 0.19, h - 0.16, z + 0.17), (x + 0.19, h, z + 0.31), M["leather"]),
        L.box(f"set:chair-arm.{k}.l", (x - 0.37, 0.55 + DH, z - 0.2), (x - 0.29, 0.62 + DH, z + 0.28), M["pad"]),
        L.box(f"set:chair-arm.{k}.r", (x + 0.29, 0.55 + DH, z - 0.2), (x + 0.37, 0.62 + DH, z + 0.28), M["pad"]),
        L.box(f"set:chair-armpost.{k}.l", (x - 0.35, 0.4 + DH, z + 0.1), (x - 0.31, 0.56 + DH, z + 0.2), M["trim"]),
        L.box(f"set:chair-armpost.{k}.r", (x + 0.31, 0.4 + DH, z + 0.1), (x + 0.35, 0.56 + DH, z + 0.2), M["trim"]),
    ]
    for o in parts:
        if yaw:
            L.rotate_y(o, yaw, (x, z))
        if "-base" not in o.name and "-column" not in o.name:
            L.bevel(o, 0.03)


for k, ch in enumerate(D["chairs"]):
    chair(k, ch)

# --- the lifted items: an invisible proxy each, and the visible fixture or card built on the proxy's quad ------------------------
consoles = {c["item"]: c for c in D["consoles"]}
for it in P["items"]:
    i = it["index"]
    if "quad" not in it:                                        # a button of the original's own UI strip: no geometry
        e = bpy.data.objects.new(f"item:{i}", None)
        bpy.context.scene.collection.objects.link(e)
        tag(e, item=i, action=it["action"], proxy=True, ui=True)
        continue
    q = [tuple(p) for p in it["quad"]]
    proxy = L.quad(f"item:{i}", q, None, EYE)
    proxy.hide_render = True
    tag(proxy, item=i, action=it["action"], proxy=True, role=it["role"], bmin=list(it["box"]["min"]), bmax=list(it["box"]["max"]))
    vq = [L.toward(p, EYE, EPS) for p in q]
    if i in consoles:                                           # a console: its top is exactly the proxy's quad
        cs = consoles[i]
        top_y = q[0][1]
        zn = q[0][2]                                            # the near edge
        zf = q[3][2]                                            # the far edge
        x0, x1 = q[0][0], q[1][0]
        # ONE raised body, an L in plan: the lifted top is its long arm, and a wing of the same height and thickness runs toward the
        # viewer at the outer end (the leg's side). The two forward consoles mirror each other across the bridge.
        cx = x0 + 0.3 if cs["pedestal"] == "left" else x1 - 0.45
        wl = D["wing"]["len"]
        wa, wb = max(x0, cx - D["wing"]["half"]), min(x1, cx + D["wing"]["half"])
        zw = zn + wl
        thick = D["wing"]["thick"]
        if cs["pedestal"] == "left":
            plan = [(x0, zf), (x1, zf), (x1, zn), (wb, zn), (wb, zw), (x0, zw)]
        else:
            plan = [(x0, zf), (x1, zf), (x1, zw), (wa, zw), (wa, zn), (x0, zn)]
        # (the lifted rectangle's skin carries the item's ID colour, so the ID pass measures the top where the button is; the L body is plain set, its wing top 12 mm lower)
        item_tag(uv(L.slab(f"fix:{i}", q, 0.012, M["gold"]), 1.5), it, fixture="console-top")
        uv(L.prism(f"set:console-body.{i}", plan, top_y - thick, top_y - 0.012, M["gold"]), 1.5)
        # the tilted fronts: LCARS plates on faces that lean back under the top, along the long arm's front and on the wing's tip
        ins = 0.12
        fa, fb = (wb, x1) if cs["pedestal"] == "left" else (x0, wa)
        uv(L.quad(f"set:console-front.{i}", [(fa + ins, top_y - 0.36, zn - 0.24), (fb - ins, top_y - 0.36, zn - 0.24), (fb, top_y - thick, zn - 0.02), (fa, top_y - thick, zn - 0.02)], M["lcars"], EYE), 0.55)
        uv(L.quad(f"set:console-tip.{i}", [(wa + 0.04, top_y - 0.36, zw - 0.2), (wb - 0.04, top_y - 0.36, zw - 0.2), (wb, top_y - thick, zw - 0.02), (wa, top_y - thick, zw - 0.02)], M["lcars"], EYE), 0.55)
        # the raised, tilted display behind the far edge, in console glass
        uv(L.quad(f"set:console-glass.{i}", [(q[3][0] + 0.1, top_y, zf), (q[2][0] - 0.1, top_y, zf), (q[2][0] - 0.1, top_y + 0.13, zf - 0.1), (q[3][0] + 0.1, top_y + 0.13, zf - 0.1)], M["glass"], EYE), 1.2)
        # the lit, angled leg under the wing's end (the body overhangs it); then one base plate under the whole console
        x00, x11, zf2 = cs["plate"]
        px0, px1 = cx - 0.27, cx + 0.27
        zp = zn + D["wing"]["ped"]
        curve = [(zp + 0.02, top_y - thick), (zp + 0.04, 0.72), (zp + 0.1, 0.46), (zp + 0.22, 0.26), (zp + 0.4, DH + 0.04)]
        prof = [(zp - 0.6, top_y - thick)] + curve + [(zp - 0.6, DH + 0.04)]
        uv(L.extrude_x(f"set:console-pedestal.{i}", prof, px0, px1, M["gold"]), 1.2)
        for k in range(len(curve) - 1):
            a_, b2 = curve[k], curve[k + 1]
            pts = [(px0 + 0.06, a_[1], a_[0]), (px1 - 0.06, a_[1], a_[0]), (px1 - 0.06, b2[1], b2[0]), (px0 + 0.06, b2[1], b2[0])]
            L.quad(f"set:console-light.{i}.{k}", [L.toward(p, EYE, 0.012) for p in pts], M["cyan"], EYE)
        uv(L.bevel(L.box(f"set:console-plate.{i}", (x00, 0, zf2 - 0.1), (x11, 0.05, zp + 0.45), M["trim"]), 0.02), 1.0)
    elif i in D["doors"]:
        item_tag(uv(L.quad(f"fix:{i}", vq, M["door"], EYE), 1.6), it, fixture="door")
        lo_ = min(p[1] for p in q)
        if lo_ > 0.05:                                          # a door whose rectangle starts above the floor gets a kick panel
            uv(L.quad(f"set:doorlow.{i}", [(q[0][0], 0, q[0][2] + 0.01), (q[1][0], 0, q[1][2] + 0.01), (q[1][0], lo_, q[1][2] + 0.01), (q[0][0], lo_, q[0][2] + 0.01)], M["trim"], EYE), 1.0)
        # a frame round the door
        xa, xb = min(p[0] for p in q), max(p[0] for p in q)
        yb = max(p[1] for p in q)
        z = q[0][2]
        for k, (a0, a1, b0, b1) in enumerate(((xa - 0.1, xa, 0, yb + 0.1), (xb, xb + 0.1, 0, yb + 0.1), (xa - 0.1, xb + 0.1, yb, yb + 0.1))):
            uv(L.box(f"set:doorframe.{i}.{k}", (a0, b0, z - 0.03), (a1, b1, z + 0.01), M["trim"]), 1.0)
    elif i in D["panels"]:
        item_tag(uv(L.quad(f"fix:{i}", vq, M["gold"], EYE), 1.6), it, fixture="station-panel")
        lo_ = min(p[1] for p in q)
        uv(L.quad(f"set:panel-low.{i}", [(q[0][0], 0, q[0][2] + 0.01), (q[1][0], 0, q[1][2] + 0.01), (q[1][0], lo_, q[1][2] + 0.01), (q[0][0], lo_, q[0][2] + 0.01)], M["trim"], EYE), 1.0)
    elif it["role"] == "crew":
        # the hotspot's own silhouette, for the ID pass only: the visible card is the engine's (card:<object> below) and this is
        # deleted before the export
        item_tag(L.quad(f"idcard:{i}", vq, M["card"], EYE), it, card=it["object"])
    else:
        raise RuntimeError(f"item {i} ({it['action']}) has no visible fixture in design: add it to doors, panels or consoles")

# --- the crew's cards: an anchor at each sprite's feet; the engine stands the original's frame there, in its own pixels (Task 6) ----
for c in P["crew"]:
    e = bpy.data.objects.new(f"card:{c['object']}", None)
    e.location = L.b(tuple(c["foot"]))
    bpy.context.scene.collection.objects.link(e)
    tag(e, object=c["object"], depth=c["depth"], item=c["index"], file=c["file"])

# --- lights (R6): a key over the command area, warm fills from the ceiling ring, the viewscreen's cool spill -----------------------
for lt in D["lights"]:
    col = int(lt["colour"], 16) if isinstance(lt["colour"], str) else lt["colour"]
    L.light(f"light:{lt['name']}", lt.get("kind", "POINT"), tuple(lt["at"]), lt["watts"], col, target=lt.get("target"), spot_deg=lt.get("spot", 70.0))

# --- cameras ----------------------------------------------------------------------------------------------------------------
main = L.make_camera("camera:main", CAM)
tag(main, projection="perspective", shiftY=CAM.get("shiftY", 0.0), fovY=CAM["fovY"], width=640, height=480)
vs = D["viewscreen"]
sa, sb = poly[bank_seg], poly[bank_seg + 1]
target = ((sa[0] + sb[0]) / 2, (y0 + y1) / 2, (sa[1] + sb[1]) / 2)
vcam = L.look_camera("camera:viewscreen", (target[0], target[1], target[2] + vs["back"]), target, 2 * math.atan((abs(sb[0] - sa[0]) * 0.75 / 2) / vs["back"]))
tag(vcam, projection="perspective", placeholder=True)

# --- renders and export -----------------------------------------------------------------------------------------------------
base = args.out[:-4] if args.out.endswith(".glb") else args.out
idpass.render_id(scene, main, base + ".id.png", colours, 0x282828)
for o in [o for o in bpy.data.objects if o.name.startswith("idcard:")]:
    bpy.data.objects.remove(o, do_unlink=True)
idpass.render_solid(scene, main, base + ".solid.png")
# the forward consoles alone, from above and from the front, so their plan shape can be read (the L)
_cons = {str(i) for i in consoles}
_keep = lambda n: n.split(".")[0].split(":")[-1] in ("console-body", "console-front", "console-tip", "console-glass", "console-pedestal", "console-light", "console-plate") and n.split(".")[1] in _cons if n.startswith("set:console") else (n.startswith("fix:") and n[4:] in _cons)
_xs = [p[0] for i in consoles for p in P["items"][i]["quad"]]
_zs = [p[2] for i in consoles for p in P["items"][i]["quad"]]
_mid = ((min(_xs) + max(_xs)) / 2, 0.6, (min(_zs) + max(_zs)) / 2 + 0.3)
idpass.render_ortho(scene, base + ".consoles-top.png", _keep, "top", _mid, max(_xs) - min(_xs) + 1.6)
idpass.render_ortho(scene, base + ".consoles-front.png", _keep, "front", _mid, max(_xs) - min(_xs) + 1.6)
# one mesh per material for the set's own parts (fewer draw calls in the browser); the items, cards and viewscreen stay by name
L.merge_by_material(lambda o: not o.name.startswith("set:"))
bpy.ops.export_scene.gltf(
    filepath=args.out, export_format="GLB", export_extras=True, export_cameras=True, export_lights=True, export_yup=True,
    export_apply=True, export_import_convert_lighting_mode="COMPAT", export_image_format="WEBP", export_image_quality=88, export_texcoords=True, export_normals=True,
)
idpass.render_look(scene, main, base + ".look.png")
